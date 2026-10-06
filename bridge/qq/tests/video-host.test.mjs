import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { VideoHost } = createRequire(import.meta.url)('../av-host/video.cjs');
function fixture() {
  const sent = []; let time = 1, captures = 0, gate = Promise.resolve();
  const host = new VideoHost({ enabled: true, now: () => time, send: async (cmd, args, id) => { sent.push([cmd, args]); if (id) queueMicrotask(() => host.handle({ id, cmd, value: [[30, 31, 33, 34, 35, 36].includes(cmd) ? 1 : 0, ''] })); }, surface: async () => {}, capture: async () => {
    captures++; await gate;
    return { crop: rect => ({ toJPEG: () => Buffer.from([255, 216, 255, 217]), getSize: () => ({ width: rect.width, height: rect.height }) }) };
  } });
  return { host, sent, tick: () => { time += 200; }, captures: () => captures, gate: p => { gate = p; } };
}
test('video never returns a frame until the native decoder reports one for the subscribed identity', async () => {
  const f = fixture(), { host } = f;
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: ['self', 'peer'] });
  await assert.rejects(host.subscribe({ callId: 'a', uid: 'other', kind: 'camera' }), /participant/);
  await assert.rejects(host.subscribe({ callId: 'a', uid: 'self', kind: 'camera' }), /participant/);
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null);
  host.handle({ cmd: 20031, value: ['other', 1, 640, 480] });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null);
  host.handle({ cmd: 20031, value: ['peer', 1, 640, 480] });
  const frame = await host.frame({ callId: 'a', trackId: 'peer:camera' });
  assert.equal(frame.participantId, 'peer'); assert.equal(frame.encoding, 'jpeg'); assert.equal(f.captures(), 1);
  await host.frame({ callId: 'a', trackId: 'peer:camera' }); assert.equal(f.captures(), 1);
  host.handle({ cmd: 20025, value: ['peer', 0] });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null);
});
test('only audited camera and screen source types enter subscriptions; layout is left top right bottom', async () => {
  const { host, sent } = fixture(); await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: ['peer', 'peer2'] });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  await host.subscribe({ callId: 'a', uid: 'peer2', kind: 'screen' });
  const layout = sent.filter(([cmd]) => cmd === 54).at(-1)[1];
  assert.deepEqual(layout[2], [1, 2]); assert.deepEqual(layout[3], ['0,0,320,480', '320,0,640,480']);
  const request = JSON.parse(sent.filter(([cmd]) => cmd === 33).at(-1)[1][0]);
  assert.equal(request.request_list[1].sourceType, 2); assert.equal(request.request_list[1].isLocal, false);
  await assert.rejects(host.subscribe({ callId: 'a', uid: 'peer', kind: 'media' }), /participant/);
});
test('an asynchronous render capture cannot cross a call, layout or unsubscribe boundary', async () => {
  const f = fixture(), { host } = f;
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  host.handle({ cmd: 20031, value: ['peer', 1, 640, 480] });
  let resume; f.gate(new Promise(resolve => { resume = resolve; }));
  const pending = host.frame({ callId: 'a', trackId: 'peer:camera' });
  await host.unsubscribe({ callId: 'a', trackId: 'peer:camera' }); resume();
  assert.equal(await pending, null);
  await host.session({ callId: 'b', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  assert.deepEqual(host.state().tracks, []); await assert.rejects(host.frame({ callId: 'a', trackId: 'peer:camera' }), /session/);
});
test('participant departure and native camera-close remove retained frame bytes', async () => {
  const { host } = fixture(); await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  host.handle({ cmd: 20031, value: ['peer', 1, 640, 480] }); await host.frame({ callId: 'a', trackId: 'peer:camera' });
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: [] });
  assert.deepEqual(host.state().tracks, []);
});
test('portrait sources use their original ratio instead of cropping into a landscape tile', async () => {
  const { host } = fixture(); await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  host.handle({ cmd: 20031, value: ['peer', 1, 360, 640] });
  const frame = await host.frame({ callId: 'a', trackId: 'peer:camera' });
  assert.equal(frame.width, 360); assert.equal(frame.height, 640);
  await host.unsubscribe({ callId: 'a', trackId: 'peer:camera' });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null, 'resubscribing cannot reuse pixels or evidence from a removed native texture');
  host.handle({ cmd: 20031, value: ['peer', 1, 360, 640] });
  assert.ok(await host.frame({ callId: 'a', trackId: 'peer:camera' }));
});
test('external frame inputs keep one in flight and one latest frame, and stop fences late results', async () => {
  const { host } = fixture(); await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: [] });
  const gates = []; host.outputBackend = { write: () => new Promise(resolve => gates.push(resolve)) };
  host.sending.screen = { sourceId: 'external-frames', state: 'sending' };
  host.frameChannels.set('screen', { callId: 'a', kind: 'screen', generation: host.generation, lastSequence: -1, busy: false, closed: false, pending: null });
  const frame = { callId: 'a', kind: 'screen', width: 640, height: 360, encoding: 'jpeg', data: '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYxLjMuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEsAAQEAAAAAAAAAAAAAAAAAAAAIAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgBaAKAAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8An8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q==', timestamp: 1, sequence: 0 };
  const a = host.write(frame), b = host.write({ ...frame, sequence: 1 }), c = host.write({ ...frame, sequence: 2 });
  assert.equal((await b).state, 'dropped'); assert.equal(gates.length, 1);
  gates.shift()({ state: 'rendered', evidence: 'test-render' }); assert.equal((await a).state, 'rendered');
  assert.equal(gates.length, 1); host.closeFrames('screen'); gates.shift()({ state: 'rendered', evidence: 'test-render' });
  assert.equal((await c).state, 'dropped');
  await assert.rejects(host.write({ ...frame, sequence: 3 }), /Select and start/);
});

