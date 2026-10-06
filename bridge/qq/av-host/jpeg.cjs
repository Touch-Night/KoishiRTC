// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const invalid = message => Object.assign(new Error(`Invalid JPEG: ${message}`), { code: 'INVALID_VIDEO' });
const dimensions = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 2073600;
/**
 * Bounded marker preflight before nativeImage allocates a decoded image.
 * Accepts 8-bit sequential/progressive Huffman JPEG (SOF0/1/2), including
 * multiple scans and stuffed entropy bytes. No decoder or image allocation.
 * Marker layouts: https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jdmarker.c
 * Entropy decoding remains the native decoder's job; valid markers alone do
 * not certify that a Huffman bitstream is decodable.
 */
function validateJpeg(bytes, width, height) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > 262144) throw invalid('expected at most 256 KiB');
  if (!dimensions(width, height)) throw invalid('metadata exceeds the 4096-edge / 2073600-pixel limit');
  if (bytes[0] !== 255 || bytes[1] !== 216) throw invalid('missing SOI');
  const u16 = offset => bytes[offset] * 256 + bytes[offset + 1];
  let offset = 2, sof = 0, scans = 0, entropy = false, scanData = false, restartInterval = 0, restart = 0;
  const components = new Map(), covered = new Set(), quantizers = new Set(), huffman = new Set();
  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; scanData = true; continue; }
        const start = offset++;
        while (bytes[offset] === 255) offset++;
        if (offset >= bytes.length) throw invalid('truncated entropy marker');
        const marker = bytes[offset++];
        if (marker === 0) {
          if (offset - start !== 2) throw invalid('invalid byte stuffing');
          scanData = true; continue;
        }
        if (marker >= 208 && marker <= 215) {
          if (!restartInterval || marker !== 208 + restart || !scanData) throw invalid('invalid restart marker');
          restart = (restart + 1) % 8; scanData = false; continue;
        }
        if (!scanData) throw invalid('empty scan');
        offset = start; entropy = false; break;
      }
      if (offset >= bytes.length) throw invalid('missing EOI');
    }
    if (bytes[offset++] !== 255) throw invalid('expected a marker');
    while (bytes[offset] === 255) offset++;
    if (offset >= bytes.length) throw invalid('truncated marker');
    const marker = bytes[offset++];
    if (marker === 217) {
      if (!sof || !scans || covered.size !== components.size || offset !== bytes.length) throw invalid('incomplete frame or trailing bytes');
      return { width, height };
    }
    if (marker === 0 || marker === 216 || marker === 1 || marker >= 208 && marker <= 215) throw invalid('unexpected standalone marker');
    if (offset + 2 > bytes.length) throw invalid('truncated segment length');
    const length = u16(offset), start = offset + 2, end = offset + length;
    if (length < 2 || end > bytes.length) throw invalid('truncated or invalid segment');
    offset = end;
    if (marker >= 224 && marker <= 239 || marker === 254) continue; // Opaque APP/COM data may itself contain marker bytes.
    if ([192, 193, 194].includes(marker)) {
      if (sof || scans || length < 8) throw invalid('duplicate or truncated SOF');
      const actualHeight = u16(start + 1), actualWidth = u16(start + 3), count = bytes[start + 5];
      if (bytes[start] !== 8 || count < 1 || count > 4 || length !== 8 + 3 * count) throw invalid('unsupported precision or invalid SOF components');
      if (!dimensions(actualWidth, actualHeight) || actualWidth !== width || actualHeight !== height) throw invalid('SOF dimensions do not match metadata or exceed limits');
      for (let pos = start + 6; pos < end; pos += 3) {
        const id = bytes[pos], h = bytes[pos + 1] >> 4, v = bytes[pos + 1] & 15, table = bytes[pos + 2];
        if (components.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || table > 3) throw invalid('invalid SOF component');
        components.set(id, table);
      }
      sof = marker;
    } else if (marker === 219) {
      let pos = start;
      if (pos === end) throw invalid('empty DQT');
      while (pos < end) {
        const table = bytes[pos++], precision = table >> 4;
        if (precision > 1 || (table & 15) > 3) throw invalid('invalid quantizer');
        pos += 64 * (precision + 1);
        if (pos > end) throw invalid('truncated quantizer');
        quantizers.add(table & 15);
      }
    } else if (marker === 196) {
      let pos = start;
      if (pos === end) throw invalid('empty DHT');
      while (pos < end) {
        const table = bytes[pos++];
        if ((table >> 4) > 1 || (table & 15) > 3 || pos + 16 > end) throw invalid('invalid Huffman table');
        let count = 0, slots = 1;
        for (let i = 0; i < 16; i++) { const n = bytes[pos++]; count += n; slots = slots * 2 - n; if (slots < 0) throw invalid('oversubscribed Huffman table'); }
        if (!count || count > 256 || pos + count > end) throw invalid('truncated Huffman table');
        pos += count; huffman.add(table);
      }
    } else if (marker === 221) {
      if (length !== 4) throw invalid('invalid restart interval');
      restartInterval = u16(start);
    } else if (marker === 218) {
      const count = bytes[start];
      if (!sof || length < 6 || count < 1 || count > components.size || length !== 6 + 2 * count) throw invalid('invalid scan header or missing SOF');
      const ss = bytes[end - 3], se = bytes[end - 2], approximation = bytes[end - 1], high = approximation >> 4, low = approximation & 15;
      if (sof !== 194 ? ss !== 0 || se !== 63 || approximation !== 0 : ss > se || se > 63 || (ss === 0 ? se !== 0 : count !== 1) || high > 13 || low > 13 || high !== 0 && high !== low + 1) throw invalid('invalid scan parameters');
      const ids = new Set();
      for (let pos = start + 1; pos < end - 3; pos += 2) {
        const id = bytes[pos], selector = bytes[pos + 1], dc = selector >> 4, ac = selector & 15;
        if (!components.has(id) || ids.has(id) || dc > 3 || ac > 3 || !quantizers.has(components.get(id)) || ss === 0 && high === 0 && !huffman.has(dc) || se > 0 && !huffman.has(16 + ac)) throw invalid('invalid scan component or missing coding table');
        ids.add(id); if (ss === 0) covered.add(id);
      }
      scans++; entropy = true; scanData = false; restart = 0;
    } else {
      // DNL/hierarchical/differential frames could redefine geometry after SOF;
      // arithmetic/lossless JPEG and reserved extensions are outside this API.
      throw invalid('unsupported marker or JPEG coding process');
    }
  }
  throw invalid('missing EOI');
}
module.exports = { validateJpeg };
