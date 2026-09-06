const dirInput = document.getElementById('dirInput');
const loadBtn = document.getElementById('loadBtn');
const volumeSuggestions = document.getElementById('volumeSuggestions');
const toolbar = document.getElementById('toolbar');
const countLabel = document.getElementById('countLabel');
const selectAllBtn = document.getElementById('selectAllBtn');
const clearSelBtn = document.getElementById('clearSelBtn');
const compareBtn = document.getElementById('compareBtn');
const deleteSelBtn = document.getElementById('deleteSelBtn');
const gridView = document.getElementById('gridView');
const compareView = document.getElementById('compareView');
const compareRow = document.getElementById('compareRow');
const compareHeader = document.getElementById('compareHeader');
const backToGridBtn = document.getElementById('backToGridBtn');
const toast = document.getElementById('toast');

const editOverlay = document.getElementById('editOverlay');
const editFilename = document.getElementById('editFilename');
const editCloseBtn = document.getElementById('editCloseBtn');
const rotateLeftBtn = document.getElementById('rotateLeftBtn');
const rotateRightBtn = document.getElementById('rotateRightBtn');
const cropToggleBtn = document.getElementById('cropToggleBtn');
const cropRatioSelect = document.getElementById('cropRatioSelect');
const customRatioInputs = document.getElementById('customRatioInputs');
const customRatioW = document.getElementById('customRatioW');
const customRatioH = document.getElementById('customRatioH');
const cropApplyBtn = document.getElementById('cropApplyBtn');
const brightnessSlider = document.getElementById('brightnessSlider');
const contrastSlider = document.getElementById('contrastSlider');
const resetEditBtn = document.getElementById('resetEditBtn');
const editCanvas = document.getElementById('editCanvas');
const cropBox = document.getElementById('cropBox');
const saveCopyBtn = document.getElementById('saveCopyBtn');
const saveOverwriteBtn = document.getElementById('saveOverwriteBtn');

let photos = [];
const selected = new Set();

let currentDir = '';
let editingPhoto = null;
let originalImg = null;
let workingCanvas = null;
let brightness = 100;
let contrast = 100;
let cropMode = false;
let cropDragging = false;
let cropStart = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2500);
}

async function loadVolumes() {
  const res = await fetch('/api/volumes');
  const data = await res.json();
  volumeSuggestions.innerHTML = '';
  for (const v of data.volumes) {
    const btn = document.createElement('button');
    btn.textContent = v;
    btn.addEventListener('click', () => {
      dirInput.value = v;
      loadPhotos();
    });
    volumeSuggestions.appendChild(btn);
  }
}

async function loadPhotos() {
  const dir = dirInput.value.trim();
  if (!dir) return;
  currentDir = dir;
  loadBtn.disabled = true;
  loadBtn.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/photos?dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to load folder');
      return;
    }
    photos = data.photos;
    selected.clear();
    renderGrid();
    toolbar.classList.remove('hidden');
    showCompare(false);
  } catch (err) {
    showToast('Error contacting server: ' + err);
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = 'Load';
  }
}

function updateToolbar() {
  countLabel.textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'} — ${selected.size} selected`;
  compareBtn.disabled = selected.size < 2;
  deleteSelBtn.disabled = selected.size === 0;
}

function renderGrid() {
  gridView.innerHTML = '';
  for (const photo of photos) {
    gridView.appendChild(makeTile(photo));
  }
  updateToolbar();
}

