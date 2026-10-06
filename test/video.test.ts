import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { RtcManager, unavailableCapabilities, validateVideo, type CallProvider, type CallSnapshot, type VideoFrame, type VideoTrack, type VideoState, type VideoWriteFrame, type VideoWriteReceipt } from '../src/core.js';
import { DesktopBridgeProvider } from '../src/providers/bridge.js';
// @ts-expect-error daemon is deliberately standalone JavaScript
import { createDaemon, QqControl } from '../bridge/daemon.mjs';

const token = 'video-test-token-'.repeat(4);
const caps = () => Object.fromEntries(Object.keys(unavailableCapabilities()).map(key => [key, { supported: true }])) as any;
const delay = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean) => { for (let i = 0; i < 300; i++) { if (condition()) return; await delay(); } assert.fail('condition timed out'); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const snapshot = (): CallSnapshot => ({ id: 'call', providerId: 'fake', account: { platform: 'test', selfId: '1' }, kind: 'group', direction: 'incoming', targetId: 'group', state: 'connected', createdAt: 1, updatedAt: 1, muted: false, participants: ['u1', 'u2', 'u3', 'u4', 'u5'].map(id => ({ id, identity: 'platform' })) });
const frame = (sequence = 0, trackId = 'camera:u1'): VideoFrame => ({ callId: 'call', trackId, participantId: 'u1', kind: 'camera', encoding: 'jpeg', width: 320, height: 240, sequence, timestamp: 100 + sequence, evidence: 'native-first-frame-and-render-capture', data: new Uint8Array([255, 216, sequence % 256, 255, 217]) });
const decodedEvidence = 'native-decoded-size-change-and-render-capture' as const;
async function coreFixture() {
  const manager = new RtcManager(), events = new EventEmitter(); let call = snapshot(); const tracks = new Map<string, VideoTrack>();
  let clears = 0, audioClears = 0, unsubscribes = 0, hangs = 0, starts = 0;
  const state = (): VideoState => ({ callId: call.id, supported: true, tracks: [...tracks.values()], sending: {} });
  const provider: CallProvider = { id: 'fake', account: call.account, events, capabilities: caps, start: async () => {}, stop: async () => {}, calls: () => [call], dial: async () => call,
    accept: async () => {}, reject: async () => {}, hangup: async () => { hangs++; }, setMuted: async () => {}, diagnostics: async () => [],
    writeAudio: async (f, id) => ({ id, callId: f.callId, acceptedBytes: f.data.length, playedBytes: 0, state: 'queued' }), clearAudio: async () => { audioClears++; },
    subscribeVideo: async (_id, request) => { const track: VideoTrack = { trackId: `${request.kind}:${request.participantId}`, ...request, available: true, subscribed: true, hasFrame: false }; tracks.set(track.trackId, track); return track; },
    unsubscribeVideo: async (_id, id) => { unsubscribes++; tracks.delete(id); }, clearVideo: async () => { clears++; tracks.clear(); },
    videoState: async () => state(), videoSources: async () => [{ id: 'camera:chosen', kind: 'camera', name: 'Chosen camera' }, { id: 'screen:test', kind: 'screen', name: 'Test pattern' }],
    sendVideo: async (_id, request) => { starts++; return { ...state(), sending: { [request.kind]: { sourceId: request.sourceId, state: 'sending', evidence: 'native-ack-only' } } }; }, stopVideo: async () => state() };
  await manager.register(provider); const owner = manager.controller('owner'); owner.claim(call.id);
  return { manager, provider, owner, tracks, emit: (f: VideoFrame) => events.emit('event', { type: 'video', video: f }), publish: (patch: Partial<CallSnapshot>) => { call = { ...call, ...patch }; events.emit('event', { type: 'call', call }); }, counts: () => ({ clears, audioClears, unsubscribes, hangs, starts }) };
}

test('video latest-frame queues discard old frames, reject wrong identity/replay, and copy bytes', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose());
  const track = await f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' });
  const reader = f.owner.video('call', track.trackId)[Symbol.asyncIterator]();
  f.emit(frame(0)); f.emit(frame(1)); const latest = frame(2); f.emit(latest); latest.data[2] = 99;
  assert.equal((await reader.next()).value?.sequence, 2);
  const pending = reader.next(); let received = false; void pending.then(() => { received = true; });
  f.emit(frame(2)); f.emit({ ...frame(3), participantId: 'u2' }); f.emit({ ...frame(4), kind: 'screen' }); f.emit({ ...frame(5), data: new Uint8Array(256 * 1024 + 1) });
  f.emit({ ...frame(99), evidence: 'render-capture-only' as any });
  await delay(10); assert.equal(received, false);
  const expected = { ...frame(6), evidence: decodedEvidence }; f.emit(expected); expected.data[2] = 88;
  const result = await pending; assert.equal(result.value?.data[2], 6); assert.equal(result.value?.evidence, decodedEvidence);
  await reader.return!(); assert.equal(f.counts().unsubscribes, 1);
});

test('receive evidence accepts only native first-frame or decoded-size-change plus render capture', () => {
  for (const evidence of ['native-first-frame-and-render-capture', decodedEvidence] as const) assert.doesNotThrow(() => validateVideo({ ...frame(), evidence }));
  for (const evidence of ['native-size-change', 'render-capture-only', '', null, ['native-first-frame-and-render-capture']]) {
    assert.throws(() => validateVideo({ ...frame(), evidence: evidence as any }), (e: any) => e.code === 'INVALID_VIDEO');
  }
});

test('video requires lease, connected call, real member and at most four tracks', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose());
  const other = f.manager.controller('other');
  assert.throws(() => other.subscribeVideo('call', { participantId: 'u1', kind: 'camera' }), (e: any) => e.code === 'NOT_CONTROLLER');
  await assert.rejects(f.owner.subscribeVideo('call', { participantId: 'stranger', kind: 'camera' }), (e: any) => e.code === 'INVALID_TRACK');
  for (const participantId of ['u1','u2','u3','u4']) await f.owner.subscribeVideo('call', { participantId, kind: 'camera' });
  await assert.rejects(f.owner.subscribeVideo('call', { participantId: 'u5', kind: 'camera' }), (e: any) => e.code === 'VIDEO_LIMIT');
  f.publish({ state: 'ending' });
  await assert.rejects(f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' }), (e: any) => e.code === 'NOT_CONNECTED');
});

