import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LiveKitProvider } from '../src/providers/livekit.js';
import { KookProvider } from '../src/providers/kook.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function livekitFixture() {
  class Resource {
    closed = false;
    async close() { this.closed = true; }
  }
  class AudioSource extends Resource { clearQueue() {} }
  class VideoSource extends Resource {}
  const outputs = new Map<string, { track: Resource; source: VideoSource }>();
  const unpublish: string[] = [], failures = new Set<string>();
  class Room extends EventEmitter {
    name = 'cleanup-room';
    remoteParticipants = new Map();
    localParticipant = {
      identity: 'cleanup-user',
      publishTrack: async (track: Resource & { name?: string }) => ({ sid: track.name ?? 'audio' }),
      unpublishTrack: async (sid: string) => {
        unpublish.push(sid);
        if (failures.has(sid)) throw new Error('remote unpublish unavailable');
      },
    };
    async connect() {}
    async disconnect() { this.emit('disconnected'); }
  }
  const sdk = {
    AudioSource, VideoSource, Room,
    LocalAudioTrack: { createAudioTrack: () => new Resource() },
    LocalVideoTrack: { createVideoTrack: (name: string, source: VideoSource) => {
      const track = Object.assign(new Resource(), { name });
      outputs.set(name, { track, source });
      return track;
    } },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1, SOURCE_CAMERA: 2, SOURCE_SCREENSHARE: 3 },
    RoomEvent: { Disconnected: 'disconnected', Reconnecting: 'reconnecting', TrackPublished: 'published',
      TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed', TrackUnpublished: 'unpublished',
      ParticipantConnected: 'participant', ParticipantDisconnected: 'left', ActiveSpeakersChanged: 'speakers' },
  };
  const provider = new LiveKitProvider({ id: 'cleanup-lk', url: 'ws://127.0.0.1:17880', apiKey: 'test-key',
    apiSecret: 'test-secret', selfId: 'cleanup-user', roomNames: ['cleanup-room'] },
  { sdk: async () => sdk as any, token: async () => 'offline-token' });
  return { provider, outputs, unpublish, failures,
    join: () => provider.dial({ kind: 'group', targetId: 'cleanup-room' }) };
}

test('LiveKit failed unpublish closes local resources and retains a failed output for a real retry', { timeout: 5000 }, async () => {
  const f = livekitFixture();
  try {
    await f.provider.start(); const call = await f.join();
    await f.provider.sendVideo(call.id, { kind: 'camera', sourceId: 'external-frames' });
    const output = f.outputs.get('rtc-camera')!;
    f.failures.add('rtc-camera');
    await assert.rejects(f.provider.stopVideo(call.id, 'camera'), /unpublish/);
    assert.equal(output.track.closed, true);
    assert.equal(output.source.closed, true);
    assert.equal((await f.provider.videoState(call.id)).sending.camera?.state, 'failed');
    await assert.rejects(f.provider.stopVideo(call.id, 'camera'), /unpublish/);
    assert.deepEqual(f.unpublish, ['rtc-camera', 'rtc-camera'], 'retry must contact the server again');
    f.failures.clear();
    assert.equal((await f.provider.stopVideo(call.id, 'camera')).sending.camera, undefined);
    assert.equal(f.unpublish.length, 3);
  } finally { await f.provider.stop(); }
});

test('LiveKit clearVideo cleans every channel even when one remote unpublish fails', { timeout: 5000 }, async () => {
  const f = livekitFixture();
  try {
    await f.provider.start(); const call = await f.join();
    await f.provider.sendVideo(call.id, { kind: 'camera', sourceId: 'external-frames' });
    await f.provider.sendVideo(call.id, { kind: 'screen', sourceId: 'external-frames' });
    f.failures.add('rtc-camera');
    await assert.rejects(f.provider.clearVideo(call.id), /unpublish/);
    assert.deepEqual(new Set(f.unpublish), new Set(['rtc-camera', 'rtc-screen']));
    for (const output of f.outputs.values()) {
      assert.equal(output.track.closed, true);
      assert.equal(output.source.closed, true);
    }
    const state = await f.provider.videoState(call.id);
    assert.equal(state.sending.camera?.state, 'failed');
    assert.equal(state.sending.screen, undefined);
    f.failures.clear(); await f.provider.clearVideo(call.id);
    assert.deepEqual((await f.provider.videoState(call.id)).sending, {});
  } finally { await f.provider.stop(); }
});

