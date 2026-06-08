"use strict";

/**
 * @typedef {"queued" | "ready" | "working" | "done" | "error"} QueueStatus
 */

/**
 * @typedef {object} QueueItem
 * @property {string} id Stable queue item identifier.
 * @property {File} file Original uploaded file.
 * @property {QueueStatus} status Current processing status.
 * @property {number | null} width Decoded image width.
 * @property {number | null} height Decoded image height.
 * @property {string | null} previewUrl Object URL for preview rendering.
 * @property {Blob | null} outputBlob Converted output blob.
 * @property {string | null} downloadUrl Object URL for converted output.
 * @property {string | null} outputName Converted file name.
 * @property {number | null} outputSize Converted file size in bytes.
 * @property {string} message User-facing status detail.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_CANVAS_SIDE = 16_384;
const DECODE_TIMEOUT_MS = 12_000;
const ACCEPTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "tif", "tiff"]);
const ACCEPTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/tiff", "image/tif"]);
const QUALITY_PRESETS = {
  low: 0.92,
  medium: 0.82,
  high: 0.68,
  ultra: 0.5,
};
const OUTPUT_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;

/** @type {QueueItem[]} */
const queue = [];
let activePreviewId = null;

const dropZone = document.querySelector("#drop-zone");
const fileInput = document.querySelector("#file-input");
const queueList = document.querySelector("#queue-list");
const formatSelect = document.querySelector("#format");
const convertAllButton = document.querySelector("#convert-all");
const downloadAllButton = document.querySelector("#download-all");
const clearQueueButton = document.querySelector("#clear-queue");
const previewDialog = document.querySelector("#preview-dialog");
const previewImage = document.querySelector("#preview-image");
const previewTitle = document.querySelector("#preview-title");
const previewMeta = document.querySelector("#preview-meta");
const previewCloseButton = document.querySelector("#preview-close");
const previewPrevButton = document.querySelector("#preview-prev");
const previewNextButton = document.querySelector("#preview-next");
const template = document.querySelector("#queue-item-template");

if (
  !(dropZone instanceof HTMLElement) ||
  !(fileInput instanceof HTMLInputElement) ||
  !(queueList instanceof HTMLElement) ||
  !(formatSelect instanceof HTMLSelectElement) ||
  !(convertAllButton instanceof HTMLButtonElement) ||
  !(downloadAllButton instanceof HTMLButtonElement) ||
  !(clearQueueButton instanceof HTMLButtonElement) ||
  !(previewDialog instanceof HTMLDialogElement) ||
  !(previewImage instanceof HTMLImageElement) ||
  !(previewTitle instanceof HTMLElement) ||
  !(previewMeta instanceof HTMLElement) ||
  !(previewCloseButton instanceof HTMLButtonElement) ||
  !(previewPrevButton instanceof HTMLButtonElement) ||
  !(previewNextButton instanceof HTMLButtonElement) ||
  !(template instanceof HTMLTemplateElement)
) {
  throw new Error("Required interface elements are missing.");
}

fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  dropZone.classList.remove("is-dragging");
});

document.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) {
    return;
  }

  event.preventDefault();
  dropZone.classList.add("is-dragging");
}, true);

document.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) {
    return;
  }

  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  dropZone.classList.add("is-dragging");
}, true);

document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) {
    dropZone.classList.remove("is-dragging");
  }
}, true);

document.addEventListener("drop", (event) => {
  const files = getDroppedFiles(event);
  if (!files.length && !isFileDrag(event)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  dropZone.classList.remove("is-dragging");
  addFiles(files);
}, true);

convertAllButton.addEventListener("click", async () => {
  convertAllButton.disabled = true;
  for (const item of queue) {
    if (canConvertItem(item)) {
      await convertItem(item.id);
    }
  }
  convertAllButton.disabled = false;
});

downloadAllButton.addEventListener("click", async () => {
  await downloadAllConverted();
});

clearQueueButton.addEventListener("click", () => {
  clearQueue();
});

previewCloseButton.addEventListener("click", () => {
  closePreview();
});

previewPrevButton.addEventListener("click", () => {
  showRelativePreview(-1);
});

previewNextButton.addEventListener("click", () => {
  showRelativePreview(1);
});

previewDialog.addEventListener("click", (event) => {
  if (event.target === previewDialog) {
    closePreview();
  }
});

previewDialog.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    showRelativePreview(-1);
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    showRelativePreview(1);
  }
});