test('video source is explicitly enumerated and release revokes pending/buffered readers without hangup', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose());
  await assert.rejects(f.owner.sendVideo('call', { kind: 'camera', sourceId: 'screen:test' }), (e: any) => e.code === 'INVALID_SOURCE');
  const sending = await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'screen:test' }); assert.equal(sending.sending.screen?.evidence, 'native-ack-only');
  const track = await f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' });
  const reader = f.owner.video('call', track.trackId)[Symbol.asyncIterator](), pending = reader.next();
  await f.owner.release('call'); assert.equal((await pending).done, true); f.emit(frame()); assert.equal((await reader.next()).done, true);
  assert.equal(f.counts().clears, 1); assert.equal(f.counts().audioClears, 1); assert.equal(f.counts().hangs, 0);
  const other = f.manager.controller('other'); other.claim('call'); assert.throws(() => other.video('call', track.trackId)[Symbol.asyncIterator](), (e: any) => e.code === 'VIDEO_NOT_SUBSCRIBED');
});

test('aborting a video reader unsubscribes natively and cannot leak queued frames', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose());
  const track = await f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' }), cancel = new AbortController();
  const reader = f.owner.video('call', track.trackId, { signal: cancel.signal })[Symbol.asyncIterator]();
  const pending = assert.rejects(reader.next(), (e: any) => e.code === 'ABORTED'); cancel.abort(); await pending;
  await until(() => f.counts().unsubscribes === 1); assert.equal(f.tracks.size, 0);
});

test('release during native subscribe cleans its late result before permitting new ownership', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose()); const gate = deferred(), original = f.provider.subscribeVideo!; let entered = false;
  f.provider.subscribeVideo = async (id, request) => { entered = true; await gate.promise; return original(id, request); };
  const pending = assert.rejects(f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' }), (e: any) => e.code === 'NOT_CONTROLLER');
  await until(() => entered); const release = f.owner.release('call'); const other = f.manager.controller('other'); assert.throws(() => other.claim('call'), (e: any) => e.code === 'CALL_BUSY');
  gate.resolve(); await pending; await release; assert.equal(f.tracks.size, 0); other.claim('call'); assert.equal(f.counts().hangs, 0);
});

test('participant removal closes video immediately and releases the native subscription', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose()); const track = await f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' });
  const reader = f.owner.video('call', track.trackId)[Symbol.asyncIterator](), pending = reader.next();
  f.publish({ participants: [{ id: 'u2', identity: 'platform' }] }); assert.equal((await pending).done, true);
  await until(() => f.counts().unsubscribes === 1); assert.equal(f.tracks.size, 0);
});

async function desktopFixture() {
  const control: any = new EventEmitter(); const current = snapshot(); control.calls = new Map([[current.id, current]]); control.caps = caps(); control.notices = []; control.start = async () => {}; control.stop = async () => {};
  control.update = (call: any) => { control.calls.set(call.id, call); control.emit('call', call); };
  const tracks = new Map<string, any>(), sending: any = {}, operations: any[] = []; let nextFrame: any = null, videoGate: Promise<void> | undefined;
  const state = () => ({ supported: true, sendSupported: true, shareScreenSupported: true, sessionId: current.id, tracks: [...tracks.values()], sending: { ...sending }, lastError: null });
  control.video = async (op: string, args: any) => {
    operations.push({ op, ...args });
    if (op === 'sources') return [{ id: 'test-screen', kind: 'screen', name: 'Synthetic pattern' }];
    if (op === 'frame') return nextFrame;
    if (op === 'subscribe') { await videoGate; const id = `${args.kind}:${args.participantId}`; tracks.set(id, { id, uid: args.participantId, kind: args.kind, available: true, subscribed: true, hasFrame: false, firstFrameAt: null }); }
    if (op === 'unsubscribe') tracks.delete(args.trackId);
    if (op === 'send') sending[args.kind] = { sourceId: args.sourceId, state: 'sending', evidence: 'native-ack-only', ...(args.framing === undefined ? {} : { framing: args.framing }) };
    if (op === 'stop') delete sending[args.kind];
    return state();
  };
  let audioWrites = 0; const audio: any = new EventEmitter(); audio.config = { sampleRate: 48000, channels: 1 };
  audio.diagnostics = async () => []; audio.start = async () => {}; audio.stop = async () => {}; audio.setMuted = async () => {}; audio.clear = async () => {}; audio.listDevices = async () => [];
  audio.write = async (data: Uint8Array, id: string) => { audioWrites++; return { id, state: 'queued', acceptedBytes: data.length, playedBytes: 0 }; };
  const daemon = await createDaemon({ host: '127.0.0.1', port: 0, token, account: { platform: 'test', selfId: '1' }, audio: audio.config }, { control, audio });
  const address = await daemon.start(); const url = `ws://127.0.0.1:${address.port}/v1/stream`;
  return { daemon, control, audio, tracks, sending, operations, url, setFrame(value: any) { nextFrame = value; }, setGate(value?: Promise<void>) { videoGate = value; }, get audioWrites() { return audioWrites; } };
}
async function socketClient(url: string) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }); const packets: any[] = [];
  socket.on('message', data => packets.push(JSON.parse(data.toString()))); await once(socket, 'open'); await until(() => packets.some(p => p.type === 'hello'));
  let id = 0;
  return { socket, packets, async request(op: string, args: object = {}) { const key = `request-${++id}`; socket.send(JSON.stringify({ type: 'request', id: key, op, args })); await until(() => packets.some(p => p.id === key)); return packets.find(p => p.id === key); } };
}

test('daemon/provider/core deliver isolated video frames and release remote resources', { timeout: 8000 }, async t => {
  const f = await desktopFixture(); const manager = new RtcManager(); t.after(async () => { await manager.dispose(); await f.daemon.stop(); });
  const provider = new DesktopBridgeProvider({ id: 'desktop', url: f.url, token, selfId: '1', platform: 'test' }); await manager.register(provider);
  await until(() => manager.listCalls().length === 1); const id = manager.listCalls()[0]!.id, owner = manager.controller('plugin'); owner.claim(id);
  const track = await owner.subscribeVideo(id, { participantId: 'u1', kind: 'camera' }); const reader = owner.video(id, track.trackId)[Symbol.asyncIterator]();
  const incoming = frame(10); f.setFrame({ ...incoming, data: Buffer.from(incoming.data).toString('base64') });
  const received = await reader.next(); assert.equal(received.value?.callId, id); assert.equal(received.value?.participantId, 'u1'); assert.equal(received.value?.sequence, 10);
  await owner.sendVideo(id, { kind: 'screen', sourceId: 'test-screen' }); assert.ok(f.sending.screen);
  await owner.release(id); assert.equal(f.tracks.size, 0); assert.deepEqual(f.sending, {}); assert.equal((await reader.next()).done, true);
});

