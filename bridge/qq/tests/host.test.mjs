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
  let handler, window, routeReady = true, ensureGate = Promise.resolve();
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
    constructor() {
      window = this;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async code => {
        const match = /^window\.koishiRTCQQAVSDKInvoke\((.*)\)$/.exec(code);
        const [command, id, params] = JSON.parse(`[${match[1]}]`);
        calls.push({ command, id, params });
        return { posted: true, id };
      };
    }
    async loadFile() {
      ipc.emit('koishi-rtc-qq-avsdk-state', { sender: this.webContents }, { ready: true, pluginFound: true, methods: ['postMessage'] });
    }
  }
  app.commandLine = { appendSwitch: (...args) => switches.push(args) };
  app.setPath = () => {};
  app.whenReady = () => Promise.resolve();
  app.quit = () => app.emit('before-quit');
  const server = { on() {}, listen(_port, _host, ready) { ready(); }, close() {} };
  const overrides = {
    electron: { app, BrowserWindow: Window, ipcMain: ipc },
    'node:http': { createServer(fn) { handler = fn; return server; } },
    'node:fs': { existsSync: () => true, readFileSync: file => file.endsWith('package.json') ? JSON.stringify({ version: options.version ?? profile.qqVersion }) : Buffer.from('mock native binary') },
    'node:crypto': { timingSafeEqual, randomUUID, createHash: () => ({ update() { return this; }, digest: () => options.sha256 ?? profile.librarySHA256 }) },
    './profiles.cjs': profiles,
    './video.cjs': require('../av-host/video.cjs'),
    './desktop-video.cjs': require('../av-host/desktop-video.cjs'),
    '../windows/route-guard.cjs': { AudioRouteGuard: Route },
  };
  vm.runInNewContext(source, { require: name => overrides[name] ?? require(name),
    __dirname: path.resolve('bridge/qq/av-host'), Buffer, URL, setInterval, clearInterval,
    console: { log() {}, error() {} }, process: { env: { KOISHI_RTC_QQ_BRIDGE_TOKEN: 'x'.repeat(40) },
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
  return { request, calls, forwards, switches, route: routeInstances[0], stop: () => app.quit(),
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

test('Windows shared Host authenticates, reports actual pinned profile and reserves requests across async routing', async t => {
  const f = await fixture(); t.after(f.stop);
  assert.equal((await f.request('/v1/status', null, 'wrong')).status, 401);
  const status = await f.request('/v1/status');
  assert.equal(status.data.nativeProfile.id, 'qq-win32-9.9.36-53644-x64');
  assert.equal(status.data.routeReady, true);
  assert.ok(f.switches.some(x => x[0] === 'allow-command-line-plugins'));
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

test('native room query is available only for independently audited Linux profiles', async t => {
  for (const profile of profiles.filter(item => item.platform !== 'darwin')) {
    const f = await fixture({ profileId: profile.id }); t.after(f.stop);
    const response = await f.request('/v1/invoke', { command: 14, params: [], requestId: 'query-room' });
    assert.equal(response.status, profile.roomIdleQuery ? 200 : 400);
    assert.equal(f.calls.length, profile.roomIdleQuery ? 1 : 0);
  }
});