/**
 * Add selected files to the conversion queue.
 *
 * @param {FileList | File[] | null} files Uploaded or dropped files.
 * @returns {void}
 */
function addFiles(files) {
  if (!files?.length) {
    return;
  }

  for (const file of Array.from(files)) {
    const item = createQueueItem(file);
    queue.push(item);
    validateQueuedItem(item);
  }

  renderQueue();
}

/**
 * Get files from a drop event.
 *
 * @param {DragEvent} event Drag event to inspect.
 * @returns {File[]} Dropped files.
 */
function getDroppedFiles(event) {
  return Array.from(event.dataTransfer?.files ?? []);
}

/**
 * Determine whether a drag event appears to contain files.
 *
 * @param {DragEvent} event Drag event to inspect.
 * @returns {boolean} True when files are being dragged.
 */
function isFileDrag(event) {
  const files = event.dataTransfer?.files;
  if (files?.length) {
    return true;
  }

  return Array.from(event.dataTransfer?.types ?? []).some((type) => type.toLowerCase() === "files");
}

/**
 * Create the initial queue state for a file.
 *
 * @param {File} file File to track.
 * @returns {QueueItem} New queue item.
 */
function createQueueItem(file) {
  return {
    id: crypto.randomUUID(),
    file,
    status: "queued",
    width: null,
    height: null,
    previewUrl: null,
    outputBlob: null,
    downloadUrl: null,
    outputName: null,
    outputSize: null,
    message: "Waiting for conversion.",
  };
}

/**
 * Run lightweight checks before decoding an image.
 *
 * @param {QueueItem} item Queue item to validate.
 * @returns {void}
 */
function validateQueuedItem(item) {
  const extension = getExtension(item.file.name);
  const hasAcceptedExtension = ACCEPTED_EXTENSIONS.has(extension);
  const hasAcceptedMime = !item.file.type || ACCEPTED_MIME_TYPES.has(item.file.type);

  if (!hasAcceptedExtension || !hasAcceptedMime) {
    setItemStatus(item, "error", "Unsupported file type.");
    return;
  }

  if (item.file.size > MAX_FILE_BYTES) {
    setItemStatus(item, "error", "File exceeds the 10 MB limit.");
    return;
  }

  item.previewUrl = URL.createObjectURL(item.file);
  setItemStatus(item, "ready", "Ready to convert.");
}

/**
 * Convert every eligible image in the queue.
 *
 * @param {string} id Queue item id.
 * @returns {Promise<void>} Resolves when conversion finishes or fails.
 */
async function convertItem(id) {
  const item = queue.find((candidate) => candidate.id === id);
  if (!item || !canConvertItem(item)) {
    return;
  }

  /** @type {ImageBitmap | HTMLImageElement | null} */
  let decodedSource = null;
  clearDownload(item);
  setItemStatus(item, "working", "Decoding image.");
  renderQueue();

  try {
    const decoded = await decodeFile(item.file);
    decodedSource = decoded.source;
    item.width = decoded.width;
    item.height = decoded.height;
    item.previewUrl = item.previewUrl ?? URL.createObjectURL(item.file);

    assertSafeDimensions(decoded.width, decoded.height);
    setItemStatus(item, "working", "Converting image.");
    renderQueue();

    const blob = await encodeImage(decodedSource);

    item.outputBlob = blob;
    item.downloadUrl = URL.createObjectURL(blob);
    item.outputSize = blob.size;
    item.outputName = buildOutputName(item.file.name, getOutputExtension());
    setItemStatus(item, "done", "Conversion complete.");
  } catch (error) {
    setItemStatus(item, "error", getErrorMessage(error));
  } finally {
    if (decodedSource) {
      closeDecodedSource(decodedSource);
    }
  }

  renderQueue();
}