test('camera cleanup tolerates only the audited absent-core response', async () => {
  const { host } = fixture();
  let value = [-1, 'No Existing Camera capture'];
  host.send = async (cmd, args, id) => queueMicrotask(() => host.handle({ cmd, id, value }));
  await host.native(49, []);
  value = [-1, 'Device busy'];
  await assert.rejects(host.native(49, []), /Device busy/);
});
test('DAV uses automatic camera reception and cannot silently become a screen-share call', async () => {
  const { host, sent } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  assert.ok(!sent.some(([cmd]) => cmd === 33));
  assert.equal(host.state().shareScreenSupported, false);
  await assert.rejects(host.startSend({ callId: 'a', kind: 'screen', sourceId: 'test-pattern' }), /screen-share call/);
});

test('DAV retains an authorized early first-frame event until subscription, without capturing pixels early', async () => {
  const f = fixture(), { host, sent } = f;
  host.handle({ cmd: 20031, value: ['peer', 1, 360, 640] });
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  assert.deepEqual(host.state().tracks, [], 'no metadata from before this session');
  host.handle({ cmd: 20025, value: ['stranger', 1] });
  host.handle({ cmd: 20031, value: ['stranger', 1, 360, 640] });
  assert.deepEqual(host.state().tracks, [], 'unknown native identities are not cached');
  host.handle({ cmd: 20031, value: ['peer', 1, 360, 640] });
  assert.equal(f.captures(), 0);
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null, 'unsubscribed tracks do not expose pixels');
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  const frame = await host.frame({ callId: 'a', trackId: 'peer:camera' });
  assert.equal(frame.width, 360); assert.equal(frame.height, 640);
  assert.equal(sent.some(([cmd]) => [33, 34].includes(cmd)), false);
  await host.clear();
  host.handle({ cmd: 20031, value: ['peer', 1, 360, 640] });
  await host.session({ callId: 'b', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  await host.subscribe({ callId: 'b', uid: 'peer', kind: 'camera' });
  assert.equal(await host.frame({ callId: 'b', trackId: 'peer:camera' }), null, 'same peer in a new call requires new native evidence');
});

test('a current decoded size-change permits capture without pretending it was a first-frame callback', async () => {
  const { host } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 2, participants: ['peer'] });
  await host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  host.handle({ cmd: 20025, value: ['peer', 1] });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null, 'availability is not decoded-frame evidence');
  host.handle({ cmd: 20049, value: ['stranger', 1, 270, 480] });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null);
  host.handle({ cmd: 20049, value: ['peer', 1, 270, 480] });
  const frame = await host.frame({ callId: 'a', trackId: 'peer:camera' });
  assert.equal(frame.evidence, 'native-decoded-size-change-and-render-capture');
  const track = host.state().tracks.find(track => track.uid === 'peer');
  assert.equal(track.firstFrameAt, null); assert.equal(track.decodedFrameAt, 1);
  assert.equal(frame.width, 360); assert.equal(frame.height, 640);
  host.handle({ cmd: 20025, value: ['peer', 0] });
  assert.equal(await host.frame({ callId: 'a', trackId: 'peer:camera' }), null);
  await host.clear();
  host.handle({ cmd: 20049, value: ['peer', 1, 270, 480] });
  await host.session({ callId: 'b', selfUid: 'self', nativeSceneId: 2, participants: ['peer'] });
  await host.subscribe({ callId: 'b', uid: 'peer', kind: 'camera' });
  assert.equal(await host.frame({ callId: 'b', trackId: 'peer:camera' }), null);
});

