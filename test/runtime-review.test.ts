import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { RtcManager, unavailableCapabilities, type CallProvider, type CallSnapshot, type AudioFrame } from '../src/core.js';
import { DesktopBridgeProvider } from '../src/providers/bridge.js';
// @ts-expect-error standalone bridge intentionally uses plain Node ESM
import { createDaemon, QqControl } from '../bridge/daemon.mjs';

const token = 'runtime-review-'.repeat(5);
const pcm: AudioFrame = { callId: 'c1', data: new Uint8Array(1920), sampleRate: 48000, channels: 1, encoding: 'pcm_s16le', sequence: 0, timestamp: 1 };
const allCaps = () => Object.fromEntries(Object.keys(unavailableCapabilities()).map(key => [key, { supported: true }])) as any;
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const eventually = async (fn: () => boolean) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('condition timed out'); };
const call = (id = 'c1', state = 'connected'): any => ({ id, kind: 'direct', direction: 'incoming', targetId: '2', state, createdAt: 1, updatedAt: 1, participants: [], muted: false });
function coreFixture() {
  const manager = new RtcManager(), events = new EventEmitter();
  let current: CallSnapshot = { ...call(), providerId: 'p', account: { platform: 'test', selfId: '1' } };
  const publish = (patch: Partial<CallSnapshot>) => { current = { ...current, ...patch }; events.emit('event', { type: 'call', call: current }); };
  const provider: CallProvider = { id: 'p', account: current.account, events, capabilities: allCaps, start: async () => {}, stop: async () => {}, calls: () => [current], dial: async () => current,
    accept: async () => {}, reject: async () => {}, hangup: async () => {}, setMuted: async () => {}, clearAudio: async () => {}, diagnostics: async () => [],
    writeAudio: async (frame, id) => ({ id, callId: frame.callId, acceptedBytes: frame.data.length, playedBytes: 0, state: 'queued' }) };
  return { manager, provider, publish };
}

test('return() cancels an already pending audio read immediately', { timeout: 2000 }, async () => {
  const f = coreFixture(); await f.manager.register(f.provider); const owner = f.manager.controller('reader'); owner.claim('c1');
  const reader = owner.audio('c1')[Symbol.asyncIterator](), waiting = reader.next();
  try { assert.equal((await reader.return!()).done, true); assert.equal((await waiting).done, true); }
  finally { await f.manager.dispose(); }
});

test('release revokes queued writes and waits for the previous write before clearing', async () => {
  const f = coreFixture(), gate = deferred(); let writes = 0, cleared = 0, firstByte = -1;
  f.provider.writeAudio = async (frame, id) => { writes++; firstByte = frame.data[0]!; await gate.promise; return { id, callId: frame.callId, acceptedBytes: frame.data.length, playedBytes: 0, state: 'queued' }; };
  f.provider.clearAudio = async () => { cleared++; };
  await f.manager.register(f.provider); const a = f.manager.controller('a'), b = f.manager.controller('b'); a.claim('c1');
  const data = new Uint8Array(1920); data[0] = 4;
  const first = a.writeAudio('c1', { ...pcm, data }); data[0] = 99;
  await eventually(() => writes === 1);
  const second = assert.rejects(a.writeAudio('c1', pcm), (e: any) => e.code === 'NOT_CONTROLLER');
  const release = a.release('c1');
  assert.throws(() => a.writeAudio('c1', pcm), (e: any) => e.code === 'NOT_CONTROLLER');
  assert.throws(() => b.claim('c1'), (e: any) => e.code === 'CALL_BUSY');
  assert.equal(cleared, 0); gate.resolve(); await Promise.all([first, second, release]);
  assert.equal(firstByte, 4); assert.equal(writes, 1); assert.equal(cleared, 1); b.claim('c1'); await f.manager.dispose();
});

test('failed registration revokes emitted calls and an old unregister handle cannot stop a replacement', async () => {
  const f = coreFixture();
  f.provider.start = async () => { f.publish({ state: 'connected' }); throw new Error('startup failed'); };
  await assert.rejects(f.manager.register(f.provider), /startup failed/); assert.equal(f.manager.getCall('c1').state, 'failed');
  f.provider.start = async () => {}; const cleanup = await f.manager.register(f.provider); await f.manager.unregister('p');
  const replacement = { ...f.provider, events: new EventEmitter(), calls: () => [] }; await f.manager.register(replacement); await cleanup();
  assert.equal(f.manager.listProviders().length, 1); await f.manager.dispose();
});

