#!/usr/bin/env node
import express from 'express';
import trash from 'trash';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PHOTO_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff'
]);
const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.dng', '.raf'
]);
const SKIP_DIR_NAMES = new Set([
  '.trashes', '.spotlight-v100', '.fseventsd', '.thumbnails', 'system volume information'
]);

const THUMB_DIR = path.join(os.tmpdir(), 'sdpv-thumbs');
await fs.mkdir(THUMB_DIR, { recursive: true });
const THUMB_SIZE = 320;

// The last directory the user loaded. All file access is restricted to
// live inside this directory, to keep the /api/image and /api/trash
// endpoints from being used to reach arbitrary paths on disk.
let currentRoot = null;

function isInsideRoot(candidate) {
  if (!currentRoot) return false;
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(currentRoot);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

function thumbCachePathFor(resolved, mtimeMs) {
  const key = crypto
    .createHash('sha1')
    .update(`${resolved}:${mtimeMs}:${THUMB_SIZE}`)
    .digest('hex');
  return path.join(THUMB_DIR, `${key}.jpg`);
}

async function removeThumbCache(resolved, mtimeMs) {
  try {
    await fs.rm(thumbCachePathFor(resolved, mtimeMs), { force: true });
  } catch {
    // best-effort cleanup, ignore
  }
}

// Cameras write a matching .THM sidecar (a small JPEG thumbnail) next to
// many photo/video files. Find it so it can be trashed along with the photo,
// instead of being left behind as an orphan.
async function findCompanionThumb(resolved) {
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved)).toLowerCase();
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const match = entries.find(
    (name) => name.toLowerCase() === `${base}.thm`
  );
  return match ? path.join(dir, match) : null;
}

async function cleanupThumbCache() {
  try {
    await fs.rm(THUMB_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup, ignore
  }
}

async function shutdown() {
  await cleanupThumbCache();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function walk(dir, results) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name.toLowerCase())) continue;
      await walk(full, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (PHOTO_EXTENSIONS.has(ext) || RAW_EXTENSIONS.has(ext)) {
        const stat = await fs.stat(full);
        results.push({
          path: full,
          name: entry.name,
          ext,
          previewable: PHOTO_EXTENSIONS.has(ext),
          size: stat.size,
          mtime: stat.mtimeMs
        });
      }
    }
  }
}

// Suggest currently mounted volumes (where SD cards show up on macOS).
app.get('/api/volumes', async (_req, res) => {
  const volumesDir = '/Volumes';
  try {
    const entries = await fs.readdir(volumesDir, { withFileTypes: true });
    const volumes = entries
      .filter((e) => e.isDirectory() && e.name !== 'Macintosh HD')
      .map((e) => path.join(volumesDir, e.name));
    res.json({ volumes });
  } catch {
    res.json({ volumes: [] });
  }
});

app.get('/api/photos', async (req, res) => {
  const dir = req.query.dir;
  if (!dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'Missing dir query param' });
  }
  const resolved = path.resolve(dir);
  if (!fssync.existsSync(resolved) || !fssync.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: 'Not a valid directory' });
  }
  currentRoot = resolved;
  const results = [];
  await walk(resolved, results);
  results.sort((a, b) => a.mtime - b.mtime);
  res.json({ root: resolved, photos: results });
});

app.get('/api/image', (req, res) => {
  const p = req.query.path;
  if (!p || typeof p !== 'string' || !isInsideRoot(p)) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(path.resolve(p));
});

app.get('/api/thumbnail', async (req, res) => {
  const p = req.query.path;
  if (!p || typeof p !== 'string' || !isInsideRoot(p)) {
    return res.status(403).send('Forbidden');
  }
  const resolved = path.resolve(p);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return res.status(404).send('Not found');
  }

  const cachePath = thumbCachePathFor(resolved, stat.mtimeMs);

  if (fssync.existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  try {
    await sharp(resolved)
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
      .jpeg({ quality: 72 })
      .toFile(cachePath);
    res.sendFile(cachePath);
  } catch (err) {
    // Formats sharp can't decode (some RAW/HEIC variants) fall back to the original.
    res.sendFile(resolved);
  }
});