function makeTile(photo) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.path = photo.path;
  if (selected.has(photo.path)) tile.classList.add('selected');

  if (photo.previewable) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = `/api/thumbnail?path=${encodeURIComponent(photo.path)}`;
    img.alt = photo.name;
    tile.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = photo.name;
    tile.appendChild(ph);
  }

  const check = document.createElement('div');
  check.className = 'checkmark';
  tile.appendChild(check);

  const name = document.createElement('div');
  name.className = 'filename';
  name.textContent = photo.name;
  tile.appendChild(name);

  const del = document.createElement('button');
  del.className = 'tile-delete';
  del.textContent = '✕';
  del.title = 'Move to Trash';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deletePhotos([photo.path]);
  });
  tile.appendChild(del);

  if (photo.previewable) {
    const edit = document.createElement('button');
    edit.className = 'tile-edit';
    edit.textContent = '✎';
    edit.title = 'Edit';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(photo);
    });
    tile.appendChild(edit);
  }

  const rename = document.createElement('button');
  rename.className = 'tile-rename';
  rename.textContent = 'Aa';
  rename.title = 'Rename';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    renamePhoto(photo);
  });
  tile.appendChild(rename);

  tile.addEventListener('click', () => toggleSelect(photo.path, tile));

  return tile;
}

function toggleSelect(p, tileEl) {
  if (selected.has(p)) {
    selected.delete(p);
    tileEl.classList.remove('selected');
  } else {
    selected.add(p);
    tileEl.classList.add('selected');
  }
  updateToolbar();
}

async function deletePhotos(paths) {
  if (paths.length === 0) return;
  const label = paths.length === 1 ? paths[0].split('/').pop() : `${paths.length} photos`;
  if (!confirm(`Move ${label} to Trash?`)) return;

  try {
    const res = await fetch('/api/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Delete failed');
      return;
    }
    const removed = new Set(paths);
    photos = photos.filter((p) => !removed.has(p.path));
    for (const p of paths) selected.delete(p);
    renderGrid();
    renderCompare();
    showToast(`Moved ${label} to Trash`);
  } catch (err) {
    showToast('Error contacting server: ' + err);
  }
}

async function renamePhoto(photo) {
  const dot = photo.name.lastIndexOf('.');
  const baseName = dot > 0 ? photo.name.slice(0, dot) : photo.name;
  const input = prompt('Rename photo (extension is kept automatically):', baseName);
  if (input === null) return;
  const newBase = input.trim();
  if (!newBase || newBase === baseName) return;

  try {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: photo.path, newName: newBase })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Rename failed');
      return;
    }
    const oldPath = photo.path;
    photo.path = data.path;
    photo.name = data.name;
    if (selected.has(oldPath)) {
      selected.delete(oldPath);
      selected.add(data.path);
    }
    renderGrid();
    renderCompare();
    showToast(`Renamed to ${data.name}`);
  } catch (err) {
    showToast('Error contacting server: ' + err);
  }
}

function showCompare(show) {
  compareView.classList.toggle('hidden', !show);
  gridView.classList.toggle('hidden', show);
  toolbar.classList.toggle('hidden', show);
  compareHeader.classList.toggle('hidden', !show);
}

function renderCompare() {
  compareRow.innerHTML = '';
  const items = photos.filter((p) => selected.has(p.path));
  if (items.length === 0) {
    showCompare(false);
    return;
  }
  for (const photo of items) {
    const item = document.createElement('div');
    item.className = 'compare-item';

    const media = document.createElement('div');
    media.className = 'media';
    if (photo.previewable) {
      const img = document.createElement('img');
      img.src = `/api/image?path=${encodeURIComponent(photo.path)}`;
      img.alt = photo.name;
      media.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.style.padding = '40px';
      ph.textContent = `${photo.name} (no preview available)`;
      media.appendChild(ph);
    }
    item.appendChild(media);

    const footer = document.createElement('div');
    footer.className = 'compare-footer';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = photo.name;
    footer.appendChild(name);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'footer-buttons';

    if (photo.previewable) {
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openEditor(photo));
      buttonGroup.appendChild(edit);
    }

    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => renamePhoto(photo));
    buttonGroup.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Trash';
    del.addEventListener('click', () => deletePhotos([photo.path]));
    buttonGroup.appendChild(del);

    footer.appendChild(buttonGroup);
    item.appendChild(footer);
    compareRow.appendChild(item);
  }
}

loadBtn.addEventListener('click', loadPhotos);
dirInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadPhotos();
});