test('decoded-size-change evidence crosses daemon/provider/core without inventing first-frame metadata', { timeout: 8000 }, async t => {
  const f = await desktopFixture(), manager = new RtcManager();
  t.after(async () => { await manager.dispose(); await f.daemon.stop(); });
  const original = f.control.video;
  f.control.video = async (op: string, args: any) => {
    const result = await original(op, args);
    if (op === 'subscribe') Object.assign(result.tracks[0], { hasFrame: true, decodedFrameAt: 123, firstFrameAt: null });
    return result;
  };
  const provider = new DesktopBridgeProvider({ id: 'desktop', url: f.url, token, selfId: '1', platform: 'test' }); await manager.register(provider);
  await until(() => manager.listCalls().length === 1);
  const id = manager.listCalls()[0]!.id, owner = manager.controller('plugin'); owner.claim(id);
  const track = await owner.subscribeVideo(id, { participantId: 'u1', kind: 'camera' });
  assert.equal(track.firstFrameAt, null); assert.equal(track.decodedFrameAt, 123);
  const state = await owner.videoState(id); assert.equal(state.tracks[0]?.decodedFrameAt, 123); assert.equal(state.tracks[0]?.firstFrameAt, null);
  const reader = owner.video(id, track.trackId)[Symbol.asyncIterator](), pending = reader.next(); let resolved = false;
  void pending.then(() => { resolved = true; });
  f.setFrame({ ...frame(999), evidence: 'native-size-change', data: Buffer.from(frame().data).toString('base64') });
  await until(() => f.operations.filter(item => item.op === 'frame').length >= 2); await delay(); assert.equal(resolved, false);
  const incoming = { ...frame(0), evidence: decodedEvidence }; f.setFrame({ ...incoming, data: Buffer.from(incoming.data).toString('base64') });
  const received = (await pending).value!;
  assert.equal(received.callId, id); assert.equal(received.participantId, 'u1'); assert.equal(received.sequence, 0); assert.equal(received.evidence, decodedEvidence);
  assert.deepEqual(received.data, incoming.data);
  // Metadata follows the existing firstFrameAt policy: invalid/absent values
  // become null, and decoded evidence never supplies a missing first-frame time.
  f.tracks.get(track.trackId).decodedFrameAt = '123';
  assert.equal((await owner.videoState(id)).tracks[0]?.decodedFrameAt, null);
  delete f.tracks.get(track.trackId).decodedFrameAt;
  assert.equal((await owner.videoState(id)).tracks[0]?.decodedFrameAt, null);
  assert.equal((await owner.videoState(id)).tracks[0]?.firstFrameAt, null);
  await reader.return!();
});

test('daemon validates native frames, keeps PCM moving during subscribe and cleans late disconnect', { timeout: 8000 }, async t => {
  const f = await desktopFixture(); t.after(() => f.daemon.stop()); const client = await socketClient(f.url); t.after(() => client.socket.terminate());
  const gate = deferred(); f.setGate(gate.promise);
  const subscribing = client.request('video.subscribe', { callId: 'call', participantId: 'u1', kind: 'camera' });
  await until(() => f.operations.some(x => x.op === 'subscribe'));
  const written = await client.request('audio.write', { playbackId: 'pcm', frame: { callId: 'call', sequence: 1, timestamp: 1, encoding: 'pcm_s16le', sampleRate: 48000, channels: 1, data: Buffer.alloc(1920).toString('base64') } });
  assert.equal(written.ok, true); assert.equal(f.audioWrites, 1);
  gate.resolve(); assert.equal((await subscribing).ok, true);
  f.setFrame({ ...frame(1), participantId: 'outsider', data: Buffer.from(frame().data).toString('base64') }); await delay(180); assert.equal(client.packets.filter(p => p.type === 'video').length, 0);
  f.setFrame({ ...frame(2), data: Buffer.from(frame(2).data).toString('base64') }); await until(() => client.packets.some(p => p.type === 'video'));
  await client.request('video.send', { callId: 'call', kind: 'screen', sourceId: 'test-screen' });
  client.socket.terminate(); await until(() => !f.tracks.size && !Object.keys(f.sending).length);
  assert.equal(f.control.calls.get('call').state, 'connected', 'media cleanup must not hang up');
});

test('disconnect before subscribe response still removes the eventually created native track', { timeout: 8000 }, async t => {
  const f = await desktopFixture(); t.after(() => f.daemon.stop()); const client = await socketClient(f.url); const gate = deferred(); f.setGate(gate.promise);
  client.socket.send(JSON.stringify({ type: 'request', id: 'late-subscribe', op: 'video.subscribe', args: { callId: 'call', participantId: 'u1', kind: 'camera' } }));
  await until(() => f.operations.some(x => x.op === 'subscribe')); client.socket.terminate(); await delay(10); gate.resolve();
  await until(() => f.operations.some(x => x.op === 'unsubscribe')); assert.equal(f.tracks.size, 0);
});

test('slow unavailable video discovery never delays QQ voice reconciliation', async t => {
  const control = new QqControl({ url: 'http://127.0.0.1', token, selfId: '1' }), gate = deferred();
  control.request = async (route: string) => {
    if (route === '/v1/video/state') { await gate.promise; throw new Error('video unavailable'); }
    if (route === '/v1/capabilities') return { selfId: '1', bootId: 'boot', capabilities: { 'private.accept': { status: 'supported' } } };
    if (route.startsWith('/v1/events')) return { bootId: 'boot', events: [], nextSeq: 0 };
    if (route === '/v1/status') return { selfId: '1', bootId: 'boot', call: { id: 'native', kind: 'private', phase: 'connected', participants: [] } };
  };
  t.after(async () => { gate.resolve(); await control.stop(); }); await control.start();
  assert.equal(control.offline, false); assert.equal(control.calls.size, 1); assert.equal(control.caps.accept.supported, true); assert.equal(control.caps.receiveVideo.supported, false);
});