/**
 * Decode an image file with timeout protection.
 *
 * @param {File} file File to decode.
 * @returns {Promise<{source: ImageBitmap | HTMLImageElement, width: number, height: number}>} Decoded source.
 */
async function decodeFile(file) {
  const decodePromise = "createImageBitmap" in window
    ? createImageBitmap(file)
    : decodeWithImageElement(file);
  const timeoutPromise = new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error("Image decode timed out.")), DECODE_TIMEOUT_MS);
  });
  const source = /** @type {ImageBitmap | HTMLImageElement} */ (
    await Promise.race([decodePromise, timeoutPromise])
  );
  return {
    source,
    width: source.width,
    height: source.height,
  };
}

/**
 * Decode with an HTML image element when ImageBitmap is unavailable.
 *
 * @param {File} file File to decode.
 * @returns {Promise<HTMLImageElement>} Decoded image element.
 */
function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The browser could not decode this image."));
    };
    image.src = url;
  });
}

/**
 * Stop conversion for suspiciously large decoded images.
 *
 * @param {number} width Decoded image width.
 * @param {number} height Decoded image height.
 * @returns {void}
 */
function assertSafeDimensions(width, height) {
  const pixelCount = width * height;
  if (pixelCount > MAX_IMAGE_PIXELS) {
    throw new Error("Decoded image is too large to process safely.");
  }

  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error("Image dimensions exceed the browser canvas safety limit.");
  }
}

/**
 * Encode a decoded image into the selected output format.
 *
 * @param {ImageBitmap | HTMLImageElement} source Decoded image source.
 * @returns {Promise<Blob>} Encoded image blob.
 */
function encodeImage(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas rendering is unavailable.");
  }

  context.drawImage(source, 0, 0);
  const mimeType = formatSelect.value;
  const quality = mimeType === "image/png" ? undefined : getQuality();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("The browser could not encode this output format."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

/**
 * Render the queue list from the current queue state.
 *
 * @returns {void}
 */
function renderQueue() {
  queueList.replaceChildren();

  if (!queue.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No images added yet.";
    queueList.append(empty);
    updateActionStates();
    return;
  }

  for (const item of queue) {
    queueList.append(renderQueueItem(item));
  }

  updateActionStates();
}

/**
 * Render one queue row.
 *
 * @param {QueueItem} item Item to render.
 * @returns {HTMLElement} Rendered queue item.
 */
function renderQueueItem(item) {
  const fragment = template.content.cloneNode(true);
  if (!(fragment instanceof DocumentFragment)) {
    throw new Error("Unable to clone queue item template.");
  }

  const row = fragment.querySelector(".queue-item");
  const title = fragment.querySelector("h3");
  const status = fragment.querySelector(".status-pill");
  const meta = fragment.querySelector(".meta");
  const message = fragment.querySelector(".message");
  const thumbnail = fragment.querySelector(".thumb");
  const convertButton = fragment.querySelector(".convert-one");
  const downloadLink = fragment.querySelector(".download");
  const removeButton = fragment.querySelector(".remove");

  if (
    !(row instanceof HTMLElement) ||
    !(title instanceof HTMLElement) ||
    !(status instanceof HTMLElement) ||
    !(meta instanceof HTMLElement) ||
    !(message instanceof HTMLElement) ||
    !(thumbnail instanceof HTMLButtonElement) ||
    !(convertButton instanceof HTMLButtonElement) ||
    !(downloadLink instanceof HTMLAnchorElement) ||
    !(removeButton instanceof HTMLButtonElement)
  ) {
    throw new Error("Queue item template is invalid.");
  }

  row.classList.add(`status-${item.status}`);
  title.textContent = item.file.name;
  status.textContent = getStatusLabel(item.status);
  meta.append(...createMetaEntries(item));
  message.textContent = item.message;

  if (item.previewUrl) {
    const image = document.createElement("img");
    image.src = item.previewUrl;
    image.alt = "";
    thumbnail.append(image);
    thumbnail.disabled = false;
    thumbnail.addEventListener("click", () => {
      openPreview(item.id);
    });
  }

  convertButton.disabled = !canConvertItem(item);
  convertButton.addEventListener("click", () => {
    void convertItem(item.id);
  });

  if (item.downloadUrl && item.outputName) {
    downloadLink.href = item.downloadUrl;
    downloadLink.download = item.outputName;
    downloadLink.hidden = false;
  }

  removeButton.addEventListener("click", () => {
    removeItem(item.id);
  });

  return row;
}

/**
 * Build metadata elements for a queue item.
 *
 * @param {QueueItem} item Item with metadata.
 * @returns {HTMLElement[]} Metadata nodes.
 */
function createMetaEntries(item) {
  const entries = [
    ["Input", formatBytes(item.file.size)],
    ["Type", getExtension(item.file.name).toUpperCase()],
  ];

  if (item.width && item.height) {
    entries.push(["Size", `${item.width} x ${item.height}`]);
  }

  if (item.outputSize) {
    entries.push(["Output", formatBytes(item.outputSize)]);
  }

  return entries.map(([label, value]) => {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = `${label}:`;
    detail.textContent = value;
    wrapper.append(term, detail);
    return wrapper;
  });
}

/**
 * Remove a queue item and release its object URLs.
 *
 * @param {string} id Queue item id.
 * @returns {void}
 */
function removeItem(id) {
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }

  const [item] = queue.splice(index, 1);
  if (activePreviewId === item.id) {
    closePreview();
  }
  clearPreview(item);
  clearDownload(item);
  renderQueue();
}