app.post('/api/trash', async (req, res) => {
  const { paths } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths must be a non-empty array' });
  }
  const invalid = paths.filter((p) => typeof p !== 'string' || !isInsideRoot(p));
  if (invalid.length > 0) {
    return res.status(403).json({ error: 'One or more paths are outside the loaded folder', invalid });
  }

  const resolvedPaths = paths.map((p) => path.resolve(p));

  // Capture mtimes up front (needed to find each file's cache entry) and
  // look up each file's companion .THM sidecar before anything is trashed.
  const mtimes = new Map();
  for (const resolved of resolvedPaths) {
    try {
      const stat = await fs.stat(resolved);
      mtimes.set(resolved, stat.mtimeMs);
    } catch {
      // already gone; nothing to look up
    }
  }

  const toTrash = [...resolvedPaths];
  for (const resolved of resolvedPaths) {
    const thm = await findCompanionThumb(resolved);
    if (thm && isInsideRoot(thm) && !toTrash.includes(thm)) {
      toTrash.push(thm);
    }
  }

  try {
    await trash(toTrash);
    for (const [resolved, mtimeMs] of mtimes) {
      await removeThumbCache(resolved, mtimeMs);
    }
    res.json({ ok: true, trashed: toTrash });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/rename', async (req, res) => {
  const { path: p, newName } = req.body || {};
  if (!p || typeof p !== 'string' || !isInsideRoot(p)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!newName || typeof newName !== 'string') {
    return res.status(400).json({ error: 'newName is required' });
  }

  const resolved = path.resolve(p);
  const dir = path.dirname(resolved);
  const ext = path.extname(resolved);

  // The extension is always preserved from the original file (renaming
  // shouldn't be able to change a photo's file type), so only the base
  // name portion of newName is used, with any path separators stripped.
  const baseOnly = path.basename(newName.trim());
  const providedExt = path.extname(baseOnly);
  const newBase = providedExt.toLowerCase() === ext.toLowerCase() && providedExt !== ''
    ? baseOnly.slice(0, -providedExt.length)
    : baseOnly;

  // Reject characters that are illegal on FAT32/exFAT, the filesystems
  // SD cards are normally formatted with.
  if (!newBase || /[<>:"/\\|?*\x00-\x1f]/.test(newBase)) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  const finalName = `${newBase}${ext}`;
  const targetPath = path.join(dir, finalName);
  if (!isInsideRoot(targetPath)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (targetPath === resolved) {
    return res.json({ ok: true, path: resolved, name: path.basename(resolved) });
  }
  if (fssync.existsSync(targetPath)) {
    return res.status(409).json({ error: 'A file with that name already exists' });
  }

  try {
    const stat = await fs.stat(resolved);
    const thm = await findCompanionThumb(resolved);
    await fs.rename(resolved, targetPath);
    await removeThumbCache(resolved, stat.mtimeMs);
    if (thm) {
      const thmTarget = path.join(dir, `${newBase}${path.extname(thm)}`);
      if (!fssync.existsSync(thmTarget)) {
        await fs.rename(thm, thmTarget);
      }
    }
    res.json({ ok: true, path: targetPath, name: finalName });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/save-edit', express.raw({ type: 'image/jpeg', limit: '50mb' }), async (req, res) => {
  const p = req.query.path;
  const mode = req.query.mode;
  if (!p || typeof p !== 'string' || !isInsideRoot(p)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (mode !== 'copy' && mode !== 'overwrite') {
    return res.status(400).json({ error: 'mode must be "copy" or "overwrite"' });
  }
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ error: 'Empty image data' });
  }

  const resolved = path.resolve(p);
  let targetPath = resolved;
  if (mode === 'copy') {
    const dir = path.dirname(resolved);
    const ext = path.extname(resolved);
    const base = path.basename(resolved, ext);
    targetPath = path.join(dir, `${base}_edited${ext}`);
    let n = 1;
    while (fssync.existsSync(targetPath)) {
      targetPath = path.join(dir, `${base}_edited${n}${ext}`);
      n++;
    }
  }

  try {
    await fs.writeFile(targetPath, buffer);
    res.json({ ok: true, path: targetPath, mode });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = 4173;
app.listen(PORT, () => {
  console.log(`SD Photo Viewer running at http://localhost:${PORT}`);
});