test('same peer and same resolution in another call recreates the native texture before accepting new frames', async () => {
  const { host, sent } = fixture();
  // Match the audited GL contract: width is retained by UID/source until a 54
  // layout excludes it; repeated subscriptions alone do not repeat 20031.
  const nativeTextures = new Map();
  host.send = async (cmd, args, id) => {
    sent.push([cmd, args]);
    if (cmd === 54) {
      const selected = new Set(args[1].map((uid, i) => `${uid}:${args[2][i]}`));
      for (const key of nativeTextures.keys()) if (!selected.has(key)) nativeTextures.delete(key);
      for (const key of selected) if (!nativeTextures.has(key)) nativeTextures.set(key, 0);
    }
    if (id) queueMicrotask(() => {
      host.handle({ cmd, id, value: [1, ''] });
      if (cmd === 33) for (const track of JSON.parse(args[0]).request_list) {
        const key = `${track.uid}:${track.sourceType}`;
        if (nativeTextures.get(key) === 0) {
          nativeTextures.set(key, 360);
          host.handle({ cmd: 20031, value: [track.uid, track.sourceType, 360, 640] });
        }
      }
    });
  };
  for (const callId of ['a', 'b']) {
    await host.session({ callId, selfUid: 'self', nativeSceneId: 2, participants: ['peer'] });
    await host.subscribe({ callId, uid: 'peer', kind: 'camera' });
    const frame = await host.frame({ callId, trackId: 'peer:camera' });
    assert.equal(frame.callId, callId);
    assert.equal(frame.evidence, 'native-first-frame-and-render-capture');
    await host.clear();
    assert.equal(nativeTextures.size, 0);
    assert.deepEqual(sent.at(-1), [54, [0, [], [], [], 640, 640, 100]]);
  }
});