test('core video start waiting for native acknowledgement does not block PCM writes', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose()); const gate = deferred(), original = f.provider.sendVideo!; let entered = false;
  f.provider.sendVideo = async (id, request) => { entered = true; await gate.promise; return original(id, request); };
  const sending = f.owner.sendVideo('call', { kind: 'screen', sourceId: 'screen:test' }); await until(() => entered);
  const receipt = await f.owner.writeAudio('call', { encoding: 'pcm_s16le', sampleRate: 48000, channels: 1, sequence: 0, timestamp: 1, data: new Uint8Array(1920) });
  assert.equal(receipt.acceptedBytes, 1920); gate.resolve(); await sending;
});

test('provider unload revokes readers and releases video before shutdown', async () => {
  const f = await coreFixture(); const track = await f.owner.subscribeVideo('call', { participantId: 'u1', kind: 'camera' });
  const reader = f.owner.video('call', track.trackId)[Symbol.asyncIterator](), pending = reader.next(); let stopped = false;
  f.provider.stop = async () => { assert.equal(f.tracks.size, 0); stopped = true; };
  await f.manager.unregister('fake'); assert.equal((await pending).done, true); assert.equal(stopped, true); assert.equal(f.counts().hangs, 0); await f.manager.dispose();
});

test('unknown native subscribe is never replayed and explicit cleanup reconciles its reserved track', { timeout: 8000 }, async t => {
  const f = await desktopFixture(); t.after(() => f.daemon.stop()); const original = f.control.video; let first = true;
  f.control.video = async (op: string, args: any) => { const result = await original(op, args); if (op === 'subscribe' && first) { first = false; throw new Error('lost reply after native subscribe'); } return result; };
  const client = await socketClient(f.url); t.after(() => client.socket.terminate());
  const request = { callId: 'call', participantId: 'u1', kind: 'camera' };
  assert.equal((await client.request('video.subscribe', request)).ok, false); assert.equal(f.tracks.size, 1);
  assert.equal((await client.request('video.subscribe', request)).error.code, 'VIDEO_CLEANUP_REQUIRED'); assert.equal(f.operations.filter(x => x.op === 'subscribe').length, 1);
  assert.equal((await client.request('video.clear', { callId: 'call' })).ok, true); assert.equal(f.tracks.size, 0);
  assert.equal((await client.request('video.subscribe', request)).ok, true);
});

const outbound = (sequence = 0): Omit<VideoWriteFrame, 'callId'> => ({ kind: 'screen', encoding: 'jpeg', width: 320, height: 240, sequence, timestamp: Date.now(), data: new Uint8Array([255,216,sequence % 256,255,217]) });
const writeReceipt = (frame: VideoWriteFrame): VideoWriteReceipt => ({ callId: frame.callId, kind: frame.kind, sequence: frame.sequence, state: 'rendered', acceptedBytes: frame.data.length, evidence: 'synthetic-window-render-ack' });
async function writableCore() {
  const f = await coreFixture(), frames: VideoWriteFrame[] = [];
  f.provider.videoSources = async () => [{ id: 'external-frames', name: 'Plugin frames', kind: 'screen', sourceType: 'frames', channels: ['screen'] }, { id: 'camera:chosen', name: 'Physical camera', kind: 'camera', sourceType: 'device', channels: ['camera'] }];
  f.provider.writeVideo = async frame => { frames.push(frame); return writeReceipt(frame); };
  return { ...f, frames };
}

test('plugin video frames require an explicit writable source and a matching channel', async t => {
  const f = await writableCore(); t.after(() => f.manager.dispose());
  assert.throws(() => f.owner.writeVideo('call', outbound()), (e: any) => e.code === 'VIDEO_SOURCE_REQUIRED');
  await f.owner.sendVideo('call', { kind: 'camera', sourceId: 'camera:chosen' });
  assert.throws(() => f.owner.writeVideo('call', { ...outbound(), kind: 'camera' }), (e: any) => e.code === 'VIDEO_SOURCE_REQUIRED');
  await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' });
  assert.throws(() => f.owner.writeVideo('call', { ...outbound(), data: new Uint8Array(256 * 1024 + 1) }), (e: any) => e.code === 'INVALID_VIDEO');
  const result = await f.owner.writeVideo('call', outbound(2)); assert.equal(result.state, 'rendered'); assert.equal(result.evidence, 'synthetic-window-render-ack');
  assert.throws(() => f.owner.writeVideo('call', outbound(2)), (e: any) => e.code === 'VIDEO_SEQUENCE');
  await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' });
  assert.throws(() => f.owner.writeVideo('call', outbound(2)), (e: any) => e.code === 'VIDEO_SEQUENCE', 'same source start must preserve its sequence');
  assert.throws(() => f.owner.writeVideo('call', { ...outbound(3), width: 2048, height: 2048 }), (e: any) => e.code === 'INVALID_VIDEO');
  assert.equal((await f.owner.writeVideo('call', { ...outbound(3), width: 1080, height: 1920 })).state, 'rendered');
  await f.owner.stopVideo('call', 'screen'); assert.throws(() => f.owner.writeVideo('call', outbound(3)), (e: any) => e.code === 'VIDEO_SOURCE_REQUIRED');
});

test('plugin frame writer keeps only latest pending frame, copies input and never blocks PCM', async t => {
  const f = await writableCore(), gate = deferred(); t.after(() => f.manager.dispose()); let entered = false;
  f.provider.writeVideo = async frame => { entered = true; if (frame.sequence === 0) await gate.promise; f.frames.push(frame); return writeReceipt(frame); };
  await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' });
  const input = outbound(0), first = f.owner.writeVideo('call', input); input.data[2] = 99; await until(() => entered);
  const old = f.owner.writeVideo('call', outbound(1)), latest = f.owner.writeVideo('call', outbound(2));
  assert.equal((await old).state, 'dropped');
  const audio = await f.owner.writeAudio('call', { encoding: 'pcm_s16le', sampleRate: 48000, channels: 1, sequence: 0, timestamp: 1, data: new Uint8Array(1920) }); assert.equal(audio.acceptedBytes, 1920);
  gate.resolve(); assert.equal((await first).state, 'rendered'); assert.equal((await latest).state, 'rendered');
  assert.deepEqual(f.frames.map(frame => frame.sequence), [0, 2]); assert.equal(f.frames[0]!.data[2], 0);
  // Awaiting one receipt and immediately supplying the next must not strand a frame in a completed pump.
  for (let i = 3; i < 12; i++) assert.equal((await f.owner.writeVideo('call', outbound(i))).sequence, i);
});

