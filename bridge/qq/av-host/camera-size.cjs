// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs');
function cameraRenderSize(pageSize) {
  if (!Number.isInteger(pageSize) || pageSize < 4096 || pageSize > 65536 || (pageSize & (pageSize - 1))) throw new Error('Unsupported native memory page size for QQ virtual video');
  // QQ mistakes mmap tail padding for row stride in NV12. Align the complete
  // payload to a memory page; contain the source if a 64 KiB kernel needs bars.
  const width = 1024, rowBytes = width * 3 / 2;
  let a = pageSize, b = rowBytes; while (b) [a, b] = [b, a % b];
  const rows = pageSize / a;
  return { width, height: Math.ceil(576 / rows) * rows };
}
function linuxPageSize() {
  const auxv = fs.readFileSync('/proc/self/auxv');
  // The audited Linux QQ profiles are 64-bit little-endian ARM64/x64.
  for (let i = 0; i + 16 <= auxv.length; i += 16) if (auxv.readBigUInt64LE(i) === 6n) return Number(auxv.readBigUInt64LE(i + 8));
  throw new Error('Cannot determine Linux memory page size');
}
module.exports = { cameraRenderSize, linuxPageSize };