/**
 * Clear all items from the queue and release object URLs.
 *
 * @returns {void}
 */
function clearQueue() {
  closePreview();

  for (const item of queue) {
    clearPreview(item);
    clearDownload(item);
  }

  queue.splice(0, queue.length);
  renderQueue();
}

/**
 * Update a queue item status and message.
 *
 * @param {QueueItem} item Item to update.
 * @param {QueueStatus} status Status value.
 * @param {string} message Status message.
 * @returns {void}
 */
function setItemStatus(item, status, message) {
  item.status = status;
  item.message = message;
}

/**
 * Get the selected compression quality.
 *
 * @returns {number} Canvas quality value.
 */
function getQuality() {
  const selected = document.querySelector('input[name="quality"]:checked');
  if (!(selected instanceof HTMLInputElement)) {
    return QUALITY_PRESETS.medium;
  }
  return QUALITY_PRESETS[selected.value] ?? QUALITY_PRESETS.medium;
}

/**
 * Get the currently selected output extension.
 *
 * @returns {string} Output file extension.
 */
function getOutputExtension() {
  return OUTPUT_EXTENSIONS[formatSelect.value] ?? "jpg";
}

/**
 * Build an output file name using the selected output extension.
 *
 * @param {string} inputName Original file name.
 * @param {string} extension Output extension.
 * @returns {string} Output file name.
 */
function buildOutputName(inputName, extension) {
  const baseName = inputName.replace(/\.[^.]+$/, "") || "converted-image";
  return `${baseName}.${extension}`;
}

/**
 * Get a lowercase file extension.
 *
 * @param {string} name File name.
 * @returns {string} Lowercase extension without dot.
 */
function getExtension(name) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Format bytes as a short display string.
 *
 * @param {number} bytes Byte count.
 * @returns {string} Human-readable size.
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/**
 * Convert status codes to display labels.
 *
 * @param {QueueStatus} status Status code.
 * @returns {string} Display label.
 */
function getStatusLabel(status) {
  return {
    queued: "Queued",
    ready: "Ready",
    working: "Working",
    done: "Done",
    error: "Error",
  }[status];
}

/**
 * Convert unknown errors into readable messages.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} User-facing error.
 */
function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return "Conversion failed.";
}

/**
 * Release an image preview URL.
 *
 * @param {QueueItem} item Queue item with a preview URL.
 * @returns {void}
 */
function clearPreview(item) {
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = null;
  }
}