test('release drops pending outgoing video, waits for in-flight cleanup and does not hang up', async t => {
  const f = await writableCore(), gate = deferred(); t.after(() => f.manager.dispose()); let entered = false;
  f.provider.writeVideo = async frame => { entered = true; await gate.promise; return writeReceipt(frame); };
  await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' });
  const first = assert.rejects(f.owner.writeVideo('call', outbound(0)), (e: any) => e.code === 'NOT_CONTROLLER'); await until(() => entered);
  const pending = f.owner.writeVideo('call', outbound(1)); const release = f.owner.release('call');
  assert.equal((await pending).state, 'dropped'); assert.equal(f.counts().clears, 0);
  gate.resolve(); await first; await release; assert.equal(f.counts().clears, 1); assert.equal(f.counts().hangs, 0); assert.equal(f.manager.getCall('call').state, 'connected');
});

test('outgoing frame receipt mismatch revokes source and cannot replay a pending frame', async t => {
  const f = await writableCore(); t.after(() => f.manager.dispose()); await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' });
  f.provider.writeVideo = async frame => ({ ...writeReceipt(frame), callId: 'different-call' });
  await assert.rejects(f.owner.writeVideo('call', outbound()), (e: any) => e.code === 'INVALID_VIDEO');
  assert.throws(() => f.owner.writeVideo('call', outbound(1)), (e: any) => e.code === 'VIDEO_SOURCE_REQUIRED');
  await assert.rejects(f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' }), (e: any) => e.code === 'VIDEO_CLEANUP_REQUIRED');
  await f.owner.stopVideo('call', 'screen'); await f.owner.sendVideo('call', { kind: 'screen', sourceId: 'external-frames' });
});

function writableDesktop(f: Awaited<ReturnType<typeof desktopFixture>>, gate?: Promise<void>) {
  const original = f.control.video, frames: any[] = [];
  f.control.video = async (op: string, args: any) => {
    if (op === 'sources') return [{ id: 'external-frames', kind: 'screen', name: 'Plugin frames', sourceType: 'frames', channels: ['screen'] }];
    if (op === 'write') { frames.push(args); if (args.sequence === 0) await gate; return { ...writeReceipt({ ...args, data: Buffer.from(args.data, 'base64') }), callId: args.callId }; }
    return original(op, args);
  };
  const wire = (sequence: number) => { const frame = outbound(sequence); return { ...frame, callId: 'call', data: Buffer.from(frame.data).toString('base64') }; };
  return { frames, wire };
}

test('desktop bridge preserves source channels and maps plugin JPEG receipts to local session', async t => {
  const f = await desktopFixture(), writable = writableDesktop(f), manager = new RtcManager(); t.after(async () => { await manager.dispose(); await f.daemon.stop(); });
  const provider = new DesktopBridgeProvider({ id: 'desktop', url: f.url, token, selfId: '1', platform: 'test' }); await manager.register(provider); await until(() => manager.listCalls().length === 1);
  const id = manager.listCalls()[0]!.id, owner = manager.controller('plugin'); owner.claim(id);
  const sources = await owner.videoSources(id); assert.equal(sources[0]!.sourceType, 'frames'); assert.deepEqual(sources[0]!.channels, ['screen']);
  await owner.sendVideo(id, { kind: 'screen', sourceId: 'external-frames' });
  const receipt = await owner.writeVideo(id, outbound(0)); assert.equal(receipt.callId, id); assert.equal(receipt.state, 'rendered'); assert.equal(writable.frames[0].callId, 'call');
  await owner.release(id); assert.deepEqual(f.sending, {});
});

test('daemon raw frame flood is latest-only, independent of audio and replay cache', async t => {
  const f = await desktopFixture(), gate = deferred(), writable = writableDesktop(f, gate.promise); t.after(() => f.daemon.stop()); const client = await socketClient(f.url); t.after(() => client.socket.terminate());
  assert.equal((await client.request('video.write', writable.wire(0))).error.code, 'VIDEO_SOURCE_REQUIRED');
  await client.request('video.send', { callId: 'call', kind: 'screen', sourceId: 'external-frames' });
  const first = client.request('video.write', writable.wire(0)); await until(() => writable.frames.length === 1);
  const old = client.request('video.write', writable.wire(1)), latest = client.request('video.write', writable.wire(2)); assert.equal((await old).data.state, 'dropped');
  const audio = await client.request('audio.write', { playbackId: 'pcm', frame: { callId: 'call', sequence: 0, timestamp: 1, encoding: 'pcm_s16le', sampleRate: 48000, channels: 1, data: Buffer.alloc(1920).toString('base64') } }); assert.equal(audio.ok, true);
  gate.resolve(); assert.equal((await first).data.state, 'rendered'); assert.equal((await latest).data.state, 'rendered'); assert.deepEqual(writable.frames.map(f => f.sequence), [0, 2]);
  assert.equal((await client.request('video.write', writable.wire(2))).error.code, 'VIDEO_SEQUENCE');
  await client.request('video.send', { callId: 'call', kind: 'screen', sourceId: 'external-frames' });
  assert.equal((await client.request('video.write', writable.wire(2))).error.code, 'VIDEO_SEQUENCE', 'native idempotent start must not reset frame sequence');
  assert.equal((await client.request('video.write', { ...writable.wire(3), width: 4096, height: 4096 })).error.code, 'INVALID_VIDEO');
  assert.equal((await client.request('video.write', { ...writable.wire(3), kind: 'camera' })).error.code, 'VIDEO_SOURCE_REQUIRED');
  assert.equal((await client.request('video.write', { ...writable.wire(3), data: 'not-jpeg' })).error.code, 'INVALID_VIDEO');
  // Frame request ids are transport correlation only: no retained base64 request ledger.
  client.socket.send(JSON.stringify({ type: 'request', id: 'same-frame-id', op: 'video.write', args: writable.wire(4) }));
  await until(() => client.packets.filter(p => p.id === 'same-frame-id').length === 1);
  client.socket.send(JSON.stringify({ type: 'request', id: 'same-frame-id', op: 'video.write', args: writable.wire(5) }));
  await until(() => client.packets.filter(p => p.id === 'same-frame-id').length === 2);
  assert.deepEqual(client.packets.filter(p => p.id === 'same-frame-id').map(p => p.data.sequence), [4, 5]);
});

test('daemon disconnect drops unsent JPEG and stops its source after in-flight write finishes', async t => {
  const f = await desktopFixture(), gate = deferred(), writable = writableDesktop(f, gate.promise); t.after(() => f.daemon.stop()); const client = await socketClient(f.url);
  await client.request('video.send', { callId: 'call', kind: 'screen', sourceId: 'external-frames' });
  client.socket.send(JSON.stringify({ type: 'request', id: 'first', op: 'video.write', args: writable.wire(0) })); await until(() => writable.frames.length === 1);
  client.socket.send(JSON.stringify({ type: 'request', id: 'pending', op: 'video.write', args: writable.wire(1) })); await delay(10);
  client.socket.terminate(); await delay(10); gate.resolve(); await until(() => Object.keys(f.sending).length === 0);
  assert.deepEqual(writable.frames.map(f => f.sequence), [0]); assert.equal(f.control.calls.get('call').state, 'connected');
});

test('QQ control maps outbound frame call id and preserves all approved payload fields', async t => {
  const control = new QqControl({ url: 'http://127.0.0.1', token, selfId: '1' }); let submitted: any;
  control.verify = async () => ({ selfId: '1', bootId: 'boot' }); control.bootId = 'boot'; control.linkEpoch = 2; control.offline = false; control.stopped = false;
  control.calls.set('boot:2:local', { ...snapshot(), id: 'boot:2:local', nativeId: 'native' });
  control.request = async (route: string, args: any) => { assert.equal(route, '/v1/video/write'); submitted = args; return { callId: 'native', kind: args.kind, sequence: args.sequence, state: 'rendered', evidence: 'local-window-render' }; };
  t.after(() => control.stop()); const input = { ...outbound(7), callId: 'boot:2:local', data: ' /9j/2Q=='.trim() };
  const result = await control.video('write', input); assert.equal(result.callId, 'boot:2:local'); assert.deepEqual(submitted, { ...input, callId: 'native' });
});

test('screen dial is explicit, direct-only and checks its own capability independently of sharing', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose()); f.publish({ state: 'ended' });
  const capabilities = caps(); capabilities.dialScreen.supported = false; capabilities.shareScreen.supported = true; f.provider.capabilities = () => capabilities;
  const requested: any[] = [];
  f.provider.dial = async request => { requested.push(request); return { ...snapshot(), id: 'screen-call', kind: 'direct', targetId: request.targetId, direction: 'outgoing', state: 'dialing' }; };
  await assert.rejects(f.owner.dial('fake', { kind: 'direct', targetId: 'peer', media: 'screen' }), (e: any) => e.code === 'CAPABILITY_UNAVAILABLE');
  await assert.rejects(f.owner.dial('fake', { kind: 'group', targetId: 'group', media: 'screen' }), (e: any) => e.code === 'INVALID_TARGET');
  await assert.rejects(f.owner.dial('fake', { kind: 'direct', targetId: 'peer', media: 'camera' as any }), (e: any) => e.code === 'INVALID_TARGET');
  assert.equal(requested.length, 0);
  capabilities.dialScreen.supported = true; capabilities.shareScreen.supported = false;
  const call = await f.owner.dial('fake', { kind: 'direct', targetId: 'peer', media: 'screen' }); assert.equal(call.state, 'dialing'); assert.equal(requested[0].media, 'screen');
});

