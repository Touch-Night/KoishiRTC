import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RtcManager, unavailableCapabilities, type CallProvider, type CallSnapshot, type VideoSendRequest } from '../src/core.js';
const delay = (ms = 0) => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await delay(5); assert.ok(check()); }
const initialVideo: VideoSendRequest[] = [{ kind: 'camera', sourceId: 'generated-camera' }, { kind: 'screen', sourceId: 'generated-screen' }];
async function fixture() {
  const manager = new RtcManager(), events = new EventEmitter(), diagnostics: any[] = [], operations: any[] = [];
  const capabilities = Object.fromEntries(Object.keys(unavailableCapabilities()).map(k => [k, { supported: true }])) as any;
  let call: CallSnapshot = { id: 'call', providerId: 'p', account: { platform: 'fixture', selfId: 'self' }, kind: 'direct', targetId: 'peer', direction: 'outgoing', state: 'dialing', createdAt: 1, updatedAt: 1, participants: [], muted: false };
  const sending: any = {}, state = () => ({ callId: call.id, supported: true, tracks: [], sending: structuredClone(sending) });
  const publish = (patch: Partial<CallSnapshot>) => { call = { ...call, ...patch }; events.emit('event', { type: 'call', call }); };
  const provider: CallProvider = { id: 'p', account: call.account, events, capabilities: () => capabilities,
    start: async () => {}, stop: async () => {}, calls: () => [], diagnostics: async () => [],
    dial: async request => { operations.push({ op: 'dial', request }); return call; },
    accept: async () => {}, reject: async () => publish({ state: 'ended' }), hangup: async () => { operations.push({ op: 'hangup' }); publish({ state: 'ended' }); },
    setMuted: async () => {}, clearAudio: async () => {}, writeAudio: async(f, id) => ({ id, callId: f.callId, acceptedBytes: f.data.length, playedBytes: 0, state: 'queued' }),
    videoSources: async () => { operations.push({ op: 'sources' }); return [...initialVideo, { kind: 'camera' as const, sourceId: 'new-camera' }].map(s => ({ id: s.sourceId, name: s.sourceId, kind: s.kind, sourceType: 'generated' as const })); },
    videoState: async () => state(),
    sendVideo: async(_id, request) => { operations.push({ op: 'send', ...request }); sending[request.kind] = { sourceId: request.sourceId, state: 'sending' }; return state(); },
    stopVideo: async(_id, kind) => { operations.push({ op: 'stop', kind }); delete sending[kind]; return state(); },
    clearVideo: async () => { operations.push({ op: 'clear' }); for (const k of Object.keys(sending)) delete sending[k]; },
  };
  manager.on('diagnostic', d => diagnostics.push(d)); await manager.register(provider);
  const owner = manager.controller('fixture-owner');
  return { manager, owner, provider, publish, events, capabilities, operations, diagnostics, sending,
    dial: (signal?: AbortSignal) => owner.dial('p', { kind: 'direct', targetId: 'peer', media: 'video', initialVideo }, signal) };
}

test('initial video starts explicit channels once after connected, never inside provider dial', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); await f.dial();
  assert.deepEqual(f.operations.map(x => x.op), ['dial']); assert.equal(f.operations[0].request.initialVideo, undefined);
  f.publish({ state: 'connected' }); await until(() => f.operations.filter(x => x.op === 'send').length === 2);
  assert.deepEqual(f.operations.filter(x => x.op === 'send').map(({ kind, sourceId }) => ({ kind, sourceId })), initialVideo);
  assert.equal(f.manager.getCall('call').owner, 'fixture-owner'); f.publish({ state: 'connected' }); await delay(10);
  assert.equal(f.operations.filter(x => x.op === 'send').length, 2);
});

test('audio and video invitations without initialVideo never open any source', async t => {
  for (const media of ['audio', 'video'] as const) {
    const f = await fixture(); t.after(() => f.manager.dispose());
    await f.owner.dial('p', { kind: 'direct', targetId: 'peer', media }); f.publish({ state: 'connected' }); await delay(5);
    assert.deepEqual(f.operations.map(x => x.op), ['dial']);
  }
});

test('invalid initial plans fail before dial and absent explicit sources never fall back', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose());
  for (const plan of [[], [initialVideo[0], initialVideo[0]], [{ kind: 'camera', sourceId: '' }], [{ kind: 'screen', sourceId: 'generated-screen', framing: 'portrait-safe' }]]) {
    await assert.rejects(f.owner.dial('p', { kind: 'direct', targetId: 'peer', initialVideo: plan as any }), (e: any) => e.code === 'INVALID_SOURCE');
  }
  assert.equal(f.operations.length, 0);
  await f.owner.dial('p', { kind: 'direct', targetId: 'peer', initialVideo: [{ kind: 'camera', sourceId: 'missing-device' }] });
  f.publish({ state: 'connected' }); await until(() => f.diagnostics.length === 1);
  assert.match(f.diagnostics[0].error, /初始 camera.*来源/); assert.equal(f.operations.filter(x => x.op === 'send').length, 0);
  assert.equal(f.manager.getCall('call').state, 'connected');
});

test('initial source waits for asynchronously discovered capability after connection', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); f.capabilities.sendVideo.supported = false; f.capabilities.shareScreen.supported = false;
  await f.dial(); f.publish({ state: 'connected' }); await delay(10); assert.equal(f.operations.filter(x => x.op === 'sources').length, 0);
  f.capabilities.sendVideo.supported = true; f.capabilities.shareScreen.supported = true; f.events.emit('event', { type: 'availability' });
  await until(() => f.operations.filter(x => x.op === 'send').length === 2);
});