/**
 * Release a converted output URL.
 *
 * @param {QueueItem} item Queue item with a download URL.
 * @returns {void}
 */
function clearDownload(item) {
  if (item.downloadUrl) {
    URL.revokeObjectURL(item.downloadUrl);
    item.downloadUrl = null;
  }

  if (item.outputBlob) {
    item.outputBlob = null;
    item.outputName = null;
    item.outputSize = null;
  }
}

/**
 * Close a decoded bitmap when the browser exposes a close method.
 *
 * @param {ImageBitmap | HTMLImageElement} source Decoded source.
 * @returns {void}
 */
function closeDecodedSource(source) {
  if ("close" in source && typeof source.close === "function") {
    source.close();
  }
}

/**
 * Refresh bulk action availability.
 *
 * @returns {void}
 */
function updateActionStates() {
  const hasConvertibleItems = queue.some((item) => canConvertItem(item));
  const hasDownloadableItems = queue.some((item) => item.outputBlob && item.outputName);
  convertAllButton.disabled = !hasConvertibleItems;
  downloadAllButton.disabled = !hasDownloadableItems;
  clearQueueButton.disabled = queue.length === 0;
}

/**
 * Decide whether a queue item can be converted now.
 *
 * @param {QueueItem} item Queue item to inspect.
 * @returns {boolean} True when the item is eligible for conversion.
 */
function canConvertItem(item) {
  return item.status === "queued" || item.status === "ready" || item.status === "done";
}

/**
 * Download all converted queue outputs as one ZIP file.
 *
 * @returns {Promise<void>} Resolves after the ZIP download is started.
 */
async function downloadAllConverted() {
  const files = queue
    .filter((item) => item.outputBlob && item.outputName)
    .map((item) => ({
      name: item.outputName ?? "converted-image",
      blob: /** @type {Blob} */ (item.outputBlob),
    }));

  if (!files.length) {
    return;
  }

  downloadAllButton.disabled = true;
  try {
    const zipBlob = await createZipBlob(files);
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "converted-images.zip";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      updateActionStates();
    }, 0);
  } finally {
    updateActionStates();
  }
}

/**
 * Create a ZIP blob with stored files and no compression.
 *
 * @param {{name: string, blob: Blob}[]} files Files to include.
 * @returns {Promise<Blob>} ZIP archive blob.
 */
async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralDirectory = [];
  const usedNames = new Map();
  let offset = 0;

  for (const file of files) {
    const safeName = getUniqueZipName(sanitizeZipName(file.name), usedNames);
    const nameBytes = encoder.encode(safeName);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const checksum = crc32(data);
    const localHeader = createZipLocalHeader(nameBytes, data.byteLength, checksum);

    chunks.push(localHeader, data);
    centralDirectory.push(createZipCentralDirectoryHeader(nameBytes, data.byteLength, checksum, offset));
    offset += localHeader.byteLength + data.byteLength;
  }

  const centralDirectorySize = centralDirectory.reduce((size, header) => size + header.byteLength, 0);
  const endHeader = createZipEndHeader(files.length, centralDirectorySize, offset);
  return new Blob([...chunks, ...centralDirectory, endHeader], { type: "application/zip" });
}

/**
 * Create a local file header for a ZIP entry.
 *
 * @param {Uint8Array} nameBytes UTF-8 encoded file name.
 * @param {number} size File size in bytes.
 * @param {number} checksum CRC32 checksum.
 * @returns {Uint8Array} ZIP local file header.
 */