test('screen dial request survives provider/WebSocket boundary and is rejected before dispatch without capability', async t => {
  const f = await desktopFixture(), manager = new RtcManager(); t.after(async () => { await manager.dispose(); await f.daemon.stop(); });
  f.control.calls.clear(); f.control.caps.dialScreen.supported = false; const requested: any[] = [];
  f.control.control = async (op: string, args: any) => { requested.push({ op, ...args }); const call = { ...snapshot(), id: 'outgoing-screen', kind: 'direct', direction: 'outgoing', state: 'dialing', targetId: args.targetId }; f.control.update(call); return call; };
  const provider = new DesktopBridgeProvider({ id: 'desktop', url: f.url, token, selfId: '1', platform: 'test' }); await manager.register(provider); await until(() => provider.capabilities().dial.supported);
  await assert.rejects(provider.dial({ kind: 'direct', targetId: 'peer', media: 'screen' }), (e: any) => e.code === 'CAPABILITY_UNAVAILABLE'); assert.equal(requested.length, 0);
  f.control.caps.dialScreen.supported = true; f.control.emit('status'); await until(() => provider.capabilities().dialScreen.supported);
  const owner = manager.controller('dial-screen'); const call = await owner.dial('desktop', { kind: 'direct', targetId: 'peer', media: 'screen' });
  assert.equal(call.kind, 'direct'); assert.equal(call.state, 'dialing'); assert.equal(requested[0].media, 'screen');
});

test('QQ maps private.screenDial separately and forwards only explicit screen invitation media', async t => {
  const control = new QqControl({ url: 'http://127.0.0.1', token, selfId: '1' }); let invitation: any;
  control.request = async (route: string, args: any) => {
    if (route === '/v1/capabilities') return { selfId: '1', bootId: 'boot', capabilities: { 'private.dial': { status: 'supported' }, 'private.screenDial': { status: 'supported' } } };
    if (route === '/v1/video/state') return { supported: false };
    if (route.startsWith('/v1/events')) return { bootId: 'boot', events: [], nextSeq: 0 };
    if (route === '/v1/calls/dial') { invitation = args; return { callId: 'native' }; }
    if (route === '/v1/status') return { selfId: '1', bootId: 'boot', call: invitation ? { id: 'native', kind: 'private', direction: 'outgoing', peerUid: 'peer', phase: 'calling', participants: [] } : null };
  };
  t.after(() => control.stop()); await control.start(); assert.equal(control.caps.dialScreen.supported, true); assert.equal(control.caps.shareScreen.supported, false);
  await control.control('dial', { kind: 'direct', targetId: 'peer', media: 'screen' }, 'screen-invitation', new AbortController().signal);
  assert.deepEqual(invitation, { peerUid: 'peer', media: 'screen' });
  await assert.rejects(control.control('dial', { kind: 'group', targetId: 'group', media: 'screen' }), (e: any) => e.code === 'INVALID_TARGET');
});

