import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveKitProvider, liveKitRotationDegrees } from '../src/providers/livekit.js';
import { validateVideo } from '../src/core.js';
const config = { id: 'lk', url: 'ws://127.0.0.1:17880', apiKey: 'devkey', apiSecret: 'local-test-secret', selfId: 'koishi', roomNames: ['test'] };
const fakeSdk = { AudioSource: class { async close() {} } } as any;
test('LiveKit only allows secure endpoints and an explicit room allowlist', async () => {
  assert.throws(() => new LiveKitProvider({ ...config, url: 'ws://example.com' }), /WSS/);
  assert.throws(() => new LiveKitProvider({ ...config, url: 'wss://user:password@example.com' }), /WSS/);
  const p = new LiveKitProvider({ ...config, roomNames: [] }, { sdk: async () => fakeSdk });
  await p.start(); assert.equal(p.capabilities().joinGroup.supported, false); await assert.rejects(p.dial({ kind: 'group', targetId: 'test' }), /白名单/); await p.stop();
});
test('LiveKit exposes room media capabilities but no fabricated phone invitation', async () => {
  const p = new LiveKitProvider(config, { sdk: async () => fakeSdk }); await p.start();
  assert.equal(p.capabilities().dial.supported, false); assert.equal(p.capabilities().shareScreen.supported, true);
  assert.deepEqual(await p.channels(), [{ id: 'test', name: 'test', kind: 'group', guildName: 'LiveKit 房间' }]);
  await assert.rejects(p.dial({ kind: 'direct', targetId: 'test' }), /房间/); await assert.rejects(p.accept('anything'), /房间/); await p.stop();
});
test('LiveKit stop during pending connect closes a late connection instead of reviving the call', async () => {
  let resolve!: () => void, disconnects = 0;
  class Room extends EventEmitter {
    remoteParticipants = new Map(); name = 'test'; localParticipant = { identity: 'koishi' };
    async connect() { await new Promise<void>(r => { resolve = r; }); }
    async disconnect() { disconnects++; this.emit('disconnected'); }
  }
  const sdk = { ...fakeSdk, Room, RoomEvent: { Disconnected: 'disconnected', Reconnecting: 'reconnecting', TrackPublished: 'published', TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed', TrackUnpublished: 'unpublished', ParticipantConnected: 'connected-person', ParticipantDisconnected: 'left-person', ActiveSpeakersChanged: 'speakers' } };
  const p = new LiveKitProvider(config, { sdk: async () => sdk, token: async () => 'local-only' }); await p.start();
  const pending = p.dial({ kind: 'group', targetId: 'test' }); await new Promise(r => setImmediate(r));
  const stopped = p.stop(); resolve(); await assert.rejects(pending); await stopped;
  assert.ok(disconnects >= 2); assert.ok(['ended','failed'].includes(p.calls()[0]!.state)); assert.equal(p.capabilities().joinGroup.supported, false);
});
test('public video validation accepts actual SDK decode evidence and still rejects invented evidence', () => {
  const base = { callId: 'x', trackId: 'y', participantId: 'z', kind: 'camera' as const, encoding: 'jpeg' as const, width: 1, height: 1, sequence: 0, timestamp: Date.now(), data: Buffer.from([255,216,255,217]) };
  validateVideo({ ...base, evidence: 'livekit-decoded-frame-and-jpeg-encode' }); validateVideo({ ...base, evidence: 'ntgcalls-decoded-frame-and-jpeg-encode' });
  assert.throws(() => validateVideo({ ...base, evidence: 'probably-a-frame' as any }), /JPEG/);
});

test('LiveKit protobuf rotations map to degrees before JPEG encoding', () => { assert.deepEqual([0,1,2,3].map(liveKitRotationDegrees), [0,90,180,270]); assert.equal(liveKitRotationDegrees(99), 0); });
