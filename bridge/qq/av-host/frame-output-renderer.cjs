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
    async testPattern(elapsedMs) {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid test-pattern clock');
      const ctx = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
      const colors = ['#e6e6e6', '#e8cf48', '#4bc7d1', '#69be72', '#be73c8', '#d76c70', '#608dcc'];
      colors.forEach((color, index) => {
        ctx.fillStyle = color;
        ctx.fillRect(Math.floor(index * width / colors.length), 0, Math.ceil(width / colors.length), height);
      });
      // Keep the label inside QQ's centered portrait crop as well as landscape video.
      const safeWidth = Math.min(width, height * 9 / 16), center = width / 2;
      ctx.fillStyle = '#16212f';
      ctx.fillRect(center - safeWidth / 2, height * .24, safeWidth, height * .52);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(safeWidth * .105)}px sans-serif`;
      ctx.fillText('测试画面', center, height * .36, safeWidth * .9);
      ctx.font = `${Math.round(safeWidth * .075)}px sans-serif`;
      ctx.fillText('TEST PATTERN', center, height * .45, safeWidth * .9);
      ctx.fillText('Koishi RTC', center, height * .54, safeWidth * .9);
      ctx.fillText(`${(elapsedMs / 1000).toFixed(1)} s`, center, height * .64, safeWidth * .9);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(center - safeWidth * .45 + (elapsedMs % 4000) / 4000 * safeWidth * .8, height * .71, safeWidth * .1, Math.max(2, height * .012));
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
  window.rtcTestPattern = renderer.testPattern;
}
})(globalThis);
