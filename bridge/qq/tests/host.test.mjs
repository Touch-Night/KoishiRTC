// SPDX-License-Identifier: GPL-3.0-only
// Runs Host HTTP/IPC wiring against a stub Electron runtime, never loads QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { timingSafeEqual, randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const profiles = require('../av-host/profiles.cjs');
const source = await fs.readFile(new URL('../av-host/host.cjs', import.meta.url), 'utf8');
async function fixture(options = {}) {
  const ipc = new EventEmitter(), calls = [], forwards = [], switches = [], app = new EventEmitter();
  let handler, window, videoOptions, routeReady = true, ensureGate = Promise.resolve(), quitCount = 0;
  const windows = [];
  const recoveryTimers = new Set();
  const profile = profiles.find(p => p.id === options.profileId) ?? profiles.find(p => p.platform === 'win32');
  class FakeRoute {
    constructor() { this.active = false; }
    status() { return { ready: routeReady }; }
    async ensure() { await ensureGate; if (!routeReady) throw new Error('route unavailable'); }
    async devices() { return { devices: [] }; }
    async configure() { return this.status(); }
    setCallActive(value) { this.active = value; }
    handle() {}
    close() {}
  }
  const routeInstances = [];
  class Route extends FakeRoute { constructor() { super(); routeInstances.push(this); } }
  class Window {
    constructor(options) {
      window = this; this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async code => {
        const match = /^window\.koishiRTCQQAVSDKInvoke\((.*)\)$/.exec(code);
        const [command, id, params] = JSON.parse(`[${match[1]}]`);
        calls.push({ command, id, params });
        return { posted: true, id };
      };
    }
    async loadFile(file) {
      this.file = file;
      if (file.endsWith('host.html') && !options.deferReady) ipc.emit('koishi-rtc-qq-avsdk-state', { sender: this.webContents }, { ready: true, pluginFound: true, methods: ['postMessage'] });
    }
    setMenu(menu) { this.menu = menu; }
    setMenuBarVisibility(visible) { this.menuBarVisible = visible; }
    setContentSize(width, height) { this.contentSize = [width, height]; }
    showInactive() { this.shown = true; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; }
    getMediaSourceId() { return 'window:9876:0'; }
  }
  app.commandLine = { appendSwitch: (...args) => switches.push(args) };
  app.setPath = () => {};
  app.whenReady = () => Promise.resolve();
  app.quit = () => { quitCount++; app.emit('before-quit'); };
  const server = { on() {}, listen(_port, _host, ready) { ready(); }, close() {} };
  const overrides = {
    electron: { app, BrowserWindow: Window, ipcMain: ipc },
    'node:http': { createServer(fn) { handler = fn; return server; } },
    'node:fs': { existsSync: () => true, readFileSync: file => file.endsWith('package.json') ? JSON.stringify({ version: options.version ?? profile.qqVersion }) : Buffer.from('mock native binary') },
    'node:crypto': { timingSafeEqual, randomUUID, createHash: () => ({ update() { return this; }, digest: () => options.sha256 ?? profile.librarySHA256 }) },
    './profiles.cjs': profiles,
    './native-health.cjs': require('../av-host/native-health.cjs'),
    './native-shader-patch.cjs': { prepareNativeVideoLibrary: ({ originalPath }) => {
      if (options.patchError) throw new Error(options.patchError);
      return { path: options.patchedPath ?? originalPath, patch: options.patchMetadata ?? null };
    } },
    './video.cjs': { VideoHost: class extends require('../av-host/video.cjs').VideoHost { constructor(options) { super(options); videoOptions = options; } } },
    './desktop-video.cjs': require('../av-host/desktop-video.cjs'),
    './output-window.cjs': require('../av-host/output-window.cjs'),
    '../windows/route-guard.cjs': { AudioRouteGuard: Route },
  };
  vm.runInNewContext(source, { require: name => overrides[name] ?? require(name),
    __dirname: path.resolve('bridge/qq/av-host'), Buffer, URL, setInterval, clearInterval,
    setTimeout(fn) { recoveryTimers.add(fn); return fn; }, clearTimeout(fn) { recoveryTimers.delete(fn); },
    console: { log() {}, error() {} }, process: { env: { KOISHI_RTC_QQ_BRIDGE_TOKEN: 'x'.repeat(40),
      ...(options.supervised ? { KOISHI_RTC_QQ_AV_HOST_SUPERVISED: '1' } : {}) },
      platform: options.platform ?? profile.platform, arch: options.arch ?? profile.arch, versions: {} },
    fetch: async (_url, options) => { forwards.push(JSON.parse(options.body)); return { ok: true }; }, AbortSignal,
  });
  await new Promise(resolve => setImmediate(resolve));
  async function request(url, body, token = 'x'.repeat(40)) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { url, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` } });
    let status, output;
    await handler(req, { writeHead(code) { status = code; }, end(data) { output = JSON.parse(data); } });
    return { status, ...output };
  }
  return { request, calls, forwards, switches, windows, videoOptions, route: routeInstances[0], stop: () => app.quit(),
    recovery: () => ({ pending: recoveryTimers.size, quitCount }),
    recover() { for (const fn of [...recoveryTimers]) { recoveryTimers.delete(fn); fn(); } },
    crash(details) { app.emit('child-process-gone', {}, details); },
    rendererGone(details) { window.webContents.emit('render-process-gone', {}, details); },
    staleReady() { ipc.emit('koishi-rtc-qq-avsdk-state', { sender: window.webContents }, { ready: true, pluginFound: true, methods: ['postMessage'] }); },
    gate(promise) { ensureGate = promise; }, ready(value) { routeReady = value; },
    native(message) { ipc.emit('koishi-rtc-qq-avsdk-raw-message', { sender: window.webContents }, message); } };
}

test('Linux x64 Host enables the audited profile only for exact platform, arch, version and SHA256', async t => {
  const profileId = 'qq-linux-3.2.34-53644-x64';
  for (const mismatch of [null, { platform: 'win32' }, { arch: 'arm64' }, { version: '3.2.34-other' }, { sha256: '0'.repeat(64) }]) {
    const f = await fixture({ profileId, ...mismatch }); t.after(f.stop);
    const status = (await f.request('/v1/status')).data;
    assert.equal(status.nativeProfile?.id ?? null, mismatch ? null : profileId);
    const command = await f.request('/v1/invoke', { command: 4, params: ['{}'], requestId: 'x64-start' });
    assert.equal(command.status, mismatch ? 400 : 200);
    assert.equal(f.calls.length, mismatch ? 0 : 1);
  }
});

test('Host loads the verified generated SDK path and reports its patch, while patch errors abort startup', async t => {
  const patchMetadata = { id: 'fixture', originalSHA256: 'original', loadedSHA256: 'patched' };
  const f = await fixture({ profileId: 'qq-linux-3.2.34-53644-arm64', patchedPath: '/private/runtime/verified/libAVSDKPlugin.so', patchMetadata });
  t.after(f.stop);
  assert.deepEqual(f.switches.find(item => item[0] === 'register-pepper-plugins'), ['register-pepper-plugins', '/private/runtime/verified/libAVSDKPlugin.so;application/x-ppapi-avSDK']);
  assert.deepEqual((await f.request('/v1/status')).data.nativeVideoPatch, patchMetadata);
  await assert.rejects(fixture({ profileId: 'qq-linux-3.2.34-53644-arm64', patchError: 'QQ shader patch: generated library SHA256 mismatch' }), /generated library SHA256 mismatch/);
});

test('old ended-session sync before renderer readiness does not disable the fresh Host video service', async t => {
  const f = await fixture({ deferReady: true }); t.after(f.stop);
  assert.equal((await f.request('/v1/status')).data.ready, false);
  assert.equal((await f.request('/v1/video/session', { callId: null })).status, 200);
  assert.equal((await f.request('/v1/video/session', { callId: null })).status, 200);
  assert.equal(f.calls.length, 0, 'fresh Host has no native video resources to release');
  f.staleReady();
  const status = (await f.request('/v1/status')).data;
  assert.equal(status.ready, true); assert.equal(status.video.supported, true); assert.equal(status.video.lastError, null);
  assert.equal((await f.request('/v1/video/session', { callId: 'new-call', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] })).status, 200);
});

test('Windows shared Host authenticates, reports actual pinned profile and reserves requests across async routing', async t => {
  const f = await fixture(); t.after(f.stop);
  assert.equal((await f.request('/v1/status', null, 'wrong')).status, 401);
  const status = await f.request('/v1/status');
  assert.equal(status.data.nativeProfile.id, 'qq-win32-9.9.36-53644-x64');
  assert.equal(status.data.routeReady, true);
  assert.ok(f.switches.some(x => x[0] === 'allow-command-line-plugins'));
  assert.ok(f.switches.some(x => x[0] === 'force-device-scale-factor' && x[1] === '1'));
  let release;
  f.gate(new Promise(resolve => { release = resolve; }));
  const input = { command: 4, params: ['native-json-fixture'], requestId: 'same-id' };
  const first = f.request('/v1/invoke', input);
  await new Promise(resolve => setImmediate(resolve));
  const second = await f.request('/v1/invoke', input);
  assert.equal(second.status, 409);
  assert.equal(f.calls.length, 0);
  release();
  assert.equal((await first).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.route.active, true);
  assert.equal((await f.request('/v1/invoke', input)).status, 200);
  assert.equal(f.calls.length, 1);
  f.native({ cmd: 10, id: 99, value: [0, ''] });
  assert.equal(f.route.active, true, 'close acknowledgement is not native call termination');
  f.native({ cmd: 20022, id: 0, value: [0, 0, 1, 0, '', ''] });
  assert.equal(f.route.active, false);
});
test('Windows shared Host leaves login and end commands available before route selection', async t => {
  const f = await fixture(); t.after(f.stop); f.ready(false);
  assert.equal((await f.request('/v1/invoke', { command: 5, params: [], requestId: 'no-route' })).status, 503);
  assert.equal(f.calls.length, 0);
  for (const command of [1, 9, 10, 8, 55]) {
    assert.equal((await f.request('/v1/invoke', { command, params: [], requestId: `allowed-${command}` })).status, 200);
  }
  assert.equal(f.calls.length, 5);
});


test('PPAPI or renderer loss latches unavailable despite surviving postMessage and late ready', async t => {
  for (const kind of ['ppapi', 'renderer']) {
    const f = await fixture(); t.after(f.stop);
    if (kind === 'ppapi') f.crash({ type: 'Pepper Plugin', reason: 'crashed', exitCode: 139 });
    else f.rendererGone({ reason: 'killed', exitCode: 9 });
    f.staleReady();
    const status = (await f.request('/v1/status')).data;
    assert.equal(status.ready, false);
    assert.equal(status.pluginFound, false);
    assert.ok(status.nativeFailure.kind.includes(kind));
    assert.equal((await f.request('/v1/invoke', { command: 4, params: ['{}'], requestId: 'after-crash' })).status, 503);
    assert.equal(f.calls.length, 0);
  }
});

test('process loss during audio preflight cannot submit a native call', async t => {
  const f = await fixture(); t.after(f.stop);
  let release;
  f.gate(new Promise(resolve => { release = resolve; }));
  const pending = f.request('/v1/invoke', { command: 4, params: ['{}'], requestId: 'racing-crash' });
  await new Promise(resolve => setImmediate(resolve));
  f.crash({ type: 'PPAPIPlugin', reason: 'crashed' }); release();
  assert.equal((await pending).status, 503);
  assert.equal(f.calls.length, 0);
});

test('only a supervised isolated Host exits once to recover after native process death', async t => {
  for (const supervised of [false, true]) {
    const f = await fixture({ supervised }); t.after(f.stop);
    f.crash({ type: 'Pepper Plugin', reason: 'crashed', exitCode: 139 });
    f.rendererGone({ reason: 'crashed' });
    assert.equal(f.recovery().pending, supervised ? 1 : 0);
    assert.equal((await f.request('/v1/status')).data.ready, false);
    f.recover();
    assert.equal(f.recovery().quitCount, supervised ? 1 : 0);
    f.crash({ type: 'Pepper Plugin', reason: 'clean-exit' });
    assert.equal(f.recovery().pending, 0, 'shutdown cannot schedule a second recovery');
  }
});

test('a broker exiting does not invalidate the still running media plugin', async t => {
  const f = await fixture({ supervised: true }); t.after(f.stop);
  f.crash({ type: 'Pepper Plugin Broker', reason: 'clean-exit' });
  assert.equal((await f.request('/v1/status')).data.ready, true);
  assert.deepEqual(f.recovery(), { pending: 0, quitCount: 0 });
});


test('startup Kernel envelopes are buffered before the controller arrives, forwarded once before Login', async t => {
  const f = await fixture(); t.after(f.stop);
  f.native({ cmd: 20000, id: 0, value: [1, 'cmVnaXN0ZXI='] });
  assert.equal(f.forwards.length, 0);
  const before = (await f.request('/v1/status')).data;
  assert.equal(before.bufferedKernelOutputs, 1);
  assert.ok(before.bootId);
  await f.request('/v1/invoke', { command: 1, params: [], requestId: 'first-login' });
  assert.equal(f.forwards.length, 1);
  assert.equal(f.forwards[0].command, 20000);
  assert.equal((await f.request('/v1/status')).data.bufferedKernelOutputs, 0);
  await f.request('/v1/invoke', { command: 1, params: [], requestId: 'first-login' });
  assert.equal(f.forwards.length, 1, 'native startup registration is never repeated');
});

test('renderer binds native messages before embedding can initialize the plugin', async () => {
  const html = await fs.readFile(new URL('../av-host/host.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const handlers = {}, sent = [];
  const plugin = { addEventListener(name, handler) { handlers[name] = handler; } };
  vm.runInNewContext(script, { require: () => ({ ipcRenderer: { send: (...args) => sent.push(args) } }),
    window: { addEventListener() {} }, setTimeout() {},
    document: { createElement: () => plugin, getElementById: () => plugin,
      body: { appendChild() { handlers.message({ data: { cmd: 20000, value: [1, 'fixture'] } }); } } },
  });
  assert.equal(sent[1][0], 'koishi-rtc-qq-avsdk-raw-message');
  assert.equal(sent[1][1].cmd, 20000);
});

test('receive presentation waits for matching viewport and two paint frames, and bounds a stuck resize', async () => {
  const html = await fs.readFile(new URL('../av-host/host.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const frames = [], timers = new Set();
  const window = { innerWidth: 320, innerHeight: 240, devicePixelRatio: 1, addEventListener() {} };
  const plugin = { addEventListener() {}, getBoundingClientRect: () => ({ width: Number(plugin.width), height: Number(plugin.height) }) };
  vm.runInNewContext(script, { require: () => ({ ipcRenderer: { send() {} } }), window,
    requestAnimationFrame: cb => frames.push(cb),
    setTimeout: cb => { timers.add(cb); return cb; }, clearTimeout: cb => timers.delete(cb),
    document: { createElement: () => plugin, getElementById: () => plugin, body: { appendChild() {} } },
  });
  let complete = false;
  const resized = window.koishiRTCQQVideoSurface(1280, 720).then(() => { complete = true; });
  frames.shift()(); frames.shift()(); await Promise.resolve();
  assert.equal(complete, false, 'embed dimensions alone do not prove the viewport resized');
  window.innerWidth = 1280; window.innerHeight = 720;
  frames.shift()(); await Promise.resolve(); assert.equal(complete, false);
  frames.shift()(); await resized; assert.equal(timers.size, 0);
  window.devicePixelRatio = 2;
  const rejected = assert.rejects(window.koishiRTCQQVideoPresent(1280, 720), /viewport size/);
  frames.shift()(); for (const timeout of timers) timeout(); await rejected;
});

test('native room query is available only for independently audited Linux profiles', async t => {
  for (const profile of profiles.filter(item => item.platform !== 'darwin')) {
    const f = await fixture({ profileId: profile.id }); t.after(f.stop);
    const response = await f.request('/v1/invoke', { command: 14, params: [], requestId: 'query-room' });
    assert.equal(response.status, profile.roomIdleQuery ? 200 : 400);
    assert.equal(f.calls.length, profile.roomIdleQuery ? 1 : 0);
  }
});

test('generated screen test window exposes only its exact undecorated content area', async t => {
  const f = await fixture(); t.after(f.stop);
  assert.equal(await f.videoOptions.testWindow(), 9876);
  const window = f.windows.at(-1);
  assert.equal(window.options.frame, false); assert.equal(window.options.hasShadow, false);
  assert.equal(window.options.useContentSize, true); assert.equal(window.menu, null); assert.equal(window.menuBarVisible, false);
  assert.deepEqual(window.contentSize, [640, 360]); assert.equal(window.shown, true);
  assert.ok(window.file.endsWith('video-test.html'));
  await f.videoOptions.closeTestWindow(); assert.equal(window.destroyed, true);
});
