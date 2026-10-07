import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const filename = fileURLToPath(new URL('../av-host/frame-output.cjs', import.meta.url));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) { for (let n = 0; n < 100 && !predicate(); n++) await Promise.resolve(); assert.ok(predicate()); }
function fixture() {
  const timers = new Map(), windows = [], sinks = []; let timerId = 0, captures = 0, captureGate, loadGate;
  const image = { resize: ({ width, height }) => ({ toBitmap: () => { const bytes = Buffer.alloc(width * height * 4, 255); bytes.set([10, 20, 30, 255]); return bytes; } }) };
  class Window {
    constructor(options) {
      windows.push(this); this.options = options; this.scripts = []; this.destroyed = false;
      this.webContents = { setWindowOpenHandler() {}, on() {}, executeJavaScript: async script => { this.scripts.push(script); }, capturePage: async () => { captures++; if (captureGate) await captureGate; return image; } };
    }
    async loadFile() { if (loadGate) await loadGate; }
    setMenu(menu) { this.menu = menu; }
    setMenuBarVisibility(visible) { this.menuBarVisible = visible; }
    setContentSize(width, height) { this.contentSize = [width, height]; }
    showInactive() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'electron' ? { BrowserWindow: Window, nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 640, height: 360 }), isEmpty: () => false }) } }
      : name === './desktop-video.cjs' ? { ownedWindowHandle: () => 42 }
      : name === './output-window.cjs' ? require('../av-host/output-window.cjs')
      : name === './camera-size.cjs' ? { cameraRenderSize: () => ({ width: 640, height: 360 }), linuxPageSize: () => 4096 } : require(name),
    module, __dirname: path.dirname(filename), process, Buffer, AbortController,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  }, { filename });
  const outputs = new module.exports.FrameOutputs();
  outputs.config = () => ({ device: '/dev/video42', qqDeviceId: 'virtual-id' });
  outputs.createSink = async () => {
    const sink = new EventEmitter(); sink.frames = []; sink.stops = 0;
    sink.start = async options => { sink.startOptions = options; sink.nativeDeviceId = 'virtual-id'; };
    sink.write = async frame => { sink.frames.push(frame); return { state: 'dispatched' }; };
    sink.stop = async () => { sink.stops++; }; sinks.push(sink); return sink;
  };
  const fire = delay => { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `no ${delay}ms timer`); timers.delete(entry[0]); return entry[1].callback(); };
  return { outputs, sinks, windows, timers, captures: () => captures, fire, captureGate: value => { captureGate = value; }, loadGate: value => { loadGate = value; } };
}

test('generated camera submits a real first pattern, runs one frame at a time and cancels on close', async () => {
  const f = fixture();
  await f.outputs.open('camera', 'a', { generated: true });
  assert.equal(f.sinks[0].startOptions.sourceId, 'test-pattern');
  assert.equal(f.sinks[0].frames.length, 1);
  assert.deepEqual([...f.sinks[0].frames[0].data.subarray(0, 4)], [30, 20, 10, 255]);
  assert.ok(f.windows[0].scripts.some(script => script.startsWith('window.rtcTestPattern(')));
  const gate = deferred(); f.captureGate(gate.promise);
  const rendering = f.fire(67); await until(() => f.captures() === 2);
  assert.ok([...f.timers.values()].every(timer => timer.delay !== 67), 'no next frame while capture is pending');
  await f.outputs.close('camera'); gate.resolve(); await rendering;
  assert.equal(f.sinks[0].frames.length, 1, 'late captured pixels cannot reach a stopped sink');
  assert.equal(f.sinks[0].stops, 1); assert.equal(f.windows[0].destroyed, true); assert.equal(f.timers.size, 0);
});

test('external frames remain idle after their initial black frame and never become a test stream', async () => {
  const f = fixture(); await f.outputs.open('camera', 'a');
  assert.equal(f.sinks[0].startOptions.sourceId, 'external-frames');
  assert.equal(f.sinks[0].frames.length, 1);
  assert.deepEqual([...f.sinks[0].frames[0].data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.equal(f.captures(), 0); assert.equal(f.timers.size, 0);
  assert.ok(f.windows[0].scripts.every(script => !script.includes('rtcTestPattern')));
  await f.outputs.write({ kind: 'camera', callId: 'a', width: 640, height: 360, data: 'jpeg' });
  assert.equal(f.sinks[0].frames.length, 2); assert.equal(f.timers.size, 0);
  await f.outputs.closeAll();
});

test('a generated capture timeout reports failure once, stops its producer and cannot resume late', async () => {
  const f = fixture(), errors = [];
  await f.outputs.open('camera', 'a', { generated: true, onError: error => errors.push(error.message) });
  const gate = deferred(); f.captureGate(gate.promise);
  const rendering = f.fire(67); await until(() => f.captures() === 2);
  f.fire(3000); await rendering;
  assert.deepEqual(errors, ['Video frame rendering timed out']); assert.equal(f.sinks[0].stops, 1);
  gate.resolve(); await Promise.resolve();
  assert.equal(f.sinks[0].frames.length, 1); assert.equal(f.timers.size, 0);
  await f.outputs.closeAll();
});

test('replacing an output during its opening cannot let old cleanup destroy the new stream', async () => {
  const f = fixture(), gate = deferred(); f.loadGate(gate.promise);
  const first = f.outputs.open('camera', 'old', { generated: true });
  const rejected = assert.rejects(first, /stopped/);
  await until(() => f.windows.length === 1);
  f.loadGate(null); await f.outputs.open('camera', 'new', { generated: true });
  gate.resolve(); await rejected;
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.windows[1].destroyed, false);
  assert.equal(f.outputs.outputs.get('camera').callId, 'new');
  assert.equal(f.sinks.length, 1); assert.equal(f.sinks[0].stops, 0);
  await assert.rejects(f.outputs.write({ kind: 'camera', callId: 'new' }), /does not accept/);
  await f.outputs.closeAll(); assert.equal(f.timers.size, 0);
});

test('closing during previous-output cleanup invalidates an opening before it allocates a window', async () => {
  const f = fixture(); await f.outputs.open('camera', 'old');
  const gate = deferred(); f.sinks[0].stop = () => gate.promise;
  const opening = f.outputs.open('camera', 'new', { generated: true });
  const rejected = assert.rejects(opening, /stopped/);
  await f.outputs.closeAll(); gate.resolve(); await rejected;
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].destroyed, true); assert.equal(f.outputs.outputs.size, 0);
});

test('supplied and generated screen outputs show only a fixed frameless content surface', async () => {
  for (const generated of [false, true]) {
    const f = fixture(); await f.outputs.open('screen', 'a', { generated });
    const window = f.windows[0];
    assert.equal(window.options.frame, false); assert.equal(window.options.autoHideMenuBar, true);
    assert.equal(window.options.hasShadow, false); assert.equal(window.options.resizable, false);
    assert.equal(window.options.useContentSize, true); assert.equal(window.menu, null); assert.equal(window.menuBarVisible, false);
    assert.deepEqual(window.contentSize, [640, 360]); assert.equal(f.sinks.length, 0);
    await f.outputs.closeAll(); assert.equal(f.timers.size, 0);
  }
});