selectAllBtn.addEventListener('click', () => {
  for (const p of photos) selected.add(p.path);
  renderGrid();
});

clearSelBtn.addEventListener('click', () => {
  selected.clear();
  renderGrid();
});

compareBtn.addEventListener('click', () => {
  renderCompare();
  showCompare(true);
});

deleteSelBtn.addEventListener('click', () => {
  deletePhotos([...selected]);
});

backToGridBtn.addEventListener('click', () => showCompare(false));

// --- Editor ---

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function updateOriginalRatioOption() {
  const w = workingCanvas.width;
  const h = workingCanvas.height;
  const d = gcd(w, h) || 1;
  const originalRatioOption = cropRatioSelect.querySelector('option[value="original"]');
  originalRatioOption.textContent = `Original Ratio (${w / d}:${h / d})`;
}

function redrawVisibleCanvas() {
  editCanvas.width = workingCanvas.width;
  editCanvas.height = workingCanvas.height;
  editCanvas.getContext('2d').drawImage(workingCanvas, 0, 0);
  editCanvas.style.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  updateOriginalRatioOption();
}

function setCropMode(on) {
  cropMode = on;
  cropToggleBtn.classList.toggle('active', on);
  if (!on) {
    cropBox.classList.add('hidden');
    cropApplyBtn.disabled = true;
  }
}

async function openEditor(photo) {
  editingPhoto = photo;
  editFilename.textContent = photo.name;
  brightness = 100;
  contrast = 100;
  brightnessSlider.value = 100;
  contrastSlider.value = 100;
  setCropMode(false);
  editOverlay.classList.remove('hidden');

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `/api/image?path=${encodeURIComponent(photo.path)}`;
  });
  originalImg = img;
  workingCanvas = document.createElement('canvas');
  workingCanvas.width = img.naturalWidth;
  workingCanvas.height = img.naturalHeight;
  workingCanvas.getContext('2d').drawImage(img, 0, 0);
  redrawVisibleCanvas();
}

function closeEditor() {
  editOverlay.classList.add('hidden');
  editingPhoto = null;
  originalImg = null;
  workingCanvas = null;
  setCropMode(false);
}

function rotateWorking(deg) {
  const w = workingCanvas.width;
  const h = workingCanvas.height;
  const rotated = document.createElement('canvas');
  rotated.width = h;
  rotated.height = w;
  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(workingCanvas, -w / 2, -h / 2);
  workingCanvas = rotated;
  redrawVisibleCanvas();
}

function buildExportBlob() {
  const out = document.createElement('canvas');
  out.width = workingCanvas.width;
  out.height = workingCanvas.height;
  const ctx = out.getContext('2d');
  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  ctx.drawImage(workingCanvas, 0, 0);
  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.9));
}