test('private video invitation uses dial capability, rejects groups, and never opens a source', async t => {
  const f = await coreFixture(); t.after(() => f.manager.dispose()); f.publish({ state: 'ended' });
  const capabilities = caps(); capabilities.dial.supported = false; capabilities.dialScreen.supported = false;
  f.provider.capabilities = () => capabilities;
  const requested: any[] = [];
  f.provider.dial = async request => { requested.push(request); return { ...snapshot(), id: 'video-call', kind: 'direct', targetId: request.targetId, direction: 'outgoing', state: 'dialing' }; };
  await assert.rejects(f.owner.dial('fake', { kind: 'direct', targetId: 'peer', media: 'video' }), (e: any) => e.code === 'CAPABILITY_UNAVAILABLE');
  for (const groupMode of ['join', 'create'] as const) await assert.rejects(f.owner.dial('fake', { kind: 'group', targetId: 'group', groupMode, media: 'video' }), (e: any) => e.code === 'INVALID_TARGET');
  assert.equal(requested.length, 0);
  capabilities.dial.supported = true; capabilities.sendVideo.supported = false;
  const call = await f.owner.dial('fake', { kind: 'direct', targetId: 'peer', media: 'video' });
  assert.equal(call.state, 'dialing'); assert.equal(requested[0].media, 'video'); assert.equal(f.counts().starts, 0);
});

test('video invitation crosses desktop WebSocket unchanged and group video is rejected before control', async t => {
  const f = await desktopFixture(), manager = new RtcManager(); t.after(async () => { await manager.dispose(); await f.daemon.stop(); });
  f.control.calls.clear(); f.control.caps.dialScreen.supported = false; const requested: any[] = [];
  f.control.control = async (op: string, args: any) => { requested.push({ op, ...args }); const call = { ...snapshot(), id: 'outgoing-video', kind: 'direct', direction: 'outgoing', state: 'dialing', targetId: args.targetId }; f.control.update(call); return call; };
  const provider = new DesktopBridgeProvider({ id: 'desktop', url: f.url, token, selfId: '1', platform: 'test' }); await manager.register(provider); await until(() => provider.capabilities().dial.supported);
  await assert.rejects(provider.dial({ kind: 'group', targetId: 'group', media: 'video' }), (e: any) => e.code === 'INVALID_TARGET');
  assert.equal(requested.length, 0);
  const owner = manager.controller('dial-video'); const call = await owner.dial('desktop', { kind: 'direct', targetId: 'peer', media: 'video' });
  assert.equal(call.state, 'dialing'); assert.equal(requested[0].media, 'video'); assert.deepEqual(f.sending, {});
});

test('QQ forwards video invitation through private.dial without implicit camera actions', async t => {
  const control = new QqControl({ url: 'http://127.0.0.1', token, selfId: '1' }); let invitation: any; const mutations: string[] = [];
  control.request = async (route: string, args: any) => {
    if (args !== undefined) mutations.push(route);
    if (route === '/v1/capabilities') return { selfId: '1', bootId: 'boot', capabilities: { 'private.dial': { status: 'supported' }, 'private.screenDial': { status: 'unavailable' } } };
    if (route === '/v1/video/state') return { supported: false };
    if (route.startsWith('/v1/events')) return { bootId: 'boot', events: [], nextSeq: 0 };
    if (route === '/v1/calls/dial') { invitation = args; return { callId: 'native' }; }
    if (route === '/v1/status') return { selfId: '1', bootId: 'boot', call: invitation ? { id: 'native', kind: 'private', direction: 'outgoing', peerUid: 'peer', phase: 'calling', participants: [] } : null };
  };
  t.after(() => control.stop()); await control.start();
  await assert.rejects(control.control('dial', { kind: 'group', targetId: 'group', media: 'video' }), (e: any) => e.code === 'INVALID_TARGET');
  await control.control('dial', { kind: 'direct', targetId: 'peer', media: 'video' }, 'video-invitation', new AbortController().signal);
  assert.deepEqual(invitation, { peerUid: 'peer', media: 'video' }); assert.deepEqual(mutations, ['/v1/calls/dial']);
});

test('camera framing is explicit and mode changes restart sequence while equivalent full requests preserve it', async t => {
  const f = await writableCore(); t.after(() => f.manager.dispose()); const requests: any[] = [];
  f.provider.videoSources = async () => [{ id: 'external-frames', name: 'Frames', kind: 'camera', sourceType: 'frames', channels: ['camera'] }];
  f.provider.sendVideo = async (_id, request) => { requests.push(request); return { callId: 'call', supported: true, tracks: [], sending: { camera: { sourceId: request.sourceId, state: 'sending', framing: request.framing ?? 'full' } } }; };
  for (const request of [
    { kind: 'screen', sourceId: 'external-frames', framing: 'full' },
    { kind: 'camera', sourceId: 'physical', framing: 'portrait-safe' },
    { kind: 'camera', sourceId: 'external-frames', framing: 'stretch' },
    { kind: 'camera', sourceId: 'external-frames', framing: ['full'] },
  ]) await assert.rejects(f.owner.sendVideo('call', request as any), (e: any) => e.code === 'INVALID_SOURCE');
  assert.equal(requests.length, 0);
  const send = (framing?: 'full' | 'portrait-safe') => f.owner.sendVideo('call', { kind: 'camera', sourceId: 'external-frames', ...(framing === undefined ? {} : { framing }) });
  const write = (sequence: number) => f.owner.writeVideo('call', { ...outbound(sequence), kind: 'camera' });
  await send(); await write(5); await send('full'); assert.throws(() => write(5), (e: any) => e.code === 'VIDEO_SEQUENCE');
  assert.equal((await send('portrait-safe')).sending.camera?.framing, 'portrait-safe'); await write(0);
  await send('portrait-safe'); assert.throws(() => write(0), (e: any) => e.code === 'VIDEO_SEQUENCE');
  await send('full'); await write(0); assert.deepEqual(f.frames.map(frame => frame.sequence), [5, 0, 0]);
});

