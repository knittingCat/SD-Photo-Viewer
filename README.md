# SD Photo Viewer

A local web app for browsing, culling, and lightly editing photos straight off an SD card (or any folder) — no upload, no cloud, everything stays on your machine.

## Features

- **Browse** — point it at a mounted SD card (auto-suggested from `/Volumes`) or any folder; it recursively finds photos and RAW files, sorted by date taken.
- **Thumbnails** — fast grid view with cached, generated thumbnails.
- **Compare** — select multiple photos and view them side by side to pick the keeper.
- **Trash** — move unwanted photos to the system Trash (not permanently deleted), including their camera-generated `.THM` sidecar files.
- **Edit** — rotate, crop (free, original, or fixed ratios like 1:1 / 4:3 / 3:2 / 16:9, or custom), and adjust brightness/contrast.
- **Save** — save edits as a new copy (original untouched) or overwrite the original.

## Supported formats

- Photos: `.jpg .jpeg .png .gif .webp .heic .heif .bmp .tif .tiff`
- RAW (browsable, not previewable): `.cr2 .cr3 .nef .arw .orf .rw2 .dng .raf`

## Requirements

- [Node.js](https://nodejs.org/) 18+

## Install

### With tlib

```bash
tlib install knittingCat/SD-Photo-Viewer
```

This installs both `sd-photo-viewer` and `sd-photo-viewer-stop` as commands. See [BlueGrayFoo/TLIB](https://github.com/BlueGrayFoo/TLIB) for `tlib` itself.

### Without tlib

```bash
git clone git@github.com:knittingCat/SD-Photo-Viewer.git
cd SD-Photo-Viewer
npm install
```

## Run

With tlib:

```bash
sd-photo-viewer
```

Without tlib, from inside the cloned repo (not your home directory — it needs the `package.json` here):

```bash
npm start
```

Either way, then open [http://localhost:4173](http://localhost:4173) and load a folder (e.g. your SD card's mount point, or paste its path directly).

## Stop

With tlib:

```bash
sd-photo-viewer-stop
```

Without tlib, from inside the cloned repo:

```bash
npm stop
```

Or just `Ctrl+C` in the terminal it's running in.

## Safety

All file access (viewing, thumbnailing, trashing, saving) is restricted to the folder you loaded — the server won't read or write outside it.