function kookFixture() {
  const codecs: Array<{ deleted: number; encode: () => Buffer; encoderCTL: () => void; delete: () => void }> = [];
  function codec() {
    const value = { deleted: 0, encode: () => Buffer.alloc(10), encoderCTL() {}, delete() { this.deleted++; } };
    codecs.push(value); return value;
  }
  class Socket extends EventEmitter {
    closed = 0;
    bind(_port: number, done: () => void) { queueMicrotask(done); }
    close() { this.closed++; }
  }
  const sockets: Socket[] = [], requests: string[] = [], timers = new Set<() => void>();
  let failLeave = false, remoteJoined = false;
  let nextCodec: ReturnType<typeof deferred<ReturnType<typeof codec>>> | undefined;
  let codecEntered: ReturnType<typeof deferred> | undefined;
  let nextLeave: ReturnType<typeof deferred> | undefined;
  const provider = new KookProvider({ id: 'cleanup-kook', token: 'test-token', selfId: '123', channelIds: ['456'] }, {
    codec: async () => {
      if (!nextCodec) return codec();
      const pending = nextCodec; nextCodec = undefined; codecEntered!.resolve();
      return pending.promise;
    },
    socket: () => { const socket = new Socket(); sockets.push(socket); return socket as any; },
    every: fn => { timers.add(fn); return () => { timers.delete(fn); }; },
    fetch: (async (url: string | URL | Request) => {
      const route = String(url).split('/v3/')[1]!; requests.push(route);
      if (route === 'voice/leave') {
        if (failLeave) throw new Error('leave network unavailable');
        const pending = nextLeave; nextLeave = undefined;
        if (pending) await pending.promise;
        remoteJoined = false;
      }
      if (route === 'voice/join') remoteJoined = true;
      const data = route === 'user/me' ? { id: '123', bot: true }
        : route === 'voice/list' ? { items: remoteJoined ? [{ id: '456' }] : [] }
          : route === 'voice/join' ? { ip: '127.0.0.1', port: 9999, rtcp_mux: true, audio_ssrc: '1111', audio_pt: '111', bitrate: 48000 } : {};
      return new Response(JSON.stringify({ code: 0, data }));
    }) as typeof fetch,
  });
  return { provider, codecs, sockets, requests, timers,
    join: () => provider.dial({ kind: 'group', targetId: '456' }),
    failLeave(value: boolean) { failLeave = value; },
    remoteJoined: () => remoteJoined,
    holdCodec() {
      nextCodec = deferred<ReturnType<typeof codec>>(); codecEntered = deferred();
      const pending = nextCodec, entered = codecEntered, value = codec();
      return { value, entered: entered.promise, resolve: () => pending.resolve(value) };
    },
    holdLeave() { const pending = deferred(); nextLeave = pending; return pending; },
    async dispose() { failLeave = false; nextLeave?.resolve(); await provider.stop(); },
  };
}

test('KOOK stop frees UDP and Opus when remote leave fails while preserving uncertain occupancy', { timeout: 5000 }, async () => {
  const f = kookFixture();
  try {
    await f.provider.start(); const call = await f.join();
    const sessionCodec = f.codecs[1]!;
    f.failLeave(true); await f.provider.stop();
    assert.equal(f.sockets[0]!.closed, 1);
    assert.equal(sessionCodec.deleted, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.provider.calls().find(item => item.id === call.id)!.state, 'ending');
    assert.equal(f.remoteJoined(), true, 'a failed leave is not proof the remote room ended');
    await f.provider.start();
    await assert.rejects(f.join(), (error: any) => error.code === 'ACCOUNT_BUSY');
    f.failLeave(false); await f.provider.hangup(call.id);
    assert.equal(f.provider.calls().find(item => item.id === call.id)!.state, 'ended');
    assert.equal(sessionCodec.deleted, 1, 'retry does not double-release the codec');
  } finally { await f.dispose(); }
});

test('KOOK hanging up during codec initialization releases the late codec without ever joining', { timeout: 5000 }, async () => {
  const f = kookFixture(); let held: ReturnType<typeof f.holdCodec> | undefined;
  try {
    await f.provider.start(); held = f.holdCodec();
    const joining = f.join(), rejected = assert.rejects(joining);
    await held.entered;
    const call = f.provider.calls().at(-1)!;
    const hanging = f.provider.hangup(call.id);
    await turn();
    assert.equal(f.requests.includes('voice/join'), false);
    held.resolve(); await Promise.all([rejected, hanging]);
    assert.equal(f.requests.includes('voice/join'), false, 'late initialization cannot resurrect the cancelled call');
    assert.equal(held.value.deleted, 1);
    assert.equal(f.sockets.length, 0);
    assert.ok(['ended', 'failed'].includes(f.provider.calls().find(item => item.id === call.id)!.state));
  } finally { held?.resolve(); await f.dispose(); }
});

test('KOOK concurrent hangups share one leave and cannot let stale cleanup terminate a new call', { timeout: 5000 }, async () => {
  const f = kookFixture(); let leave: ReturnType<typeof f.holdLeave> | undefined;
  try {
    await f.provider.start(); const call = await f.join(); leave = f.holdLeave();
    const first = f.provider.hangup(call.id), second = f.provider.hangup(call.id);
    await turn();
    assert.equal(f.requests.filter(route => route === 'voice/leave').length, 1);
    await assert.rejects(f.join(), (error: any) => error.code === 'ACCOUNT_BUSY');
    leave.resolve(); await first;
    const next = await f.join();
    await second; await turn();
    assert.equal(next.state, 'connected');
    assert.equal(f.remoteJoined(), true);
    assert.equal(f.requests.filter(route => route === 'voice/leave').length, 1, 'no old leave follows the new join');
    assert.equal(f.sockets[0]!.closed, 1);
    assert.equal(f.sockets[1]!.closed, 0);
  } finally { leave?.resolve(); await f.dispose(); }
});
