# Image Convert

Image Convert is a small static web tool for converting multiple images in the browser. It is designed for GitHub Pages hosting and does not upload files to a server.

## Features

- Multiple image upload with drag and drop.
- Queue-based conversion.
- Output format selector for JPEG, PNG, and WebP.
- Compression presets for low, medium, high, and ultra high compression.
- Download all converted images as one ZIP archive.
- Thumbnail preview with previous and next image navigation.
- Input validation for PNG, JPG, JPEG, TIF, and TIFF files.
- 10 MB per-file limit.
- Basic protection against compression bombs with decode timeout and decoded pixel limits.

## GitHub Pages

Enable GitHub Pages for the repository and serve from the repository root. The app entry point is `index.html`.

## TIFF Support

TIFF files are accepted, but browser support varies. Files convert only when the user's browser can decode TIFF images natively. Adding a TIFF decoder would require a production dependency.