async function saveEdit(mode) {
  if (mode === 'overwrite' && !confirm('This will permanently replace the original file on the SD card and cannot be undone. Continue?')) {
    return;
  }
  const blob = await buildExportBlob();
  try {
    const res = await fetch(`/api/save-edit?path=${encodeURIComponent(editingPhoto.path)}&mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Save failed');
      return;
    }
    showToast(mode === 'copy' ? `Saved as ${data.path.split('/').pop()}` : 'Original updated');
    closeEditor();
    dirInput.value = currentDir;
    await loadPhotos();
  } catch (err) {
    showToast('Error contacting server: ' + err);
  }
}

editCloseBtn.addEventListener('click', closeEditor);
rotateLeftBtn.addEventListener('click', () => rotateWorking(-90));
rotateRightBtn.addEventListener('click', () => rotateWorking(90));

brightnessSlider.addEventListener('input', () => {
  brightness = Number(brightnessSlider.value);
  editCanvas.style.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
});

contrastSlider.addEventListener('input', () => {
  contrast = Number(contrastSlider.value);
  editCanvas.style.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
});

resetEditBtn.addEventListener('click', () => {
  brightness = 100;
  contrast = 100;
  brightnessSlider.value = 100;
  contrastSlider.value = 100;
  setCropMode(false);
  workingCanvas = document.createElement('canvas');
  workingCanvas.width = originalImg.naturalWidth;
  workingCanvas.height = originalImg.naturalHeight;
  workingCanvas.getContext('2d').drawImage(originalImg, 0, 0);
  redrawVisibleCanvas();
});

cropToggleBtn.addEventListener('click', () => setCropMode(!cropMode));

editCanvas.addEventListener('mousedown', (e) => {
  if (!cropMode) return;
  const rect = editCanvas.getBoundingClientRect();
  cropStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  cropDragging = true;
  cropBox.classList.remove('hidden');
  cropBox.style.left = `${cropStart.x}px`;
  cropBox.style.top = `${cropStart.y}px`;
  cropBox.style.width = '0px';
  cropBox.style.height = '0px';
});

function getSelectedCropRatio() {
  const val = cropRatioSelect.value;
  if (val === 'free') return null;
  if (val === 'original') return workingCanvas.width / workingCanvas.height;
  if (val === 'custom') {
    const w = Number(customRatioW.value);
    const h = Number(customRatioH.value);
    if (!w || !h) return null;
    return w / h;
  }
  const [w, h] = val.split(':').map(Number);
  return w / h;
}

cropRatioSelect.addEventListener('change', () => {
  customRatioInputs.classList.toggle('hidden', cropRatioSelect.value !== 'custom');
});

editCanvas.addEventListener('mousemove', (e) => {
  if (!cropMode || !cropDragging) return;
  const rect = editCanvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
  const dx = x - cropStart.x;
  const dy = y - cropStart.y;
  const ratio = getSelectedCropRatio();

  let left, top, width, height;
  if (ratio) {
    const dirX = dx >= 0 ? 1 : -1;
    const dirY = dy >= 0 ? 1 : -1;
    const boundW = Math.abs(dx);
    const boundH = Math.abs(dy);
    // Fit the largest ratio-locked rectangle inside the (boundW x boundH)
    // box the mouse has dragged out, so dragging further in either
    // direction (not just horizontally) grows the selection.
    height = Math.min(boundH, boundW / ratio);
    width = height * ratio;
    left = dirX >= 0 ? cropStart.x : cropStart.x - width;
    top = dirY >= 0 ? cropStart.y : cropStart.y - height;
  } else {
    left = Math.min(x, cropStart.x);
    top = Math.min(y, cropStart.y);
    width = Math.abs(dx);
    height = Math.abs(dy);
  }

  cropBox.style.left = `${left}px`;
  cropBox.style.top = `${top}px`;
  cropBox.style.width = `${width}px`;
  cropBox.style.height = `${height}px`;
});

window.addEventListener('mouseup', () => {
  if (!cropMode || !cropDragging) return;
  cropDragging = false;
  const width = parseFloat(cropBox.style.width);
  const height = parseFloat(cropBox.style.height);
  cropApplyBtn.disabled = !(width > 4 && height > 4);
});

cropApplyBtn.addEventListener('click', () => {
  const rect = editCanvas.getBoundingClientRect();
  const scaleX = workingCanvas.width / rect.width;
  const scaleY = workingCanvas.height / rect.height;
  const sx = parseFloat(cropBox.style.left) * scaleX;
  const sy = parseFloat(cropBox.style.top) * scaleY;
  const sw = parseFloat(cropBox.style.width) * scaleX;
  const sh = parseFloat(cropBox.style.height) * scaleY;

  const cropped = document.createElement('canvas');
  cropped.width = Math.round(sw);
  cropped.height = Math.round(sh);
  cropped.getContext('2d').drawImage(workingCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  workingCanvas = cropped;
  redrawVisibleCanvas();
  setCropMode(false);
});

saveCopyBtn.addEventListener('click', () => saveEdit('copy'));
saveOverwriteBtn.addEventListener('click', () => saveEdit('overwrite'));

loadVolumes();
