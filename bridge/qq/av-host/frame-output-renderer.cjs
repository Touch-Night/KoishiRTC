// SPDX-License-Identifier: GPL-3.0-only
(function (root) {
'use strict';
const { drawSuppliedFrame, frameLayout } = typeof module !== 'undefined' && module.exports ? require('./frame-layout.cjs') : root.rtcFrameLayout;

function createFrameRenderer(canvas, { ImageClass = root.Image, nextFrame = callback => requestAnimationFrame(callback) } = {}) {
  let framing = 'full';
  return {
    size(width, height, nextFraming = 'full') {
      frameLayout(width, height, 1, 1, nextFraming);
      canvas.width = width;
      canvas.height = height;
      framing = nextFraming;
    },
    async frame(data) {
      const image = new ImageClass();
      image.src = data;
      await image.decode();
      drawSuppliedFrame(canvas, image, framing);
      await new Promise(nextFrame);
      return { rendered: true };
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createFrameRenderer };
if (typeof document !== 'undefined') {
  const renderer = createFrameRenderer(document.querySelector('canvas'));
  window.rtcSize = renderer.size;
  window.rtcFrame = renderer.frame;
}
})(globalThis);
