// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';

// Offline numerical regression for the audited screen scaler. No QQ binary,
// camera frame, GL context, or live host is needed. IEEE binary16 models the
// mediump arithmetic which reproduced the observed 864x1920 -> 288x640 grid.
function half(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  const sign = Math.sign(value), magnitude = Math.abs(value);
  if (magnitude >= 65520) return sign * Infinity;
  const quantum = 2 ** (Math.max(-14, Math.floor(Math.log2(magnitude))) - 10);
  const scaled = magnitude / quantum, low = Math.floor(scaled), tail = scaled - low;
  const rounded = tail > 0.5 || (tail === 0.5 && low % 2) ? low + 1 : low;
  return sign * rounded * quantum;
}

function fractionAt(sourceSize, outputSize, index, precision) {
  const step = precision(1 / precision(sourceSize));
  const coordinate = precision((index + 0.5) / outputSize);
  const position = precision(coordinate + precision(step * 0.5));
  const pixel = precision(position / step);
  return pixel - Math.floor(pixel);
}

function weights(fraction, precision) {
  const samples = [precision(1 + fraction), fraction, precision(1 - fraction), precision(2 - fraction)]
    .map(value => Math.max(Math.abs(precision(precision(Math.PI) * value)), precision(1e-5)));
  const taps = samples.map(value => precision(
    precision(precision(Math.sin(value)) * precision(Math.sin(precision(value / 2)))) /
    precision(value * value)));
  const sum = taps.reduce((total, value) => precision(total + value), 0);
  return taps.map(value => precision(value / sum));
}

test('binary16 scaler epsilon produces 0/0, while highp preserves finite normalized taps', () => {
  assert.equal(half(1e-5), 1.0013580322265625e-5);
  assert.equal(half(half(1e-5) ** 2), 0);
  assert.ok(weights(0, half).every(Number.isNaN));
  const high = weights(0, Math.fround);
  assert.ok(high.every(Number.isFinite));
  assert.ok(Math.abs(high.reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

test('binary16 source coordinate rounding explains the exact repeating rows and 1024-row boundary', () => {
  assert.equal(half(1023.5), 1023.5);
  assert.equal(half(1024.5), 1024, 'binary16 has no fractional values at or above 1024');
  assert.equal(half(1025.5), 1026, 'ties round to even');
  const black = index => fractionAt(1920, 640, index, half) === 0;
  // Independently matched against every one of the 290 rows y=50..339 in
  // the reported frame; this compact boundary pattern contains no image data.
  assert.deepEqual(Array.from({ length: 20 }, (_, index) => black(320 + index)),
    Array.from({ length: 4 }, () => [true, true, false, false, false]).flat());
  assert.ok(Array.from({ length: 300 }, (_, index) => black(340 + index)).every(Boolean));
  assert.ok(Math.abs(1024 / 1920 * 640 - 341.3333333333333) < 1e-9);
});

test('highp produces finite screen-filter weights over the entire reported frame', () => {
  for (const [source, output] of [[864, 288], [1920, 640]]) {
    for (let index = 0; index < output; index++) {
      const taps = weights(fractionAt(source, output, index, Math.fround), Math.fround);
      assert.ok(taps.every(Number.isFinite), `${source} -> ${output}, coordinate ${index}`);
      assert.ok(Math.abs(taps.reduce((a, b) => a + b, 0) - 1) < 1e-6);
    }
  }
});
