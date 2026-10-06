import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createVideoConsumer } from './video-consumer.ts';
import { RtcManager, RtcError, unavailableCapabilities } from '../src/core.ts';

const expected = { providerId: 'qq', platform: 'onebot', selfId: 'self', kind: 'group', targetId: 'group' };
function setup({ failStart, failStop } = {}) {
  const logs = [], hooks = new Map();
  const call = { id: 'call', providerId: 'qq', account: { platform: 'onebot', selfId: 'self' }, kind: 'group', targetId: 'group', state: 'connected', participants: [{ id: 'peer', identity: 'platform' }] };
  const manager = new EventEmitter();
  manager.getCall = () => structuredClone(call);
  manager.controller = owner => ({
    claim() { logs.push('claim'); call.owner = owner; },
    async videoSources() { return ['camera', 'screen'].map(kind => ({ id: 'external-frames', sourceType: 'frames', kind, channels: [kind] })); },
    async sendVideo(id, { kind }) { logs.push(`start:${kind}`); if (kind === failStart) throw new Error('start failed'); },
    async stopVideo(id, kind) { logs.push(`stop:${kind}`); if (kind === failStop) throw new Error('stop failed'); },
    async writeVideo(id, frame) { logs.push(`write:${frame.kind}:${frame.sequence}:${frame.data[0]}`); return { callId: id, ...frame, state: 'submitted', evidence: 'fake' }; },
    async subscribeVideo(id, { participantId, kind }) { logs.push(`subscribe:${kind}`); return { trackId: `${participantId}:${kind}` }; },
    async unsubscribeVideo(id, trackId) { logs.push(`unsubscribe:${trackId}`); },
    async *video(id, trackId, { signal }) { yield { callId: id, trackId }; await delay(10000, undefined, { signal }); },
    async release() { logs.push('release'); delete call.owner; },
    async dispose() { logs.push('dispose'); },
  });
  const ctx = { rtc: { manager }, on(event, fn) { hooks.set(event, fn); } };
  return { video: createVideoConsumer(ctx, 'test'), logs, manager, call, hooks };
}
const input = value => async function*() { yield { data: Uint8Array.of(value), width: 2, height: 2 }; yield { data: Uint8Array.of(value), width: 2, height: 2 }; };
const request = more => ({ callId: 'call', expected, receive: [], signal: new AbortController().signal, ...more });

test('two explicit independent JPEG sources have separate sequences and stop before release', async () => {
  const { video, logs } = setup();
  assert.deepEqual(logs, []);
  await video.run(request({ outputs: { camera: input(1), screen: input(2) } }));
  assert.deepEqual(logs.filter(v => v.startsWith('write:')).sort(), ['write:camera:0:1', 'write:camera:1:1', 'write:screen:0:2', 'write:screen:1:2']);
  assert.ok(logs.indexOf('stop:camera') < logs.indexOf('release'));
  assert.ok(logs.indexOf('stop:screen') < logs.indexOf('release'));
});
test('a partial second-channel start cleans both channels and releases', async () => {
  const { video, logs } = setup({ failStart: 'screen' });
  await assert.rejects(video.run(request({ outputs: { camera: input(1), screen: input(2) } })), AggregateError);
  assert.ok(logs.includes('stop:camera')); assert.ok(logs.includes('stop:screen'));
  assert.equal(logs.at(-1), 'release'); assert.ok(!logs.some(v => v.startsWith('write:')));
});
test('plugin disposal interrupts a pending abort-aware source then stops and releases', async () => {
  const { video, logs, hooks } = setup();
  async function* pending(signal) { try { await delay(10000, undefined, { signal }); } finally { logs.push('source:closed'); } }
  const run = video.run(request({ outputs: { camera: pending } }));
  await delay(5); await hooks.get('dispose')(); await run;
  assert.ok(logs.indexOf('source:closed') < logs.indexOf('stop:camera'));
  assert.ok(logs.indexOf('stop:camera') < logs.indexOf('release')); assert.equal(logs.at(-1), 'dispose');
});
test('cleanup failure is reported while lease release still runs', async () => {
  const { video, logs } = setup({ failStop: 'camera' });
  await assert.rejects(video.run(request({ outputs: { camera: input(1) } })), AggregateError);
  assert.equal(logs.at(-1), 'release');
});