test('failed native layout cleanup blocks frame reuse by another call', async () => {
  const { host } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  host.send = async () => { throw new Error('native renderer disconnected'); };
  await host.clear();
  assert.equal(host.state().supported, false);
  await assert.rejects(host.session({ callId: 'b', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] }), /disconnected/);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('supplied camera framing switches explicitly while identical starts retain frame sequence', async () => {
  const { host } = fixture(), opened = [];
  host.outputBackend = { cameraAvailable: () => true, open: async (kind, callId, options) => { opened.push(options); return { nativeDeviceId: 'virtual-id' }; }, close: async () => {} };
  host.send = async (cmd, args, id) => { if (id) queueMicrotask(() => host.handle({ cmd, id, value: cmd === 46 ? [0, '', ['virtual'], ['virtual-id']] : [0, ''] })); };
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  await host.sources({ callId: 'a' });
  const request = { callId: 'a', kind: 'camera', sourceId: 'external-frames' };
  await host.startSend(request);
  host.frameChannels.get('camera').lastSequence = 8;
  await host.startSend({ ...request, framing: 'full' });
  assert.equal(opened.length, 1); assert.equal(host.frameChannels.get('camera').lastSequence, 8);
  await host.startSend({ ...request, framing: 'portrait-safe' });
  assert.deepEqual(opened, [{ framing: 'full' }, { framing: 'portrait-safe' }]);
  assert.equal(host.state().sending.camera.framing, 'portrait-safe');
  assert.equal(host.frameChannels.get('camera').lastSequence, -1);
  await assert.rejects(host.startSend({ ...request, kind: 'screen', framing: 'portrait-safe' }), /Framing/);
  await assert.rejects(host.startSend({ ...request, framing: 'unknown' }), /Framing/);
  await host.clear();
});

test('native camera size diagnostics are bounded and do not survive a call', async () => {
  const { host } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  host.handle({ cmd: 20030, value: [480, 270, 20] });
  assert.deepEqual(host.state().cameraRequestedFormat, { width: 480, height: 270, fps: 20 });
  host.handle({ cmd: 20030, value: [999999, 270, 20] });
  assert.equal(host.state().cameraRequestedFormat.width, 480);
  await host.clear();
  host.handle({ cmd: 20030, value: [480, 270, 20] });
  assert.equal(host.state().cameraRequestedFormat, null);
});

test('clear invalidates a queued session update before it can resurrect the old call', async () => {
  const { host } = fixture();
  await host.session({ callId: 'old', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  const gate = deferred(); host.serial(() => gate.promise);
  const oldUpdate = host.session({ callId: 'old', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  const rejected = assert.rejects(oldUpdate, /superseded|session changed/);
  const cleanup = host.clear();
  assert.equal(host.sessionId, null);
  gate.resolve(); await rejected; await cleanup;
  assert.equal(host.sessionId, null); assert.equal(host.members.size, 0);
});

test('a surface completing after clear cannot issue old layout or subscription commands in the next call', async () => {
  const { host, sent } = fixture();
  await host.session({ callId: 'old', selfUid: 'self', nativeSceneId: 3, participants: ['old-peer'] });
  const entered = deferred(), gate = deferred();
  host.surface = async () => { entered.resolve(); await gate.promise; };
  const subscription = host.subscribe({ callId: 'old', uid: 'old-peer', kind: 'camera' });
  const rejected = assert.rejects(subscription, /session changed/);
  await entered.promise;
  const cleanup = host.clear();
  const next = host.session({ callId: 'new', selfUid: 'self', nativeSceneId: 3, participants: ['new-peer'] });
  gate.resolve(); await rejected; await cleanup; await next;
  assert.equal(host.sessionId, 'new'); assert.deepEqual([...host.members], ['new-peer']);
  assert.deepEqual(sent.map(([cmd]) => cmd), [34, 54]);
  assert.deepEqual(sent.at(-1)[1], [0, [], [], [], 640, 640, 100]);
  assert.equal(host.tracks.size, 0);
});

test('concurrent subscriptions cannot let an earlier layout overwrite the combined selection', async () => {
  const { host, sent } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: ['peer', 'peer2'] });
  const entered = deferred(), gate = deferred(); let surfaces = 0;
  host.surface = async () => { if (++surfaces === 1) { entered.resolve(); await gate.promise; } };
  const first = host.subscribe({ callId: 'a', uid: 'peer', kind: 'camera' });
  await entered.promise;
  const second = host.subscribe({ callId: 'a', uid: 'peer2', kind: 'camera' });
  assert.equal(surfaces, 1); gate.resolve(); await Promise.all([first, second]);
  assert.equal(surfaces, 2);
  const request = JSON.parse(sent.filter(([cmd]) => cmd === 33).at(-1)[1][0]);
  assert.deepEqual(request.request_list.map(track => track.uid), ['peer', 'peer2']);
  assert.deepEqual(sent.filter(([cmd]) => cmd === 54).at(-1)[1][1], ['peer', 'peer2']);
});

test('a frame awaiting an old layout cannot return the next call cached frame', async () => {
  const { host } = fixture();
  await host.session({ callId: 'old', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  const gate = deferred(); host.layoutJob = gate.promise;
  const oldFrame = host.frame({ callId: 'old', trackId: 'peer:camera' });
  await host.clear();
  await host.session({ callId: 'new', selfUid: 'self', nativeSceneId: 3, participants: ['peer'] });
  host.tracks.set('peer:camera', { id: 'peer:camera', uid: 'peer', kind: 'camera', subscribed: true, firstFrameAt: 1, available: true, frame: { callId: 'new', timestamp: 1, data: 'new-call-only' } });
  gate.resolve(); assert.equal(await oldFrame, null);
});

test('camera capture is published separately from screen sharing and stopped independently', async () => {
  const { host, sent } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: [] });
  host.outputBackend = { open: async () => ({ handle: 42, nativeDeviceId: 'virtual-id' }), close: async () => {} };
  host.sourcesById.set('external-frames', { sourceType: 'frames', channels: ['camera', 'screen'] });
  host.send = async (cmd, args, id) => {
    sent.push([cmd, args]);
    if (id) queueMicrotask(() => { host.handle({ cmd, id, value: cmd === 46 ? [0, '', ['Virtual'], ['virtual-id']] : [[30, 31, 35, 36].includes(cmd) ? 1 : 0] }); if (cmd === 30) host.handle({ cmd: 20026, value: [3] }); });
  };
  await host.startSend({ callId: 'a', kind: 'camera', sourceId: 'external-frames' });
  assert.deepEqual(sent.map(([cmd]) => cmd), [49, 46, 47, 48, 30]);
  assert.deepEqual(sent.find(([cmd]) => cmd === 47)[1], ['virtual-id', true, true]);
  sent.length = 0;
  await host.startSend({ callId: 'a', kind: 'screen', sourceId: 'external-frames' });
  assert.deepEqual(sent.map(([cmd]) => cmd), [36, 45, 44, 35]);
  assert.equal(host.state().sending.camera.state, 'sending');
  sent.length = 0;
  await host.stopSend({ callId: 'a', kind: 'camera' });
  assert.deepEqual(sent.map(([cmd]) => cmd), [31, 49]);
  assert.equal(host.state().sending.camera, undefined);
  assert.equal(host.state().sending.screen.state, 'sending');
});
test('camera opening waits for DeviceOpen instead of the initial scheduling receipt', async () => {
  const { host } = fixture(); let identity, settled = false;
  host.send = async (cmd, args, id) => {
    identity = id;
    queueMicrotask(() => host.handle({ cmd, id, value: [0, 'Start camera capture success!'] }));
  };
  const pending = host.native(47, ['virtual-id', true, true]);
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  host.handle({ cmd: 47, id: identity, value: [-1, 'OpenCamera fail'] });
  await assert.rejects(pending, /OpenCamera fail/);
});

test('clearing a DAV session preserves its inverted publish acknowledgement convention', async () => {
  const { host, sent } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: [] });
  host.sending.camera = { state: 'sending', sourceId: 'external-frames' };
  host.send = async (cmd, args, id) => { sent.push([cmd, args]); if (id) queueMicrotask(() => host.handle({ cmd, id, value: [0] })); };
  await host.clear();
  assert.deepEqual(sent.map(([cmd]) => cmd), [54, 31, 49]);
  assert.equal(host.cleanupError, null);
  assert.deepEqual(host.state().sending, {});
});

test('group publication waits for the asynchronous stage result and reports rejection', async () => {
  const { host } = fixture(); let settled = false;
  const pending = host.publishCamera(3); pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  host.handle({ cmd: 20026, value: [4] });
  await assert.rejects(pending, /rejected camera publication/);
  assert.equal(host.stagePending, null);
});

test('native camera loss stops its output without affecting screen sharing', async () => {
  const { host, sent } = fixture();
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 3, participants: [] });
  host.sending = { camera: { sourceId: 'external-frames', state: 'sending' }, screen: { sourceId: 'external-frames', state: 'sending' } };
  host.frameChannels.set('camera', { closed: false, pending: null });
  host.handle({ cmd: 20053, id: 0, value: [] });
  assert.equal(host.frameChannels.has('camera'), false);
  await host.controlTail;
  assert.equal(host.state().sending.camera.state, 'failed');
  assert.equal(host.state().sending.screen.state, 'sending');
  assert.deepEqual(sent.map(([cmd]) => cmd), [31, 49]);
});
