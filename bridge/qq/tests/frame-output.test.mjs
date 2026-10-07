import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cameraRenderSize } = require('../av-host/camera-size.cjs');
const { frameLayout } = require('../av-host/frame-layout.cjs');
const { createFrameRenderer } = require('../av-host/frame-output-renderer.cjs');

test('portrait-safe contains a landscape image inside the centered phone viewport', () => {
  assert.deepEqual(frameLayout(1024, 576, 640, 360, 'portrait-safe'), {
    x: 350, y: 196.875, width: 324, height: 182.25,
  });
  // The tested 640x360 transport scaled to an approximately 202x114 center image.
  assert.deepEqual(frameLayout(640, 360, 640, 360, 'portrait-safe'), {
    x: 218.75, y: 123.046875, width: 202.5, height: 113.90625,
  });
});

test('a portrait source fills the safe viewport once, without additional narrowing', () => {
  const expected = { x: 350, y: 0, width: 324, height: 576 };
  assert.deepEqual(frameLayout(1024, 576, 360, 640, 'portrait-safe'), expected);
  assert.deepEqual(frameLayout(1024, 576, 360, 640, 'full'), expected);
  assert.deepEqual(frameLayout(1024, 576, 300, 900, 'portrait-safe'), {
    x: 416, y: 0, width: 192, height: 576,
  });
});

test('safe content survives 4 KiB and 64 KiB camera alignment and centered DAV cropping', () => {
  for (const page of [4096, 65536]) {
    const { width, height } = cameraRenderSize(page);
    assert.equal(width * height * 3 / 2 % page, 0);
    const landscape = frameLayout(width, height, 640, 360, 'portrait-safe');
    const portrait = frameLayout(width, height, 360, 640, 'portrait-safe');
    assert.equal(landscape.width, 324);
    assert.equal(landscape.height, 182.25);
    assert.equal(portrait.width, 324);
    assert.equal(portrait.height, 576);
    assert.equal(portrait.y, page === 4096 ? 0 : 32);
    assert.equal(landscape.y + landscape.height / 2, height / 2);
    assert.ok(portrait.y >= (height - 576) / 2);
    assert.ok(portrait.y + portrait.height <= (height + 576) / 2);
  }
});

test('full framing retains normal screen and camera contain behavior', () => {
  assert.deepEqual(frameLayout(640, 360, 640, 360), { x: 0, y: 0, width: 640, height: 360 });
  assert.deepEqual(frameLayout(1024, 576, 640, 360, 'full'), { x: 0, y: 0, width: 1024, height: 576 });
  assert.deepEqual(frameLayout(1024, 640, 640, 360, 'full'), { x: 0, y: 32, width: 1024, height: 576 });
  assert.deepEqual(frameLayout(640, 360, 360, 640, 'full'), { x: 218.75, y: 0, width: 202.5, height: 360 });
  assert.throws(() => frameLayout(640, 360, 0, 360), /dimensions/);
  assert.throws(() => frameLayout(640, Infinity, 640, 360), /dimensions/);
  assert.throws(() => frameLayout(640, 360, 640, 360, 'crop'), /framing/);
});

function fixture() {
  const calls = [];
  const context = { fillRect: (...args) => calls.push(['fill', ...args]), drawImage: (...args) => calls.push(['draw', ...args]) };
  const canvas = { width: 640, height: 360, getContext: () => context };
  class Image {
    width = 640; height = 360;
    async decode() { calls.push(['decoded', this.src]); }
  }
  return { calls, context, canvas, Image };
}

test('actual renderer decodes then draws the entire image through shared geometry', async () => {
  const f = fixture();
  const renderer = createFrameRenderer(f.canvas, { ImageClass: f.Image, nextFrame: done => { f.calls.push(['paint']); done(); } });
  renderer.size(1024, 640, 'portrait-safe');
  assert.deepEqual(await renderer.frame('data:image/jpeg;base64,test'), { rendered: true });
  assert.deepEqual(f.calls.map(call => call[0]), ['decoded', 'fill', 'draw', 'paint']);
  assert.equal(f.context.fillStyle, '#000');
  assert.deepEqual(f.calls[1], ['fill', 0, 0, 1024, 640]);
  const [, image, ...rect] = f.calls[2];
  assert.ok(image instanceof f.Image);
  assert.deepEqual(rect, [350, 228.875, 324, 182.25]);
  renderer.size(640, 360, 'full');
  await renderer.frame('next');
  assert.deepEqual(f.calls.at(-2).slice(2), [0, 0, 640, 360]);
});

test('the sandboxed HTML loads the same helper and renderer without Node or inline script', async () => {
  const html = fs.readFileSync(new URL('../av-host/frame-output.html', import.meta.url), 'utf8');
  assert.match(html, /script-src 'self'/);
  const scripts = [...html.matchAll(/<script src="\.\/([^"/]+)"\s*><\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  const f = fixture();
  const sandbox = { Image: f.Image, document: { querySelector: () => f.canvas }, requestAnimationFrame: callback => callback() };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(fs.readFileSync(new URL(`../av-host/${script}`, import.meta.url), 'utf8'), sandbox);
  sandbox.rtcSize(1024, 576, 'portrait-safe');
  await sandbox.rtcFrame('sandbox-frame');
  assert.deepEqual(f.calls.at(-1).slice(2), [350, 196.875, 324, 182.25]);
});

test('generated pattern is explicitly labelled, animated and readable inside the phone crop', async () => {
  const f = fixture(); f.context.fillText = (...args) => f.calls.push(['text', ...args]);
  const renderer = createFrameRenderer(f.canvas, { ImageClass: f.Image, nextFrame: done => done() });
  renderer.size(1024, 640);
  await renderer.testPattern(0);
  const texts = f.calls.filter(call => call[0] === 'text');
  assert.ok(texts.some(call => call[1] === '测试画面'));
  assert.ok(texts.some(call => call[1] === 'TEST PATTERN'));
  assert.ok(texts.every(([, , center, , width]) => center === 512 && width <= 324));
  const firstMarker = f.calls.at(-1); f.calls.length = 0;
  await renderer.testPattern(1000);
  assert.notDeepEqual(f.calls.at(-1), firstMarker);
  assert.ok(f.calls.some(call => call[0] === 'text' && call[1] === '1.0 s'));
  assert.ok(f.calls.every(call => call[0] !== 'decoded' && call[0] !== 'draw'));
  await assert.rejects(renderer.testPattern(Infinity), /clock/);
});