test('a provider silently ignoring portrait-safe cannot receive plugin frames', async t => {
  const f = await writableCore(); t.after(() => f.manager.dispose());
  f.provider.videoSources = async () => [{ id: 'external-frames', name: 'Frames', kind: 'camera', sourceType: 'frames' }];
  await assert.rejects(f.owner.sendVideo('call', { kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe' }), (e: any) => e.code === 'INVALID_VIDEO');
  assert.throws(() => f.owner.writeVideo('call', { ...outbound(), kind: 'camera' }), (e: any) => e.code === 'VIDEO_SOURCE_REQUIRED');
  await assert.rejects(f.owner.sendVideo('call', { kind: 'camera', sourceId: 'external-frames' }), (e: any) => e.code === 'VIDEO_CLEANUP_REQUIRED');
  await f.owner.stopVideo('call', 'camera');
});

test('framing change drains old writes without revoking the newly configured output', async t => {
  const f = await writableCore(), gate = deferred(); t.after(() => f.manager.dispose()); let writing = false, hold = true;
  f.provider.videoSources = async () => [{ id: 'external-frames', name: 'Frames', kind: 'camera', sourceType: 'frames' }];
  f.provider.sendVideo = async (_id, request) => ({ callId: 'call', supported: true, tracks: [], sending: { camera: { sourceId: request.sourceId, state: 'sending', framing: request.framing ?? 'full' } } });
  f.provider.writeVideo = async frame => { writing = true; if (hold) await gate.promise; return writeReceipt(frame); };
  const send = (framing: 'full' | 'portrait-safe') => f.owner.sendVideo('call', { kind: 'camera', sourceId: 'external-frames', framing });
  await send('full');
  const first = assert.rejects(f.owner.writeVideo('call', { ...outbound(0), kind: 'camera' }), (e: any) => e.code === 'RESULT_UNKNOWN');
  await until(() => writing);
  const pending = f.owner.writeVideo('call', { ...outbound(1), kind: 'camera' }), changed = send('portrait-safe');
  assert.equal((await pending).state, 'dropped'); hold = false; gate.resolve(); await first; await changed;
  await f.owner.writeVideo('call', { ...outbound(0), kind: 'camera' });
  await send('portrait-safe'); // Must remain reusable after the intentional drain.
});

test('daemon framing change waits for a pending old frame without revoking the session', async t => {
  const f = await desktopFixture(), gate = deferred(); t.after(() => f.daemon.stop()); const original = f.control.video; let writing = false, hold = true;
  f.control.video = async (op: string, args: any) => {
    if (op === 'sources') return [{ id: 'external-frames', name: 'Frames', kind: 'camera', sourceType: 'frames' }];
    if (op === 'write') { writing = true; if (hold) await gate.promise; return writeReceipt({ ...args, data: Buffer.from(args.data, 'base64') }); }
    return original(op, args);
  };
  const client = await socketClient(f.url); t.after(() => client.socket.terminate());
  const send = (framing: string) => client.request('video.send', { callId: 'call', kind: 'camera', sourceId: 'external-frames', framing });
  const write = (sequence: number) => client.request('video.write', { ...outbound(sequence), callId: 'call', kind: 'camera', data: Buffer.from(outbound(sequence).data).toString('base64') });
  assert.equal((await send('full')).ok, true); const first = write(0); await until(() => writing);
  const pending = write(1); await delay(5); const changed = send('portrait-safe');
  assert.equal((await pending).data.state, 'dropped'); hold = false; gate.resolve();
  assert.equal((await first).error.code, 'RESULT_UNKNOWN'); assert.equal((await changed).ok, true);
  assert.equal((await write(0)).ok, true); assert.equal((await send('portrait-safe')).ok, true);
});

test('desktop framing survives all state boundaries and participates in request fingerprint and output reuse', async t => {
  const f = await desktopFixture(); t.after(() => f.daemon.stop()); const original = f.control.video;
  f.control.video = async (op: string, args: any) => {
    if (op === 'sources') return [{ id: 'external-frames', name: 'Frames', kind: 'camera', sourceType: 'frames', channels: ['camera'] }];
    if (op === 'write') return writeReceipt({ ...args, data: Buffer.from(args.data, 'base64') });
    return original(op, args);
  };
  const client = await socketClient(f.url); t.after(() => client.socket.terminate());
  const args = { callId: 'call', kind: 'camera', sourceId: 'external-frames', framing: 'full' };
  client.socket.send(JSON.stringify({ type: 'request', id: 'framing-key', op: 'video.send', args }));
  await until(() => client.packets.some(p => p.id === 'framing-key')); assert.equal(client.packets.find(p => p.id === 'framing-key').ok, true);
  client.socket.send(JSON.stringify({ type: 'request', id: 'framing-key', op: 'video.send', args: { ...args, framing: 'portrait-safe' } }));
  await until(() => client.packets.filter(p => p.id === 'framing-key').length === 2);
  assert.equal(client.packets.filter(p => p.id === 'framing-key')[1].error.code, 'REQUEST_ID_REUSED');
  const write = (sequence: number) => client.request('video.write', { ...outbound(sequence), callId: 'call', kind: 'camera', data: Buffer.from(outbound(sequence).data).toString('base64') });
  assert.equal((await write(5)).ok, true);
  assert.equal((await client.request('video.send', { ...args, framing: undefined })).ok, true);
  assert.equal((await write(5)).error.code, 'VIDEO_SEQUENCE');
  assert.equal((await client.request('video.send', { ...args, framing: 'portrait-safe' })).data.sending.camera.framing, 'portrait-safe');
  assert.equal((await write(0)).ok, true);
  assert.equal((await client.request('video.send', { ...args, kind: 'screen' })).error.code, 'INVALID_SOURCE');
  client.socket.close(); await once(client.socket, 'close');
  await until(() => Object.keys(f.sending).length === 0);
  const manager = new RtcManager(); t.after(() => manager.dispose());
  const provider = new DesktopBridgeProvider({ id: 'desktop', url: f.url, token, selfId: '1', platform: 'test' }); await manager.register(provider); await until(() => manager.listCalls().length === 1);
  const owner = manager.controller('framing'), id = manager.listCalls()[0]!.id; owner.claim(id);
  const state = await owner.sendVideo(id, { kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe' });
  assert.equal(state.sending.camera?.framing, 'portrait-safe');
  assert.equal(f.operations.filter(x => x.op === 'send').at(-1).framing, 'portrait-safe');
});

test('QQ maps explicit framing unchanged to the native video controller', async t => {
  const control = new QqControl({ url: 'http://127.0.0.1', token, selfId: '1' }); let submitted: any;
  control.verify = async () => ({ selfId: '1', bootId: 'boot' }); control.bootId = 'boot'; control.linkEpoch = 2; control.offline = false; control.stopped = false;
  control.calls.set('boot:2:local', { ...snapshot(), id: 'boot:2:local', nativeId: 'native' });
  control.request = async (route: string, args: any) => { assert.equal(route, '/v1/video/send'); submitted = args; return { sessionId: 'native', supported: true, tracks: [], sending: { camera: { sourceId: args.sourceId, state: 'sending', framing: args.framing } } }; };
  t.after(() => control.stop());
  await control.video('send', { callId: 'boot:2:local', kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe' });
  assert.deepEqual(submitted, { callId: 'native', kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe' });
  await assert.rejects(control.video('send', { callId: 'boot:2:local', kind: 'screen', sourceId: 'external-frames', framing: 'full' }), (e: any) => e.code === 'INVALID_SOURCE');
});
