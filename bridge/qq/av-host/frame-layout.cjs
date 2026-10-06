// SPDX-License-Identifier: GPL-3.0-only
(function (root) {
'use strict';
/** Keep supplied content complete even when a remote phone fills a portrait viewport. */
function frameLayout(canvasWidth, canvasHeight, imageWidth, imageHeight, framing = 'full') {
  for (const size of [canvasWidth, canvasHeight, imageWidth, imageHeight]) {
    if (!Number.isFinite(size) || size <= 0) throw new RangeError('Frame dimensions must be positive finite numbers');
  }
  if (framing !== 'full' && framing !== 'portrait-safe') throw new RangeError('Unknown video framing');
  // Linux's 64 KiB page alignment adds height to the physical camera canvas.
  // DAV can crop that padding back to 16:9 before the phone crops to 9:16.
  const viewportHeight = framing === 'portrait-safe' ? Math.min(canvasHeight, canvasWidth * 9 / 16) : canvasHeight;
  const viewportWidth = framing === 'portrait-safe' ? Math.min(canvasWidth, viewportHeight * 9 / 16) : canvasWidth;
  const scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
  const width = imageWidth * scale, height = imageHeight * scale;
  return { x: (canvasWidth - width) / 2, y: (canvasHeight - height) / 2, width, height };
}

function drawSuppliedFrame(canvas, image, framing = 'full') {
  const rect = frameLayout(canvas.width, canvas.height, image.width, image.height, framing);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A 2D video drawing context is unavailable');
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // Use the full decoded source image; no source crop, rotation, or stretching.
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  return rect;
}
const api = { frameLayout, drawSuppliedFrame };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.rtcFrameLayout = api;
})(globalThis);