test('release, dispose, hangup and abort cancel waiting plans; stopping one channel leaves the other explicit plan', async t => {
  for (const action of ['release', 'dispose', 'hangup', 'abort', 'stop'] as const) {
    const f = await fixture(); t.after(() => f.manager.dispose()); const abort = new AbortController(); await f.dial(abort.signal);
    if (action === 'abort') abort.abort(); else if (action === 'stop') await f.owner.stopVideo('call', 'camera');
    else if (action === 'dispose') await f.owner.dispose(); else await f.owner[action]('call');
    f.publish({ state: 'connected' }); await delay(10);
    assert.deepEqual(f.operations.filter(x => x.op === 'send').map(x => x.kind), action === 'stop' ? ['screen'] : [], action);
  }
});

test('a disposed or aborted caller never arms a late successful dial', async t => {
  for (const action of ['dispose', 'abort'] as const) {
    const f = await fixture(); t.after(() => f.manager.dispose()); const gate = deferred(), original = f.provider.dial; let entered = false;
    f.provider.dial = async (r, signal) => { entered = true; await gate.promise; const call = await original(r, signal); return { ...call, state: 'connected' }; };
    const abort = new AbortController(), dial = f.dial(abort.signal); const rejected = assert.rejects(dial, (e: any) => e.code === (action === 'dispose' ? 'DISPOSED' : 'ABORTED'));
    await until(() => entered); if (action === 'dispose') await f.owner.dispose(); else abort.abort(); gate.resolve(); await rejected;
    assert.equal(f.operations.filter(x => x.op === 'send').length, 0); assert.equal(f.manager.getCall('call').owner, undefined);
  }
});

test('stopping while source discovery is pending prevents the later source from starting', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); const gate = deferred(), original = f.provider.videoSources!; let entered = false;
  f.provider.videoSources = async id => { entered = true; await gate.promise; return original(id); };
  await f.owner.dial('p', { kind: 'direct', targetId: 'peer', initialVideo: [initialVideo[0]] }); f.publish({ state: 'connected' }); await until(() => entered);
  const stopped = f.owner.stopVideo('call', 'camera'); gate.resolve(); await stopped; await delay(5);
  assert.equal(f.operations.filter(x => x.op === 'send').length, 0);
});

test('late initial start is cleaned before a new explicit source and cannot stop the new source', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); const gate = deferred(), original = f.provider.sendVideo!; let entered = false;
  f.provider.sendVideo = async (id, r) => { if (r.sourceId === 'generated-camera') { entered = true; await gate.promise; } return original(id, r); };
  await f.owner.dial('p', { kind: 'direct', targetId: 'peer', initialVideo: [initialVideo[0]] }); f.publish({ state: 'connected' }); await until(() => entered);
  const replacement = f.owner.sendVideo('call', { kind: 'camera', sourceId: 'new-camera' }); gate.resolve(); await replacement; await delay(5);
  assert.deepEqual(f.operations.filter(x => ['send', 'stop'].includes(x.op)).map(x => x.op === 'send' ? x.sourceId : 'stop'), ['generated-camera', 'stop', 'new-camera']);
  assert.equal(f.sending.camera.sourceId, 'new-camera');
});

test('a provider removal cancels initial sources even if an old callback later says connected', async () => {
  const f = await fixture(); await f.dial(); await f.manager.unregister('p'); f.publish({ state: 'connected' }); await delay(5);
  assert.equal(f.operations.filter(x => x.op === 'send').length, 0); await f.manager.dispose();
});

test('pre-call discovery is read-only and rejects a result from an unloaded provider', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose());
  const gate = deferred(); f.provider.availableVideoSources = async () => { await gate.promise; return [{ id: 'generated', name: 'Generated', kind: 'camera', sourceType: 'generated' }]; };
  const pending = f.manager.availableVideoSources('p'); const rejected = assert.rejects(pending, (e: any) => e.code === 'PROVIDER_OFFLINE');
  await f.manager.unregister('p'); gate.resolve(); await rejected;
  assert.deepEqual(f.operations, []); assert.deepEqual(f.manager.listCalls(), []);
});

test('unready capability expires once without opening devices or ending the call', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.capabilities.sendVideo.supported = false;
  await f.owner.dial('p', { kind: 'direct', targetId: 'peer', initialVideo: [initialVideo[0]] }); f.publish({ state: 'connected' });
  t.mock.timers.tick(15000); assert.equal(f.diagnostics.length, 1); assert.match(f.diagnostics[0].error, /能力仍未就绪/);
  f.capabilities.sendVideo.supported = true; f.events.emit('event', { type: 'availability' }); await Promise.resolve();
  assert.deepEqual(f.operations.map(x => x.op), ['dial']); assert.equal(f.manager.getCall('call').state, 'connected');
});

test('abort after native submission cleans the late initial source even when its reply is lost', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); const gate = deferred(), original = f.provider.sendVideo!; let entered = false;
  f.provider.sendVideo = async (id, r) => { entered = true; await gate.promise; await original(id, r); throw new Error('reply lost'); };
  const abort = new AbortController(); await f.owner.dial('p', { kind: 'direct', targetId: 'peer', initialVideo: [initialVideo[0]] }, abort.signal);
  f.publish({ state: 'connected' }); await until(() => entered); abort.abort(); gate.resolve(); await until(() => f.operations.some(x => x.op === 'stop'));
  assert.deepEqual(f.sending, {}); assert.equal(f.manager.getCall('call').state, 'connected');
});