function createZipLocalHeader(nameBytes, size, checksum) {
  const header = new Uint8Array(30 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

/**
 * Create a central directory header for a ZIP entry.
 *
 * @param {Uint8Array} nameBytes UTF-8 encoded file name.
 * @param {number} size File size in bytes.
 * @param {number} checksum CRC32 checksum.
 * @param {number} offset Local file header offset.
 * @returns {Uint8Array} ZIP central directory header.
 */
function createZipCentralDirectoryHeader(nameBytes, size, checksum, offset) {
  const header = new Uint8Array(46 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, offset, true);
  header.set(nameBytes, 46);
  return header;
}

/**
 * Create the end of central directory header for a ZIP archive.
 *
 * @param {number} fileCount Number of files in the archive.
 * @param {number} directorySize Central directory size in bytes.
 * @param {number} directoryOffset Central directory offset in bytes.
 * @returns {Uint8Array} ZIP end of central directory header.
 */
function createZipEndHeader(fileCount, directorySize, directoryOffset) {
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileCount, true);
  view.setUint16(10, fileCount, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, directoryOffset, true);
  view.setUint16(20, 0, true);
  return header;
}

/**
 * Calculate a CRC32 checksum for ZIP file entries.
 *
 * @param {Uint8Array} data Bytes to checksum.
 * @returns {number} Unsigned CRC32 checksum.
 */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Remove path separators and control characters from ZIP names.
 *
 * @param {string} name Suggested file name.
 * @returns {string} Safe archive file name.
 */
function sanitizeZipName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_") || "converted-image";
}

/**
 * Avoid duplicate file names inside a ZIP archive.
 *
 * @param {string} name Safe file name.
 * @param {Map<string, number>} usedNames Name usage counter.
 * @returns {string} Unique file name.
 */
function getUniqueZipName(name, usedNames) {
  const count = usedNames.get(name) ?? 0;
  usedNames.set(name, count + 1);

  if (count === 0) {
    return name;
  }

  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${name}-${count + 1}`;
  }

  return `${name.slice(0, dotIndex)}-${count + 1}${name.slice(dotIndex)}`;
}

/**
 * Open the preview dialog for a queue item.
 *
 * @param {string} id Queue item id.
 * @returns {void}
 */
function openPreview(id) {
  activePreviewId = id;
  renderPreview();

  if (!previewDialog.open) {
    previewDialog.showModal();
  }
}

/**
 * Close the preview dialog.
 *
 * @returns {void}
 */
function closePreview() {
  activePreviewId = null;
  if (previewDialog.open) {
    previewDialog.close();
  }
}

/**
 * Move the preview to a previous or next image.
 *
 * @param {-1 | 1} direction Direction to move.
 * @returns {void}
 */
function showRelativePreview(direction) {
  const previewItems = getPreviewItems();
  if (!previewItems.length || !activePreviewId) {
    return;
  }

  const currentIndex = previewItems.findIndex((item) => item.id === activePreviewId);
  const nextIndex = (currentIndex + direction + previewItems.length) % previewItems.length;
  activePreviewId = previewItems[nextIndex].id;
  renderPreview();
}

/**
 * Render the active preview image and navigation state.
 *
 * @returns {void}
 */
function renderPreview() {
  const previewItems = getPreviewItems();
  const activeItem = previewItems.find((item) => item.id === activePreviewId);

  if (!activeItem?.previewUrl) {
    closePreview();
    return;
  }

  previewImage.src = activeItem.previewUrl;
  previewImage.alt = activeItem.file.name;
  previewTitle.textContent = activeItem.file.name;
  previewMeta.textContent = getPreviewMeta(activeItem, previewItems);
  const hasMultipleImages = previewItems.length > 1;
  previewPrevButton.disabled = !hasMultipleImages;
  previewNextButton.disabled = !hasMultipleImages;
}

/**
 * Get queue items that can be shown in the preview dialog.
 *
 * @returns {QueueItem[]} Previewable items.
 */
function getPreviewItems() {
  return queue.filter((item) => item.previewUrl);
}

/**
 * Build metadata for the active preview image.
 *
 * @param {QueueItem} item Active preview item.
 * @param {QueueItem[]} previewItems Previewable queue items.
 * @returns {string} Preview metadata text.
 */
function getPreviewMeta(item, previewItems) {
  const index = previewItems.findIndex((candidate) => candidate.id === item.id) + 1;
  const size = item.width && item.height ? `${item.width} x ${item.height}` : "Not decoded";
  return `${index} of ${previewItems.length} | ${formatBytes(item.file.size)} | ${size}`;
}

renderQueue();
