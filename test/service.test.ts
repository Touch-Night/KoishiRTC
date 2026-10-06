import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Context } from 'koishi';
import type { Client, Entry } from '@koishijs/console';
import * as plugin from '../src/index.js';
import { unavailableCapabilities, type CallProvider, type CallSnapshot, type AudioFrame, type VideoTrack, type VideoState, type VideoFrame } from '../src/core.js';

// Use Koishi's canonical CJS classes, exactly as its loader and this service do.
const require = createRequire(import.meta.url);
const { App } = require('koishi') as typeof import('koishi');
const { Console } = require('@koishijs/console') as typeof import('@koishijs/console');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function eventually(check: () => boolean, message = 'condition timed out') {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(message);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class Socket extends EventTarget {
  readyState = 1;
  packets: any[] = [];
  send(data: string) { this.packets.push(JSON.parse(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
class MemoryConsole extends Console {
  protected resolveEntry(_files: Entry.Files, _key: string) { return []; }
  connect(socket: Socket) {
    this.accept(socket as any, { headers: { 'user-agent': 'rtc-offline-test' }, socket: { remoteAddress: '127.0.0.1' } } as any);
    return Object.values(this.clients).find(client => client.socket === socket as any)!;
  }
}
const rpcNames = ['rtc/status', 'rtc/diagnostics', 'rtc/devices', 'rtc/audio-routes', 'rtc/configure-audio', 'rtc/channels', 'rtc/control', 'rtc/video'];
async function fixture(t: TestContext, auth = false) {
  const app = new App({}), errors: unknown[] = [];
  app.on('internal/error', error => { errors.push(error); });
  app.plugin(MemoryConsole);
  if (auth) {
    // No files, HTTP ports, real credentials or external platforms are involved.
    app.plugin(require('@koishijs/plugin-database-sqlite').default, { path: ':memory:' });
    app.plugin(require('@koishijs/plugin-auth').default, { admin: { enabled: true, username: 'rtc-fixture', password: 'offline-fixture-only' } });
  }
  const rtcScope = app.plugin(plugin, { bridges: [], discord: [], historyLimit: 20 })!;
  await app.start();
  const console = app.console as MemoryConsole, service = app.rtc, sockets: Socket[] = [];
  assert.ok(service); assert.ok(rpcNames.every(name => console.listeners[name]));
  t.after(async () => {
    for (const socket of sockets) socket.close();
    rtcScope.dispose(); await tick(); await app.stop(); await tick();
    assert.deepEqual(errors, [], 'Koishi lifecycle emitted unexpected errors');
  });
  const connect = () => {
    const socket = new Socket(); sockets.push(socket); const client = console.connect(socket) as Client & { auth?: any };
    let requestId = 0;
    const rpc = async (type: string, ...args: unknown[]) => {
      const id = String(++requestId); await client.receive({ data: JSON.stringify({ type, args, id }) } as any);
      const packet = socket.packets.find(packet => packet.type === 'response' && packet.body.id === id);
      assert.ok(packet, `No console response for ${type}`); return packet.body;
    };
    return { socket, client, rpc };
  };
  const scope = () => {
    let context!: Context;
    const fork = app.plugin((ctx: Context) => { context = ctx; })!;
    return { ctx: context, dispose: () => fork.dispose() };
  };
  return { app, console, service, rtcScope, connect, scope };
}
function providerFixture(id = 'p', callId = 'c1') {
  const events = new EventEmitter(), operations = { accept: 0, clear: 0, stop: 0, writes: 0 };
  let call: CallSnapshot = { id: callId, providerId: id, account: { platform: 'fixture', selfId: '1' }, kind: 'direct', direction: 'incoming', targetId: '2', state: 'connected', createdAt: 1, updatedAt: 1, participants: [], muted: false };
  const publish = (patch: Partial<CallSnapshot>) => { call = { ...call, ...patch }; events.emit('event', { type: 'call', call }); };
  const provider: CallProvider & { channels(): Promise<unknown[]> } = {
    id, account: call.account, events, audioFormat: { sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' },
    capabilities: () => Object.fromEntries(Object.keys(unavailableCapabilities()).map(key => [key, { supported: true }])) as any,
    calls: () => [call], start: async () => {}, stop: async () => { operations.stop++; },
    dial: async () => call, accept: async () => { operations.accept++; publish({ state: 'connected' }); }, reject: async () => publish({ state: 'ended' }), hangup: async () => publish({ state: 'ended' }),
    setMuted: async (_id, muted) => publish({ muted }), clearAudio: async () => { operations.clear++; },
    writeAudio: async (frame, id) => { operations.writes++; return { id, callId: frame.callId, acceptedBytes: frame.data.length, playedBytes: 0, state: 'queued' }; },
    diagnostics: async () => [], channels: async () => [{ id: callId, kind: 'group', name: 'fixture channel' }],
  };
  return { provider, events, operations, publish };
}
const audio: AudioFrame = { callId: 'c1', encoding: 'pcm_s16le', sampleRate: 48000, channels: 1, data: new Uint8Array(1920), sequence: 0, timestamp: 1 };

test('real Koishi console listeners enforce authority and expiry even without the auth plugin', async t => {
  const f = await fixture(t), p = providerFixture(); p.publish({ state: 'ringing' }); await f.service.register(f.scope().ctx, p.provider);
  const client = f.connect();
  const requests: [string, ...unknown[]][] = [
    ['rtc/status'], ['rtc/diagnostics'], ['rtc/devices', 'p'], ['rtc/audio-routes', 'p'],
    ['rtc/configure-audio', 'p', 'in', 'out'], ['rtc/channels', 'p'], ['rtc/control', 'accept', { callId: 'c1' }],
    ['rtc/video', 'subscribe', { callId: 'c1', participantId: 'peer', kind: 'camera' }],
  ];
  for (const [name, ...args] of requests) {
    assert.equal(f.console.listeners[name]!.authority, 4);
    assert.match((await client.rpc(name, ...args)).error, /权限等级 4/);
  }
  for (const auth of [{ authority: 3, expiredAt: Date.now() + 60000 }, { authority: 5, expiredAt: Date.now() - 1 }, { authority: 5 }, { authority: Number.NaN, expiredAt: Date.now() + 60000 }, { authority: 5, expiredAt: Number.NaN }]) {
    client.client.auth = auth;
    assert.match((await client.rpc('rtc/control', 'accept', { callId: 'c1' })).error, /权限等级 4/);
  }
  assert.equal(p.operations.accept, 0); assert.equal(f.service.manager.getCall('c1').owner, undefined);
  client.client.auth = { authority: 4, expiredAt: Date.now() + 60000 };
  assert.equal((await client.rpc('rtc/control', 'accept', { callId: 'c1' })).error, undefined);
  assert.equal(p.operations.accept, 1); assert.equal(f.service.manager.getCall('c1').state, 'connected');
});

test('actual auth login permits RTC and its console intercept rejects downgraded and expired sessions', async t => {
  const f = await fixture(t, true), client = f.connect();
  assert.equal((await client.rpc('rtc/status')).error, 'unauthorized');
  assert.equal((await client.rpc('login/password', 'rtc-fixture', 'offline-fixture-only')).error, undefined);
  assert.equal(client.client.auth.authority, 5); assert.ok((await client.rpc('rtc/status')).value.providers);
  client.client.auth.authority = 3; assert.equal((await client.rpc('rtc/status')).error, 'unauthorized');
  client.client.auth.authority = 5; client.client.auth.expiredAt = Date.now() - 1; assert.equal((await client.rpc('rtc/status')).error, 'unauthorized');
  await tick(); // Allow Console's async entry refresh to finish before teardown.
});

test('disconnected and expired console owners release playback without ending the call', async t => {
  const f = await fixture(t), p = providerFixture(); await f.service.register(f.scope().ctx, p.provider);
  const first = f.connect(), second = f.connect();
  for (const client of [first, second]) client.client.auth = { authority: 4, expiredAt: Date.now() + 60000 };
  assert.equal((await first.rpc('rtc/control', 'clear', { callId: 'c1' })).error, undefined);
  assert.match((await second.rpc('rtc/control', 'clear', { callId: 'c1' })).error, /控制/);
  first.socket.close(); await eventually(() => f.service.manager.getCall('c1').owner === undefined, 'closed console retained its lease');
  assert.equal(f.service.manager.getCall('c1').state, 'connected'); assert.equal(p.operations.clear, 2);
  assert.equal((await second.rpc('rtc/control', 'clear', { callId: 'c1' })).error, undefined);
  second.client.auth.expiredAt = Date.now() - 1;
  assert.match((await second.rpc('rtc/control', 'clear', { callId: 'c1' })).error, /权限等级 4/);
  await eventually(() => f.service.manager.getCall('c1').owner === undefined, 'expired console retained its lease');
  assert.equal(p.operations.clear, 4); assert.equal(f.service.manager.getCall('c1').state, 'connected');
});

test('consumer plugin disposal revokes continuous PCM readers and only its own controller', async t => {
  const f = await fixture(t), p = providerFixture(); await f.service.register(f.scope().ctx, p.provider);
  const consumer = f.scope(), controller = f.service.controller(consumer.ctx, 'consumer'); controller.claim('c1');
  const reader = controller.audio('c1')[Symbol.asyncIterator](), first = reader.next(); p.events.emit('event', { type: 'audio', audio });
  assert.equal((await first).value?.data.length, 1920);
  const waiting = assert.rejects(reader.next(), /取消/); consumer.dispose(); await waiting;
  await eventually(() => f.service.manager.getCall('c1').owner === undefined);
  assert.equal(p.operations.clear, 1); assert.equal(p.operations.stop, 0); assert.equal(f.service.manager.getCall('c1').state, 'connected');
  assert.throws(() => controller.claim('c1'), /释放/);
  const next = f.service.controller(f.scope().ctx, 'next'); next.claim('c1'); assert.equal(f.service.manager.getCall('c1').owner, 'next');
});

test('RTC plugin disposal removes only its own console listeners and subscriptions', async t => {
  const f = await fixture(t), p = providerFixture(); await f.service.register(f.scope().ctx, p.provider);
  const console = f.console, replacement = { callback() { return 'replacement'; }, authority: 4 };
  console.listeners['rtc/status'] = replacement;
  const manager = f.service.manager; assert.equal(p.events.listenerCount('event'), 1); assert.ok(manager.listenerCount('call') > 0);
  f.rtcScope.dispose(); await eventually(() => p.operations.stop === 1 && manager.eventNames().length === 0);
  assert.equal(console.listeners['rtc/status'], replacement); for (const name of rpcNames.slice(1)) assert.equal(console.listeners[name], undefined);
  assert.equal(p.events.listenerCount('event'), 0); assert.equal(manager.listProviders().length, 0); assert.equal(f.app.rtc, undefined);
  delete console.listeners['rtc/status'];
  // The same plugin can be loaded again without stale handler/controller state.
  f.app.plugin(plugin, { bridges: [], discord: [], historyLimit: 20 });
  await eventually(() => Boolean(f.app.rtc && console.listeners['rtc/status'])); assert.notEqual(f.app.rtc, f.service);
});

test('provider scope disposal fails its call, ends readers and removes its console lookup', async t => {
  const f = await fixture(t), p = providerFixture(), owner = f.scope(); await f.service.register(owner.ctx, p.provider);
  const controller = f.service.controller(f.scope().ctx, 'consumer'); controller.claim('c1'); const reader = controller.audio('c1')[Symbol.asyncIterator](); const waiting = reader.next();
  owner.dispose(); assert.equal((await waiting).done, true); await eventually(() => p.operations.stop === 1);
  assert.equal(f.service.manager.getCall('c1').state, 'failed'); assert.equal(f.service.manager.getCall('c1').owner, undefined); assert.equal(p.events.listenerCount('event'), 0);
  const client = f.connect(); client.client.auth = { authority: 4, expiredAt: Date.now() + 60000 };
  assert.deepEqual((await client.rpc('rtc/channels', 'p')).value, []);
});

test('manual provider removal clears service lookup and an old scope cannot remove its replacement', async t => {
  const f = await fixture(t), old = providerFixture(), oldScope = f.scope(); const remove = await f.service.register(oldScope.ctx, old.provider);
  const client = f.connect(); client.client.auth = { authority: 4, expiredAt: Date.now() + 60000 };
  assert.equal((await client.rpc('rtc/channels', 'p')).value[0].id, 'c1'); await remove();
  assert.deepEqual((await client.rpc('rtc/channels', 'p')).value, []);
  const next = providerFixture('p', 'replacement'); await f.service.register(f.scope().ctx, next.provider);
  oldScope.dispose(); await tick(); await remove();
  assert.equal(f.service.manager.listProviders().length, 1); assert.equal(next.operations.stop, 0);
  assert.equal((await client.rpc('rtc/channels', 'p')).value[0].id, 'replacement');
});

test('provider startup completing after its consumer scope unload cannot leak registration', async t => {
  const f = await fixture(t), p = providerFixture(), owner = f.scope(), gate = deferred();
  p.provider.start = () => gate.promise;
  const registration = f.service.register(owner.ctx, p.provider); const rejected = assert.rejects(registration);
  owner.dispose(); gate.resolve(); await rejected;
  await eventually(() => f.service.manager.listProviders().length === 0 && p.operations.stop > 0, 'late provider survived consumer unload');
  assert.equal(p.events.listenerCount('event'), 0);
});

function videoProviderFixture() {
  const p = providerFixture(), tracks = new Map<string, VideoTrack>();
  const operations = { subscribes: 0, unsubscribes: 0, clears: 0, sends: 0, stops: 0, hangs: 0 };
  let sending: VideoState['sending'] = {};
  p.publish({ participants: [{ id: 'peer', name: 'Remote participant', identity: 'platform' }] });
  const state = (): VideoState => ({ callId: 'c1', supported: true, tracks: [...tracks.values()], sending: { ...sending } });
  Object.assign(p.provider, {
    videoState: async () => state(), videoSources: async () => [{ id: 'chosen-camera', kind: 'camera', name: 'Explicit camera' }],
    subscribeVideo: async (_id: string, request: { participantId: string; kind: 'camera' | 'screen' }) => {
      operations.subscribes++; const track: VideoTrack = { ...request, trackId: `${request.kind}:${request.participantId}`, subscribed: true, available: true, hasFrame: false };
      tracks.set(track.trackId, track); return track;
    },
    unsubscribeVideo: async (_id: string, trackId: string) => { operations.unsubscribes++; tracks.delete(trackId); },
    clearVideo: async () => { operations.clears++; tracks.clear(); sending = {}; },
    sendVideo: async (_id: string, request: { kind: 'camera' | 'screen'; sourceId: string }) => { operations.sends++; sending[request.kind] = { ...request, state: 'sending', evidence: 'native-send-start-acknowledged' }; return state(); },
    stopVideo: async (_id: string, kind: 'camera' | 'screen') => { operations.stops++; delete sending[kind]; return state(); },
    hangup: async () => { operations.hangs++; p.publish({ state: 'ended' }); },
  });
  const emit = (sequence = 0) => {
    const video: VideoFrame = { callId: 'c1', trackId: 'camera:peer', participantId: 'peer', kind: 'camera', encoding: 'jpeg', width: 2, height: 2, sequence, timestamp: Date.now(), evidence: 'native-first-frame-and-render-capture', data: new Uint8Array([255,216,sequence % 256,255,217]) };
    p.events.emit('event', { type: 'video', video }); return video;
  };
  return { ...p, videoOperations: operations, tracks, state, emit };
}
const loggedIn = (client: ReturnType<Awaited<ReturnType<typeof fixture>>['connect']>) => { client.client.auth = { authority: 4, expiredAt: Date.now() + 60000 }; return client; };
const videoArgs = { callId: 'c1', participantId: 'peer', kind: 'camera' };

test('console video validates actions before claiming and does not expose another controller preview', async t => {
  const f = await fixture(t), p = videoProviderFixture(); await f.service.register(f.scope().ctx, p.provider);
  const first = loggedIn(f.connect()), second = loggedIn(f.connect());
  for (const [action, args] of [['unknown', videoArgs], ['subscribe', null], ['send', { callId: 'c1', kind: 'camera', sourceId: '' }], ['subscribe', { ...videoArgs, kind: 'invalid' }]] as const) {
    assert.ok((await first.rpc('rtc/video', action, args)).error); assert.equal(f.service.manager.getCall('c1').owner, undefined);
  }
  const response = await first.rpc('rtc/video', 'subscribe', videoArgs); assert.equal(response.error, undefined); assert.equal(response.value.trackId, 'camera:peer');
  const video = p.emit(); await tick(); const result = await first.rpc('rtc/video', 'frame', { callId: 'c1', trackId: 'camera:peer' });
  assert.equal(result.value.frame.data, Buffer.from(video.data).toString('base64')); assert.equal(result.value.frame.participantId, 'peer');
  for (const action of ['frame', 'unsubscribe', 'stop', 'state', 'send']) {
    assert.ok((await second.rpc('rtc/video', action, { ...videoArgs, trackId: 'camera:peer', sourceId: 'chosen-camera' })).error);
  }
  assert.equal(p.videoOperations.unsubscribes, 0); assert.equal(p.videoOperations.stops, 0); assert.equal(p.videoOperations.sends, 0);
});

test('console validates camera framing before claiming and passes an explicit valid mode', async t => {
  const f = await fixture(t), p = videoProviderFixture();
  p.provider.videoSources = async () => [{ id: 'external-frames', name: 'Frames', kind: 'camera', sourceType: 'frames' }];
  await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  for (const invalid of [
    { kind: 'screen', sourceId: 'external-frames', framing: 'full' },
    { kind: 'camera', sourceId: 'chosen-camera', framing: 'portrait-safe' },
    { kind: 'camera', sourceId: 'external-frames', framing: 'stretch' },
    { kind: 'camera', sourceId: 'external-frames', framing: ['full'] },
  ]) {
    assert.ok((await client.rpc('rtc/video', 'send', { callId: 'c1', ...invalid })).error);
    assert.equal(f.service.manager.getCall('c1').owner, undefined);
  }
  const result = await client.rpc('rtc/video', 'send', { callId: 'c1', kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe' });
  assert.equal(result.error, undefined); assert.equal(result.value.sending.camera.framing, 'portrait-safe');
});

test('console stopping preview clears its frame and unsubscribes exactly once without hanging up', async t => {
  const f = await fixture(t), p = videoProviderFixture(); await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  await client.rpc('rtc/video', 'subscribe', videoArgs); p.emit(); await tick();
  assert.equal((await client.rpc('rtc/video', 'unsubscribe', { callId: 'c1', trackId: 'camera:peer' })).error, undefined);
  const response = await client.rpc('rtc/video', 'frame', { callId: 'c1', trackId: 'camera:peer' });
  assert.equal(response.value.frame, null); assert.equal(response.value.ended, true);
  assert.equal(p.videoOperations.unsubscribes, 1); assert.equal(p.videoOperations.hangs, 0); assert.equal(f.service.manager.getCall('c1').state, 'connected');
});

test('console release clears receive/send video and delayed cleanup cannot reclaim the lease', async t => {
  const f = await fixture(t), p = videoProviderFixture(); await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  await client.rpc('rtc/video', 'subscribe', videoArgs); await client.rpc('rtc/video', 'send', { callId: 'c1', kind: 'camera', sourceId: 'chosen-camera' }); p.emit(); await tick();
  assert.equal((await client.rpc('rtc/control', 'release', { callId: 'c1' })).error, undefined);
  assert.equal(p.videoOperations.clears, 1); assert.equal(p.tracks.size, 0); assert.deepEqual(p.state().sending, {});
  for (const action of ['frame', 'unsubscribe', 'stop']) {
    assert.match((await client.rpc('rtc/video', action, { ...videoArgs, trackId: 'camera:peer' })).error, /控制权已释放/);
    assert.equal(f.service.manager.getCall('c1').owner, undefined);
  }
  assert.equal(p.videoOperations.hangs, 0); assert.equal(f.service.manager.getCall('c1').state, 'connected');
  await client.rpc('rtc/video', 'subscribe', videoArgs);
  assert.equal((await client.rpc('rtc/video', 'frame', { callId: 'c1', trackId: 'camera:peer' })).value.frame, null, 'new lease must not inherit cached JPEG');
});

test('console disconnect during native video subscription cleans its late result without hangup', async t => {
  const f = await fixture(t), p = videoProviderFixture(), gate = deferred(); let entered = false;
  const original = p.provider.subscribeVideo!;
  p.provider.subscribeVideo = async (...args) => { entered = true; await gate.promise; return original(...args); };
  await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  const pending = client.rpc('rtc/video', 'subscribe', videoArgs); await eventually(() => entered);
  client.socket.close(); gate.resolve(); assert.ok((await pending).error);
  await eventually(() => f.service.manager.getCall('c1').owner === undefined);
  assert.equal(p.tracks.size, 0); assert.equal(p.videoOperations.clears, 1); assert.equal(p.videoOperations.hangs, 0); assert.equal(f.service.manager.getCall('c1').state, 'connected');
});

test('console video rechecks auth after native send and revokes expired session before returning', async t => {
  const f = await fixture(t), p = videoProviderFixture(), gate = deferred(); let entered = false;
  const original = p.provider.sendVideo!;
  p.provider.sendVideo = async (...args) => { entered = true; await gate.promise; return original(...args); };
  await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  const pending = client.rpc('rtc/video', 'send', { callId: 'c1', kind: 'camera', sourceId: 'chosen-camera' }); await eventually(() => entered);
  client.client.auth.expiredAt = Date.now() - 1; gate.resolve(); assert.match((await pending).error, /权限等级 4/);
  await eventually(() => f.service.manager.getCall('c1').owner === undefined);
  assert.deepEqual(p.state().sending, {}); assert.equal(p.videoOperations.clears, 1); assert.equal(p.videoOperations.hangs, 0);
});

test('RTC service unload releases active console video and removes its RPC listener', async t => {
  const f = await fixture(t), p = videoProviderFixture(); await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  await client.rpc('rtc/video', 'subscribe', videoArgs); await client.rpc('rtc/video', 'send', { callId: 'c1', kind: 'camera', sourceId: 'chosen-camera' }); p.emit(); await tick();
  f.rtcScope.dispose(); await eventually(() => p.operations.stop === 1 && f.console.listeners['rtc/video'] === undefined);
  assert.equal(p.tracks.size, 0); assert.deepEqual(p.state().sending, {}); assert.equal(p.videoOperations.hangs, 0);
});

test('console preserves explicit video/screen invitations while ordinary dialing remains audio by default', async t => {
  const f = await fixture(t), p = providerFixture(); p.publish({ state: 'ended' }); const requests: any[] = [];
  p.provider.dial = async request => { requests.push(request); return { ...p.provider.calls()[0]!, id: `outgoing-${requests.length}`, direction: 'outgoing', state: 'dialing', targetId: request.targetId }; };
  await f.service.register(f.scope().ctx, p.provider); const client = loggedIn(f.connect());
  const screen = await client.rpc('rtc/control', 'dial', { providerId: 'p', kind: 'direct', targetId: 'peer', media: 'screen' });
  assert.equal(screen.error, undefined); assert.equal(requests[0].media, 'screen');
  p.events.emit('event', { type: 'call', call: { ...screen.value, state: 'ended' } });
  const groupVideo = await client.rpc('rtc/control', 'dial', { providerId: 'p', kind: 'group', targetId: 'group', media: 'video' });
  assert.ok(groupVideo.error); assert.equal(requests.length, 1);
  const video = await client.rpc('rtc/control', 'dial', { providerId: 'p', kind: 'direct', targetId: 'peer', media: 'video' });
  assert.equal(video.error, undefined); assert.equal(requests[1].media, 'video');
  p.events.emit('event', { type: 'call', call: { ...video.value, state: 'ended' } });
  const audio = await client.rpc('rtc/control', 'dial', { providerId: 'p', kind: 'direct', targetId: 'peer' });
  assert.equal(audio.error, undefined); assert.equal(requests[2].media, undefined);
});
