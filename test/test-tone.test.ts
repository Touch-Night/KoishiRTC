import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RtcError, RtcManager, unavailableCapabilities, type AudioFrame, type CallProvider, type CallSnapshot, type PlaybackReceipt } from '../src/core.js';
import { playTestTone } from '../src/test-tone.js';

async function fixture() {
  const manager = new RtcManager(), events = new EventEmitter();
  const call: CallSnapshot = { id: 'c', providerId: 'p', account: { platform: 'test', selfId: '1' }, kind: 'direct', targetId: '2', direction: 'outgoing', state: 'connected', createdAt: 1, updatedAt: 1, participants: [], muted: false };
  const format = { encoding: 'pcm_s16le' as const, sampleRate: 48000, channels: 1 as const }, writes: PlaybackReceipt[] = [];
  const emit = (receipt: PlaybackReceipt) => events.emit('event', { type: 'playback', playback: receipt });
  const provider: CallProvider = { id: 'p', account: call.account, events, audioFormat: format,
    capabilities: () => Object.fromEntries(Object.keys(unavailableCapabilities()).map(k => [k, { supported: true }])) as any,
    calls: () => [call], start: async () => {}, stop: async () => {}, dial: async () => call,
    accept: async () => {}, reject: async () => {}, hangup: async () => {}, setMuted: async () => {}, clearAudio: async () => {}, diagnostics: async () => [],
    writeAudio: async (frame, id) => { const receipt: PlaybackReceipt = { id, callId: frame.callId, state: 'queued', acceptedBytes: frame.data.length, playedBytes: 0 }; writes.push(receipt); return receipt; },
  };
  await manager.register(provider); const owner = manager.controller('console:test'); owner.claim('c');
  return { manager, owner, provider, emit, writes, format, run: (timeout = 100) => playTestTone(manager, owner, 'c', format, () => {}, timeout) };
}
test('test tone waits for playback evidence and ignores an older queued write reply', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose());
  const original = f.provider.writeAudio;
  f.provider.writeAudio = async (frame, id) => { const queued = await original(frame, id); f.emit({ ...queued, state: 'played', playedBytes: queued.acceptedBytes }); return queued; };
  const result = await f.run(); assert.equal(result.state, 'played'); assert.equal(f.writes.length, 1);
  assert.match(result.message, /本机/); assert.equal(f.manager.listenerCount('playback'), 0);
});
test('test tone reports later worker failure instead of queued success', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose());
  const pending = f.run(); const rejected = assert.rejects(pending, /output failed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  f.emit({ ...f.writes[0], state: 'failed', error: 'output failed' }); await rejected;
  assert.equal(f.manager.listenerCount('playback'), 0);
});
test('test tone distinguishes unconfirmed, dispatched and cancelled output', async t => {
  for (const state of ['unconfirmed', 'dispatched', 'cancelled'] as const) {
    const f = await fixture(); t.after(() => f.manager.dispose());
    const original = f.provider.writeAudio;
    if (state !== 'unconfirmed') f.provider.writeAudio = async (frame, id) => ({ ...await original(frame, id), state });
    if (state === 'cancelled') await assert.rejects(f.run(), /停止或静音/);
    else assert.equal((await f.run(10)).state, state);
    assert.equal(f.manager.listenerCount('playback'), 0);
  }
});
test('ending the call interrupts receipt waiting without replaying the tone', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose());
  const result = f.run(); const rejected = assert.rejects(result, /通话已结束/);
  await new Promise(resolve => setTimeout(resolve, 0)); await f.owner.release('c'); await rejected;
  assert.equal(f.writes.length, 1); assert.equal(f.manager.listenerCount('playback'), 0);
});

test('slow RPC replies cannot split a test cue into separate writes, and later clicks never replay old IDs', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose());
  const captured: { frame: AudioFrame; id: string }[] = [], original = f.provider.writeAudio;
  f.provider.writeAudio = async (frame, id) => {
    captured.push({ frame, id }); const queued = await original(frame, id);
    // Longer than Pulse's idle drain. The complete cue must already be submitted
    // before this pause, with no second half waiting for another RPC round trip.
    await new Promise(resolve => setTimeout(resolve, 150));
    f.emit({ ...queued, state: 'played', playedBytes: queued.acceptedBytes }); return queued;
  };
  for (let click = 0; click < 3; click++) {
    const result = await f.run(); assert.equal(result.state, 'played'); assert.equal(result.queuedMs, 400);
    assert.equal(captured.length, click + 1, 'one click submits exactly one contiguous PCM buffer');
  }
  assert.equal(new Set(captured.map(item => item.id)).size, 3);
  for (const { frame } of captured) {
    const pcm = Buffer.from(frame.data); assert.equal(pcm.length, 38400); assert.equal(frame.sequence, 0);
    assert.deepEqual(pcm, Buffer.from(captured[0].frame.data));
    // Check a 440Hz sinusoid against absolute sample position across the old
    // 20ms boundaries, with fades only at the beginning and end of the cue.
    for (let i = 0; i < 19200; i++) {
      const fade = Math.min(1, i / 720, (19200 - i) / 720);
      assert.equal(pcm.readInt16LE(i * 2), Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 2500 * fade) || 0);
    }
  }
});

test('stop, release and session expiry override an early played receipt while the write reply is pending', async t => {
  for (const action of ['abort', 'release', 'session'] as const) {
    const f = await fixture(); t.after(() => f.manager.dispose()); const abort = new AbortController();
    let unblock!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const original = f.provider.writeAudio;
    f.provider.writeAudio = async (frame, id) => {
      const queued = await original(frame, id); f.emit({ ...queued, state: 'played', playedBytes: queued.acceptedBytes });
      started(); await blocked; return queued;
    };
    let authorized = true;
    const pending = playTestTone(f.manager, f.owner, 'c', f.format, () => { if (!authorized) throw new Error('会话权限已失效'); }, 100, abort.signal);
    const rejected = assert.rejects(pending, action === 'abort' ? /测试音已停止/ : action === 'session' ? /会话权限/ : /控制权/);
    await entered;
    // Hold cleanup too: snapshot.owner can remain set while its lease is already
    // revoked. Checking only the visible owner must not permit a success result.
    let finishClear!: () => void;
    f.provider.clearAudio = () => new Promise<void>(resolve => { finishClear = resolve; });
    const releasing = action === 'release' ? f.owner.release('c') : undefined;
    if (action === 'abort') abort.abort();
    if (action === 'session') authorized = false;
    unblock(); await rejected;
    if (releasing) { finishClear(); await releasing; }
    assert.equal(f.writes.length, 1); assert.equal(f.manager.listenerCount('playback'), 0);
    // Avoid retaining the blocked cleanup implementation for fixture disposal.
    f.provider.clearAudio = async () => {};
  }
});

test('queue limits reject the complete cue without smaller-chunk retries or listener leaks', async t => {
  const f = await fixture(); t.after(() => f.manager.dispose()); let attempts = 0;
  f.provider.writeAudio = async () => { attempts++; throw new RtcError('BACKPRESSURE', 'Audio write exceeds maxQueueMs'); };
  await assert.rejects(f.run(), { code: 'BACKPRESSURE' }); assert.equal(attempts, 1);
  assert.equal(f.manager.listenerCount('playback'), 0); assert.equal(f.manager.listenerCount('call'), 0);
});