async function providerFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address() as any;
  const provider = new DesktopBridgeProvider({ id: 'p', url: `ws://127.0.0.1:${address.port}`, token, selfId: '1', platform: 'test' });
  const connection = once(server, 'connection'); await provider.start(); const [socket] = await connection as [WebSocket];
  const send = (packet: object) => socket.send(JSON.stringify(packet));
  const hello = (calls: any[] = []) => send({ type: 'hello', version: 1, account: { platform: 'test', selfId: '1' }, capabilities: allCaps(), audioFormat: { sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' }, calls });
  const close = async () => { await provider.stop(); socket.terminate(); await new Promise<void>(r => server.close(() => r())); };
  return { provider, socket, send, hello, close };
}

test('bridge ignores call data before identity verification and fails closed on identity changes', async () => {
  const f = await providerFixture();
  try {
    f.send({ type: 'call', call: call() }); await new Promise(r => setTimeout(r, 10)); assert.equal(f.provider.calls().length, 0);
    f.hello([call()]); await eventually(() => f.provider.calls().length === 1); assert.equal(f.provider.capabilities().dial.supported, true);
    f.send({ type: 'status', version: 1, account: { platform: 'test', selfId: 'other' }, calls: [call()] });
    await eventually(() => !f.provider.capabilities().dial.supported); assert.equal(f.provider.calls()[0]!.state, 'failed');
    await assert.rejects(f.provider.hangup(f.provider.calls()[0]!.id), /结束|旧连接/);
  } finally { await f.close(); }
});

test('authoritative empty bridge snapshots close missing calls and reject malformed PCM', async () => {
  const f = await providerFixture(); let received = 0;
  f.provider.events.on('event', e => { if (e.type === 'audio') received++; });
  try {
    f.hello([call()]); await eventually(() => f.provider.calls().length === 1);
    f.send({ type: 'audio', frame: { ...pcm, data: '!!!=', encoding: 'pcm_s16le' } });
    f.send({ type: 'audio', frame: { ...pcm, data: Buffer.alloc(1920).toString('base64'), encoding: 'opus' } });
    f.hello([]); await eventually(() => f.provider.calls()[0]!.state === 'failed'); assert.equal(received, 0);
  } finally { await f.close(); }
});

test('bridge abort releases pending requests promptly without resubmitting a mutation', async () => {
  const f = await providerFixture(), requests: any[] = [];
  f.socket.on('message', data => requests.push(JSON.parse(data.toString())));
  try {
    f.hello([call('c1', 'ringing')]); await eventually(() => f.provider.calls().length === 1);
    const abort = new AbortController(); const pending = f.provider.accept(f.provider.calls()[0]!.id, abort.signal);
    const rejected = assert.rejects(pending, (e: any) => e.code === 'ABORTED_UNKNOWN');
    await eventually(() => requests.length === 1); abort.abort(); await rejected;
    assert.equal((f.provider as any).pending.size, 0); assert.equal(requests.length, 1);
  } finally { await f.close(); }
});

async function daemonFixture(options: { persistAudio?: (settings: any) => Promise<void>; prepare?: (audio: any, control: any) => void } = {}) {
  const control: any = new EventEmitter(); control.calls = new Map(); control.caps = allCaps(); control.notices = []; control.start = async () => {}; control.stop = async () => {};
  control.update = (c: any) => { control.calls.set(c.id, c); control.emit('call', c); };
  control.control = async (op: string, args: any) => { const c = op === 'dial' ? call('dialed', 'dialing') : { ...control.calls.get(args.callId), state: op === 'accept' ? 'connected' : 'ended' }; control.update(c); return c; };
  control.channels = async () => [];
  const audio: any = new EventEmitter(); audio.config = { sampleRate: 48000, channels: 1, inputDevice: 'in', outputDevice: 'out' }; audio.running = false; audio.starts = 0; audio.stops = 0; audio.writes = [];
  audio.listDevices = async () => [{ id: 'new-in', direction: 'input' }, { id: 'new-out', direction: 'output' }];
  audio.diagnostics = async () => [{ id: 'audio', level: 'ok', message: 'fixture only' }];
  audio.start = async () => { audio.running = true; audio.starts++; }; audio.stop = async () => { audio.running = false; audio.stops++; };
  audio.setMuted = async (value: boolean) => { audio.muted = value; }; audio.clear = async () => {};
  audio.write = async (bytes: Buffer, id: string) => { audio.writes.push(id); return { id, acceptedBytes: bytes.length, playedBytes: 0, state: 'queued' }; };
  options.prepare?.(audio, control);
  const config = { host: '127.0.0.1', port: 0, token, account: { platform: 'test', selfId: '1' }, audio: { ...audio.config } };
  const daemon = await createDaemon(config, { control, audio, ...options }); const address = await daemon.start();
  const clients: WebSocket[] = [];
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream`, { headers: { Authorization: `Bearer ${token}` } }); clients.push(socket);
    const packets: any[] = []; socket.on('message', data => packets.push(JSON.parse(data.toString()))); socket.on('error', () => {}); await once(socket, 'open'); await eventually(() => packets.some(p => p.type === 'hello'));
    let id = 0;
    const request = async (op: string, args: any = {}, requestId = String(++id)) => {
      const index = packets.length; socket.send(JSON.stringify({ type: 'request', id: requestId, op, args }));
      await eventually(() => packets.slice(index).some(p => p.type === 'reply' && p.id === requestId));
      return packets.slice(index).find(p => p.type === 'reply' && p.id === requestId);
    };
    return { socket, packets, request };
  };
  const http = async (path: string) => (await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<any>;
  const close = async () => { for (const socket of clients) socket.terminate(); await daemon.stop(); };
  return { control, audio, config, daemon, connect, http, close };
}

test('audio startup finishing after owner disconnect is stopped before a new owner can use it', async () => {
  const f = await daemonFixture(), gate = deferred(); let started = false;
  f.audio.start = async () => { started = true; await gate.promise; f.audio.running = true; };
  f.control.update(call()); const a = await f.connect(); await eventually(() => started);
  const closed = once(a.socket, 'close'); a.socket.terminate(); await closed; gate.resolve();
  try { await eventually(() => f.audio.stops > 0); assert.equal(f.audio.running, false); }
  finally { await f.close(); }
});

test('control submission and audio configuration cannot interleave', async () => {
  let saved = 0; const f = await daemonFixture({ persistAudio: async () => { saved++; } }), gate = deferred(); let submitting = false;
  f.control.control = async () => { submitting = true; await gate.promise; const c = call('new', 'dialing'); f.control.update(c); return c; };
  const client = await f.connect(); const dial = client.request('dial', { kind: 'direct', targetId: '2' }); await eventually(() => submitting);
  const configure = client.request('audio.configure', { inputDevice: 'new-in', outputDevice: 'new-out' }); gate.resolve();
  try { assert.equal((await dial).ok, true); const reply = await configure; assert.equal(reply.error.code, 'CALL_BUSY'); assert.equal(saved, 0); }
  finally { await f.close(); }
});

test('incoming call or revoked owner during device enumeration prevents configuration writes', async () => {
  for (const revoke of [false, true]) {
    let saved = 0; const f = await daemonFixture({ persistAudio: async () => { saved++; } }), gate = deferred<any[]>(); let enumerating = false;
    f.audio.listDevices = async () => { enumerating = true; return gate.promise; };
    const client = await f.connect();
    client.socket.send(JSON.stringify({ type: 'request', id: 'config', op: 'audio.configure', args: { inputDevice: 'new-in', outputDevice: 'new-out' } }));
    await eventually(() => enumerating);
    if (revoke) { const closed = once(client.socket, 'close'); client.socket.terminate(); await closed; }
    else f.control.update(call('incoming', 'ringing'));
    gate.resolve([{ id: 'new-in', direction: 'input' }, { id: 'new-out', direction: 'output' }]);
    try {
      if (!revoke) { await eventually(() => client.packets.some(p => p.id === 'config')); assert.equal(client.packets.find(p => p.id === 'config').error.code, 'CALL_BUSY'); }
      await f.daemon.stop(); assert.equal(saved, 0); assert.equal(f.config.audio.inputDevice, 'in');
    } finally { await f.close(); }
  }
});

test('a mute reply after call end cannot resurrect the call', async () => {
  const f = await daemonFixture(); f.control.update(call()); const client = await f.connect(); await eventually(() => f.audio.running);
  const gate = deferred(); let muting = false; f.audio.setMuted = async () => { muting = true; await gate.promise; };
  const pending = client.request('mute', { callId: 'c1', muted: true }); await eventually(() => muting); f.control.update(call('c1', 'ended')); gate.resolve();
  try { assert.equal((await pending).error.code, 'STALE_CALL'); assert.equal(f.control.calls.get('c1').state, 'ended'); }
  finally { await f.close(); }
});

test('runtime audio failures remain unavailable through HTTP diagnostics, and explicit retry restores media', async () => {
  const f = await daemonFixture(); f.control.update(call()); const client = await f.connect(); await eventually(() => f.audio.running);
  try {
    f.audio.emit('error', new Error('worker exited')); await eventually(() => !f.audio.running);
    assert.equal((await f.http('/v1/status')).capabilities.sendAudio.supported, false);
    await f.http('/v1/diagnostics'); assert.equal((await f.http('/v1/status')).capabilities.sendAudio.supported, false); assert.equal(f.audio.running, false);
    assert.equal((await client.request('diagnostics')).ok, true); await eventually(() => f.audio.running);
    assert.equal((await f.http('/v1/status')).capabilities.sendAudio.supported, true);
  } finally { await f.close(); }
});

test('late audio devices become available without a console diagnostics request', async () => {
  let ready = false, checks = 0;
  const f = await daemonFixture({ prepare(audio) { audio.diagnostics = async () => { checks++; return [{ id: 'device', level: ready ? 'ok' : 'error', message: ready ? 'ready' : 'private server not ready' }]; }; } });
  try {
    const client = await f.connect();
    assert.equal((await f.http('/v1/status')).capabilities.sendAudio.supported, false);
    ready = true;
    await new Promise(resolve => setTimeout(resolve, 1150));
    await eventually(() => client.packets.some(p => p.type === 'status' && p.capabilities.sendAudio.supported));
    assert.equal(f.audio.starts, 0, 'device discovery must not capture outside a call');
    assert.ok(checks >= 3);
    f.control.update(call()); await eventually(() => f.audio.running);
  } finally { await f.close(); }
});

test('worker recovery keeps a connected call muted and does not replay failed audio', async () => {
  const f = await daemonFixture(); f.control.update({ ...call(), muted: true }); await f.connect(); await eventually(() => f.audio.running);
  try {
    f.audio.emit('error', new Error('worker exited')); await eventually(() => !f.audio.running);
    await new Promise(resolve => setTimeout(resolve, 1150)); await eventually(() => f.audio.running);
    assert.equal(f.audio.muted, true); assert.equal(f.audio.writes.length, 0);
    assert.equal((await f.http('/v1/status')).capabilities.sendAudio.supported, true);
  } finally { await f.close(); }
});

test('daemon validates PCM, rejects conflicting request IDs and isolates late playback across calls', async () => {
  const f = await daemonFixture(); f.control.update(call()); const client = await f.connect(); await eventually(() => f.audio.running);
  const frame = { ...pcm, data: Buffer.alloc(1920).toString('base64') };
  try {
    for (const patch of [{ data: '!!!!' }, { sequence: -1 }, { timestamp: null }, { encoding: 'opus' }]) assert.equal((await client.request('audio.write', { frame: { ...frame, ...patch }, playbackId: 'x' })).error.code, 'INVALID_AUDIO');
    const first = await client.request('audio.write', { frame, playbackId: 'same' }, 'stable'); assert.equal(first.data.id, 'same'); assert.equal(f.audio.writes.length, 1);
    const duplicate = await client.request('audio.write', { frame, playbackId: 'same' }, 'stable'); assert.deepEqual(duplicate, first); assert.equal(f.audio.writes.length, 1);
    assert.equal((await client.request('mute', { callId: 'c1', muted: true }, 'stable')).error.code, 'REQUEST_ID_REUSED');
    const nativeId = f.audio.writes[0]; f.control.update(call('c1', 'ended')); await eventually(() => !f.audio.running);
    f.control.update(call('c2')); await eventually(() => f.audio.running);
    await client.request('audio.write', { frame: { ...frame, callId: 'c2' }, playbackId: 'same' });
    f.audio.emit('playback', { id: nativeId, state: 'played', acceptedBytes: 1920, playedBytes: 1920 });
    f.audio.emit('playback', { id: f.audio.writes[1], state: 'played', acceptedBytes: 1920, playedBytes: 1920 });
    await eventually(() => client.packets.some(p => p.type === 'playback'));
    const receipts = client.packets.filter(p => p.type === 'playback'); assert.equal(receipts.length, 1); assert.equal(receipts[0].receipt.callId, 'c2'); assert.equal(receipts[0].receipt.id, 'same');
  } finally { await f.close(); }
});

test('daemon stop still closes audio and server when control shutdown fails', async () => {
  const f = await daemonFixture(); f.control.update(call()); await f.connect(); await eventually(() => f.audio.running);
  f.control.stop = async () => { throw new Error('stop failed'); };
  await assert.rejects(f.daemon.stop(), /stop failed/); assert.equal(f.audio.running, false); assert.equal(f.daemon.server.listening, false);
});

test('QQ polling uses identity-tagged snapshots and does not revive replayed historical calls', async () => {
  const control = new QqControl({ selfId: '1' });
  let current: any = { id: 'live', kind: 'private', phase: 'connected', direction: 'incoming', callerUin: '2' };
  let selfId = '1', bootId = 'boot', posts = 0;
  control.request = async (route: string, body: any) => {
    if (body) { posts++; return {}; }
    if (route === '/v1/capabilities') return { selfId, bootId, capabilities: { 'private.accept': { status: 'supported' }, 'private.hangup': { status: 'supported' } } };
    if (route === '/v1/status') return { selfId, bootId, call: current };
    return { bootId, nextSeq: 10, gap: true, events: [{ type: 'call.state', call: { ...current, id: 'historical', kind: 'private', phase: 'connected' } }] };
  };
  try {
    await control.start(); assert.equal([...control.calls.values()].filter((c: any) => c.state === 'connected').length, 1);
    clearTimeout(control.timer); current = null; await control.poll(); assert.equal([...control.calls.values()].filter((c: any) => c.state === 'connected').length, 0);
    clearTimeout(control.timer); current = { id: 'live-2', kind: 'private', phase: 'ringing', callerUin: '2' }; await control.poll();
    const ringing: any = [...control.calls.values()].find((c: any) => c.state === 'ringing'); selfId = 'other';
    await assert.rejects(control.control('accept', { callId: ringing.id }, 'request'), (e: any) => e.code === 'ACCOUNT_MISMATCH'); assert.equal(posts, 0); assert.equal(control.calls.get(ringing.id).state, 'failed');
  } finally { await control.stop(); }
});

test('late polling after stop cannot restore QQ capabilities', async () => {
  const control = new QqControl({ selfId: '1' }), gate = deferred();
  control.request = async () => { await gate.promise; throw new Error('late fetch'); };
  const start = control.start(); await control.stop(); const notices = structuredClone(control.notices); gate.resolve(); await start;
  assert.deepEqual(control.notices, notices); assert.equal(control.caps.accept.supported, false); assert.equal(control.timer, undefined);
});

test('manager bounds blocked operation queues while always allowing ownership cleanup', async () => {
  const f = coreFixture(), gate = deferred(); let writes = 0, cleared = false;
  f.provider.writeAudio = async (frame, id) => { writes++; await gate.promise; return { id, callId: frame.callId, acceptedBytes: frame.data.length, playedBytes: 0, state: 'queued' }; };
  f.provider.clearAudio = async () => { cleared = true; };
  await f.manager.register(f.provider); const owner = f.manager.controller('queue'); owner.claim('c1');
  const first = owner.writeAudio('c1', pcm); await eventually(() => writes === 1);
  const queued = Array.from({ length: 127 }, () => assert.rejects(owner.writeAudio('c1', pcm), (e: any) => e.code === 'NOT_CONTROLLER'));
  await assert.rejects(owner.writeAudio('c1', pcm), (e: any) => e.code === 'BACKPRESSURE');
  const release = owner.release('c1'); gate.resolve(); await Promise.all([first, ...queued, release]); assert.equal(cleared, true); assert.equal(writes, 1); await f.manager.dispose();
});

test('disconnect interrupts a blocked audio worker before awaiting its pending write', async () => {
  const f = await daemonFixture(); f.control.update(call()); const client = await f.connect(); await eventually(() => f.audio.running);
  const gate = deferred(); let writing = false;
  f.audio.write = async (bytes: Buffer, id: string) => { writing = true; await gate.promise; return { id, acceptedBytes: bytes.length, playedBytes: 0, state: 'queued' }; };
  client.socket.send(JSON.stringify({ type: 'request', id: 'write', op: 'audio.write', args: { frame: { ...pcm, data: Buffer.alloc(1920).toString('base64') }, playbackId: 'pending' } }));
  await eventually(() => writing); const closed = once(client.socket, 'close'); client.socket.terminate(); await closed;
  try { await eventually(() => f.audio.stops > 0); assert.equal(f.audio.running, false); }
  finally { gate.resolve(); await f.close(); }
});

test('configuration interrupted during persistence restores the prior file settings', async () => {
  const gate = deferred(); const saved: any[] = [];
  const f = await daemonFixture({ persistAudio: async settings => { saved.push({ ...settings }); if (saved.length === 1) await gate.promise; } });
  const client = await f.connect(); const pending = client.request('audio.configure', { inputDevice: 'new-in', outputDevice: 'new-out' });
  await eventually(() => saved.length === 1); f.control.update(call('incoming', 'ringing')); gate.resolve();
  try { assert.equal((await pending).error.code, 'CALL_BUSY'); assert.equal(saved.length, 2); assert.equal(saved[1].inputDevice, 'in'); assert.equal(f.config.audio.inputDevice, 'in'); }
  finally { await f.close(); }
});

test('a poll started before failed identity verification cannot restore the old session', async () => {
  const control = new QqControl({ selfId: '1' });
  const cap = { selfId: '1', bootId: 'boot', capabilities: { 'private.accept': { status: 'supported' } } };
  control.request = async (route: string) => route === '/v1/capabilities' ? cap : route === '/v1/status' ? { selfId: '1', bootId: 'boot', call: null } : { bootId: 'boot', events: [], nextSeq: 0 };
  await control.start(); clearTimeout(control.timer);
  const gate = deferred(); const request = control.request;
  control.request = async (route: string) => { await gate.promise; return request(route); };
  const poll = control.poll(); control.fail('identity changed'); gate.resolve(); await poll;
  try { assert.equal(control.offline, true); assert.equal(control.caps.accept.supported, false); }
  finally { await control.stop(); }
});

test('QQ mutations cancelled during identity verification are never submitted', async () => {
  const control = new QqControl({ selfId: '1' }), gate = deferred(); let posts = 0;
  control.stopped = false; control.offline = false; control.bootId = 'boot';
  control.request = async (_route: string, body: any) => { if (body) { posts++; return {}; } await gate.promise; return { selfId: '1', bootId: 'boot', capabilities: { 'private.dial': { status: 'supported' } } }; };
  const abort = new AbortController();
  const rejected = assert.rejects(control.control('dial', { kind: 'direct', targetId: '2' }, 'request', abort.signal), (e: any) => e.name === 'AbortError');
  abort.abort(); gate.resolve(); await rejected; assert.equal(posts, 0); assert.equal(control.offline, false); await control.stop();
});

test('QQ duplicate native snapshots preserve update times while real call fields still publish', async () => {
  const control = new QqControl({ selfId: '1' }); control.bootId = 'boot';
  const events: any[] = []; control.on('call', (call: any) => events.push(call));
  let native: any = { id: 'native', kind: 'private', direction: 'incoming', phase: 'ringing', inviteAt: '2026-01-01T00:00:00.000Z', participants: [{ uid: 'b' }, { uid: 'a' }] };
  control.ingest(native); const id = events[0].id;
  const repeat = async () => {
    const previous = control.calls.get(id), count = events.length;
    await new Promise(resolve => setTimeout(resolve, 3));
    for (let i = 0; i < 20; i++) control.ingest({ ...native, participants: [...native.participants].reverse() });
    // Reordered object keys and a supplied clock value are not a state change.
    control.update({ ...Object.fromEntries(Object.entries(previous).reverse()), updatedAt: Date.now() + 100 });
    assert.equal(events.length, count); assert.equal(control.calls.get(id), previous); assert.equal(control.calls.get(id).updatedAt, previous.updatedAt);
  };
  const change = async (patch: object) => {
    const count = events.length, before = control.calls.get(id).updatedAt;
    await new Promise(resolve => setTimeout(resolve, 3)); native = { ...native, ...patch }; control.ingest(native);
    assert.equal(events.length, count + 1); assert.ok(control.calls.get(id).updatedAt > before); await repeat();
  };
  await repeat();
  await change({ callerUid: 'resolved-uid' }); assert.equal(control.calls.get(id).targetId, 'resolved-uid');
  await change({ callerUin: '12345' }); assert.equal(control.calls.get(id).targetId, '12345');
  await change({ direction: 'outgoing', peerUid: 'peer-uid' });
  await change({ phase: 'connected' });
  await change({ participants: [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }] });
  await change({ participants: [{ uid: 'a' }] });
  const beforeMute = events.length; control.update({ ...control.calls.get(id), muted: true }); assert.equal(events.length, beforeMute + 1); await repeat(); assert.equal(control.calls.get(id).muted, true);
  await change({ phase: 'ended' }); const ended = control.calls.get(id);
  control.ingest({ ...native, phase: 'connected' }); assert.equal(control.calls.get(id), ended);
});

test('bridge status polling does not manufacture call changes or activity timestamps', async () => {
  const f = await providerFixture(), events: any[] = [];
  f.provider.events.on('event', event => events.push(event));
  let current: any = { ...call('remote', 'ringing'), createdAt: undefined, participants: [{ id: 'b', identity: 'platform' }, { id: 'a', identity: 'platform' }] };
  const status = () => f.send({ type: 'status', version: 1, account: { platform: 'test', selfId: '1' }, audioFormat: { sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' }, capabilities: allCaps(), calls: [current] });
  let barrier = 0;
  const flush = async () => { const marker = `barrier-${++barrier}`; f.send({ type: 'error', message: marker }); await eventually(() => events.some(event => event.type === 'error' && event.error === marker)); };
  const calls = () => events.filter(event => event.type === 'call');
  const repeat = async () => {
    const before = f.provider.calls()[0]!, count = calls().length;
    await new Promise(resolve => setTimeout(resolve, 3));
    for (let i = 0; i < 20; i++) { current = { ...current, updatedAt: Date.now() + i, participants: [...current.participants].reverse() }; status(); }
    await flush(); assert.equal(calls().length, count); assert.deepEqual(f.provider.calls()[0], before);
  };
  const change = async (patch: object) => {
    const count = calls().length, updatedAt = f.provider.calls()[0]!.updatedAt;
    await new Promise(resolve => setTimeout(resolve, 3)); current = { ...current, ...patch }; status(); await flush();
    assert.equal(calls().length, count + 1); assert.ok(f.provider.calls()[0]!.updatedAt > updatedAt); await repeat();
  };
  try {
    status(); await flush(); assert.equal(calls().length, 1); await repeat();
    await change({ targetId: 'resolved' }); await change({ direction: 'outgoing' }); await change({ kind: 'group' });
    await change({ state: 'connected' }); await change({ participants: [{ id: 'new-member', identity: 'platform' }] });
    await change({ muted: true }); await change({ muted: false }); await change({ state: 'ended' });
    const ended = f.provider.calls()[0], count = calls().length; current.state = 'connected'; status(); await flush();
    assert.equal(calls().length, count); assert.deepEqual(f.provider.calls()[0], ended);
  } finally { await f.close(); }
});

for (const kind of ['private', 'group'] as const) test(`native ${kind} failure stays actionable through daemon, provider and controller until teardown`, { timeout: 5000 }, async () => {
  const f = await daemonFixture(), manager = new RtcManager();
  const qq: any = new QqControl({ selfId: '1' });
  Object.assign(qq, { stopped: false, offline: false, bootId: 'native-boot', linkEpoch: 0 });
  f.control.calls = qq.calls;
  qq.on('call', (c: any) => f.control.update(c));
  f.control.control = (...args: any[]) => qq.control(...args);
  const caps = Object.fromEntries(['private.dial', 'private.hangup', 'group.join', 'group.leave'].map(key => [key, { status: 'supported' }]));
  let native: any = { id: 'native-call', kind, direction: 'outgoing', phase: 'connected', groupId: '23456', peerUin: '23456' };
  const cleanup: string[] = [];
  qq.request = async (route: string) => {
    if (route === '/v1/capabilities') return { selfId: '1', bootId: qq.bootId, capabilities: caps };
    if (route === '/v1/status') return { selfId: '1', bootId: qq.bootId, call: native };
    if (route === '/v1/groups/leave' || route === '/v1/calls/hangup') {
      cleanup.push(route); native = { ...native, phase: 'ending' }; qq.ingest(native);
      // A successful submission/ACK is deliberately not a teardown event.
      return { status: 'confirmed', callId: native.id };
    }
    if (route === '/v1/groups/join' || route === '/v1/calls/dial') {
      native = { ...native, id: 'next-native-call', phase: kind === 'group' ? 'joining' : 'calling', nativeTeardownUnknown: false, nativeAckTimedOut: false, nativeError: undefined };
      qq.ingest(native); return { callId: native.id };
    }
    throw new Error(`unexpected native route: ${route}`);
  };
  qq.ingest(native);
  const address = f.daemon.server.address() as any;
  const provider = new DesktopBridgeProvider({ id: 'p', url: `ws://127.0.0.1:${address.port}/v1/stream`, token, selfId: '1', platform: 'test' });
  await manager.register(provider);
  try {
    await eventually(() => manager.listCalls().length === 1 && f.audio.running);
    const id = manager.listCalls()[0]!.id, owner = manager.controller('operator'); owner.claim(id);
    const buffered = owner.audio(id)[Symbol.asyncIterator](); let levels = 0;
    manager.on('level', () => { levels++; });
    f.audio.emit('audio', pcm); await eventually(() => levels === 1);
    const pendingReader = owner.audio(id)[Symbol.asyncIterator](), pendingRead = pendingReader.next();
    native = { ...native, phase: 'error', nativeTeardownUnknown: true, nativeError: 'Native connection timed out' }; qq.ingest(native);
    await eventually(() => manager.getCall(id).state === 'ending' && !f.audio.running);
    assert.equal(manager.getCall(id).owner, 'operator');
    assert.match(manager.getCall(id).error!, /未确认结束/);
    assert.match(manager.getCall(id).error!, /Native connection timed out/);
    assert.equal((await pendingRead).done, true); assert.equal((await buffered.next()).done, true);
    assert.throws(() => owner.audio(id)[Symbol.asyncIterator](), (e: any) => e.code === 'CALL_ENDING');
    await assert.rejects(owner.dial('p', { kind: kind === 'group' ? 'group' : 'direct', targetId: '23456' }), (e: any) => e.code === 'ACCOUNT_BUSY');
    await assert.rejects(owner.writeAudio(id, pcm), (e: any) => e.code === 'NOT_CONNECTED');
    await owner.hangup(id); await owner.hangup(id);
    assert.deepEqual(cleanup, [kind === 'group' ? '/v1/groups/leave' : '/v1/calls/hangup'].flatMap(route => [route, route]));
    assert.equal(manager.getCall(id).state, 'ending'); assert.equal(manager.getCall(id).owner, 'operator');
    native = { ...native, phase: 'ended', nativeTeardownUnknown: false }; qq.ingest(native);
    await eventually(() => manager.getCall(id).state === 'ended'); assert.equal(manager.getCall(id).owner, undefined);
    const next = await owner.dial('p', { kind: kind === 'group' ? 'group' : 'direct', targetId: '23456' });
    assert.notEqual(next.id, id); assert.equal(next.owner, 'operator');
  } finally { await manager.dispose(); await f.close(); }
});

test('ACK uncertainty remains nonterminal and obsolete recovery snapshots cannot recreate active calls', async () => {
  const qq: any = new QqControl({ selfId: '1' });
  Object.assign(qq, { stopped: false, offline: false, bootId: 'boot', linkEpoch: 0 });
  const uncertain = { id: 'uncertain', kind: 'group', direction: 'outgoing', groupId: '23456', phase: 'joining', nativeAckTimedOut: true, nativeError: 'Native command acknowledgement timed out' };
  qq.ingest(uncertain); assert.equal(qq.calls.get('boot:0:uncertain').state, 'ending');
  qq.ingest({ ...uncertain, phase: 'ended' }); assert.equal(qq.calls.get('boot:0:uncertain').state, 'ended');
  const events: any[] = []; qq.on('call', (c: any) => events.push(c));
  qq.request = async (route: string) => route.startsWith('/v1/events') ? { bootId: 'boot', nextSeq: 2, events: [{ type: 'call.state', call: { ...uncertain, id: 'obsolete', phase: 'error', nativeTeardownUnknown: true } }] } :
    { selfId: '1', bootId: 'boot', capabilities: {}, call: null };
  try { await qq.poll(); assert.equal(qq.calls.has('boot:0:obsolete'), false); assert.equal(events.length, 0); }
  finally { await qq.stop(); }
});

test('daemon suppresses identical status packets but preserves capability and diagnostic updates', async () => {
  const f = await daemonFixture(); f.control.update(call()); const client = await f.connect();
  try {
    for (let i = 0; i < 20; i++) f.control.emit('status');
    await client.request('audio.routes'); assert.equal(client.packets.filter(p => p.type === 'status').length, 0);
    // Mutating an existing capability object must still be detected.
    f.control.caps.dial.supported = false; f.control.emit('status');
    for (let i = 0; i < 20; i++) f.control.emit('status');
    await client.request('audio.routes'); const statuses = client.packets.filter(p => p.type === 'status'); assert.equal(statuses.length, 1); assert.equal(statuses[0].capabilities.dial.supported, false);
    f.control.notices = [{ id: 'qq', level: 'warning', message: 'fixture change' }]; f.control.emit('status');
    await client.request('audio.routes'); assert.equal(client.packets.filter(p => p.type === 'status').length, 2);
    assert.equal(client.packets.at(-2).diagnostics[0].message, 'fixture change');
  } finally { await f.close(); }
});