const until = async condition => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(2); }
  assert.fail('condition timed out');
};
async function realManagerFixture(t, { stopFailure } = {}) {
  const manager = new RtcManager(), events = new EventEmitter(), hooks = new Map();
  let call = { id: 'call', providerId: 'qq', account: { platform: 'onebot', selfId: 'self' }, kind: 'group', targetId: 'group', direction: 'incoming', state: 'connected', createdAt: 1, updatedAt: 1, muted: false, participants: [{ id: 'peer', identity: 'platform' }] };
  const tracks = new Map(), sending = {}, log = [], received = [];
  let sourceStarts = 0, writes = 0, clears = 0;
  const state = () => ({ callId: call.id, supported: true, tracks: [...tracks.values()], sending: { ...sending } });
  const provider = {
    id: 'qq', account: call.account, events,
    capabilities: () => Object.fromEntries(Object.keys(unavailableCapabilities()).map(key => [key, { supported: true }])),
    start: async () => {}, stop: async () => {}, diagnostics: async () => [], calls: () => [call],
    dial: async () => { throw new Error('unexpected dial'); }, accept: async () => {}, reject: async () => {},
    hangup: async () => { throw new Error('unexpected hangup'); }, setMuted: async () => {},
    writeAudio: async () => { throw new Error('unexpected audio'); }, clearAudio: async () => {},
    videoSources: async () => ['camera', 'screen'].map(kind => ({ id: 'external-frames', sourceType: 'frames', kind, channels: [kind] })),
    videoState: async () => state(),
    subscribeVideo: async (_id, request) => { const track = { ...request, trackId: `peer:${request.kind}`, subscribed: true, available: true, hasFrame: false }; tracks.set(track.trackId, track); return track; },
    unsubscribeVideo: async (_id, trackId) => { log.push(`unsubscribe:${trackId}`); tracks.delete(trackId); },
    sendVideo: async (_id, request) => { sending[request.kind] = { sourceId: request.sourceId, state: 'sending' }; return state(); },
    stopVideo: async (_id, kind) => { log.push(`stop:${kind}`); if (stopFailure) await stopFailure(kind); delete sending[kind]; return state(); },
    clearVideo: async () => { clears++; log.push('clear'); tracks.clear(); for (const kind of Object.keys(sending)) delete sending[kind]; },
    writeVideo: async frame => { writes++; return { callId: frame.callId, kind: frame.kind, sequence: frame.sequence, state: 'submitted', evidence: 'fake-native', acceptedBytes: frame.data.length }; },
  };
  await manager.register(provider);
  // Capture the real controller only to exercise explicit release during a task.
  const createController = manager.controller.bind(manager); let controller;
  manager.controller = owner => controller = createController(owner);
  const video = createVideoConsumer({ rtc: { manager }, on: (event, handler) => hooks.set(event, handler) }, 'real-test');
  t.after(async () => { await video.dispose().catch(() => {}); await manager.dispose(); });
  async function* input(signal) {
    sourceStarts++;
    yield { data: Uint8Array.of(255, 216, 1, 255, 217), width: 2, height: 2 };
    await delay(10000, undefined, { signal });
  }
  const selection = request({ receive: [{ participantId: 'peer', kind: 'camera' }, { participantId: 'peer', kind: 'screen' }], outputs: { camera: input, screen: input }, onFrame: frame => { received.push(frame); } });
  const publish = patch => { call = { ...call, ...patch, updatedAt: Date.now() }; events.emit('event', { type: 'call', call }); };
  return { manager, video, hooks, selection, tracks, sending, log, publish, controller: () => controller,
    counts: () => ({ sourceStarts, writes, clears }),
    frame: kind => events.emit('event', { type: 'video', video: { callId: 'call', participantId: 'peer', trackId: `peer:${kind}`, kind, encoding: 'jpeg', width: 2, height: 2, sequence: 0, timestamp: 1, evidence: 'native-first-frame-and-render-capture', data: Uint8Array.of(255, 216, 1, 255, 217) } }), received };
}

for (const terminal of ['ended', 'failed']) test(`real manager ${terminal} revokes receive/send leases without a spurious cleanup error`, async t => {
  const f = await realManagerFixture(t), run = f.video.run(f.selection);
  await until(() => f.counts().writes === 2); f.frame('camera'); f.frame('screen');
  await until(() => f.received.length === 2);
  f.publish({ state: terminal }); await run;
  await until(() => f.counts().clears === 1);
  assert.equal(f.manager.getCall('call').owner, undefined); assert.equal(f.tracks.size, 0); assert.deepEqual(f.sending, {});
  assert.ok(!f.log.some(item => item.startsWith('stop:')), 'terminal cleanup is owned by the manager');
});

test('real controller release during an active video task is an expected lease loss', async t => {
  const f = await realManagerFixture(t), run = f.video.run(f.selection);
  await until(() => f.counts().writes === 2);
  await f.controller().release('call'); await run;
  assert.equal(f.manager.getCall('call').state, 'connected'); assert.equal(f.manager.getCall('call').owner, undefined);
  assert.deepEqual(f.sending, {});
});

test('real manager plugin disposal stops active channels before releasing its lease', async t => {
  const f = await realManagerFixture(t), run = f.video.run(f.selection);
  await until(() => f.counts().writes === 2);
  await f.hooks.get('dispose')(); await run;
  assert.ok(f.log.includes('stop:camera')); assert.ok(f.log.includes('stop:screen'));
  assert.equal(f.manager.getCall('call').owner, undefined); assert.deepEqual(f.sending, {});
});

test('CALL_ENDED from a backend stop is not hidden while the real manager still owns a connected call', async t => {
  const f = await realManagerFixture(t, { stopFailure: () => { throw new RtcError('CALL_ENDED', 'backend stop really failed'); } });
  const run = f.video.run(f.selection); const rejected = assert.rejects(run, error => error instanceof AggregateError && error.errors.some(item => item.message === 'backend stop really failed'));
  await until(() => f.counts().writes === 2); await assert.rejects(f.video.stop('call'), AggregateError); await rejected;
  assert.equal(f.manager.getCall('call').owner, undefined);
});

test('native stop failure remains visible if the call ends while stop is pending', async t => {
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const f = await realManagerFixture(t, { stopFailure: async () => { enter(); await gate; throw new RtcError('NATIVE_VIDEO_ERROR', 'native stop failed'); } });
  const run = f.video.run(f.selection); const rejected = assert.rejects(run, error => error instanceof AggregateError && error.errors.some(item => item.code === 'NATIVE_VIDEO_ERROR'));
  await until(() => f.counts().writes === 2); const stopped = assert.rejects(f.video.stop('call'), AggregateError);
  await entered; f.publish({ state: 'ended' }); finish(); await stopped; await rejected;
  assert.equal(f.manager.getCall('call').owner, undefined);
});
