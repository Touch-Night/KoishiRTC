// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateScreenUpgrade } from '../napcat-plugin/private-screen-upgrade.mjs';
import { createController } from '../napcat-plugin/controller.mjs';
import { PROFILE, LINUX_X64_PROFILE, buildPrivateDialParams, buildPrivateScreenUpgradeParams } from '../napcat-plugin/native-profile.mjs';
import videoModule from '../av-host/video.cjs';

async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(2); }
  assert.fail('Timed out waiting for fixture state');
}
function machine(options = {}) {
  const commands = [], progress = [], failures = []; let restored = 0, rooms = 0;
  const upgrade = new PrivateScreenUpgrade({ requestId: 'upgrade', selfUid: 'self', peerUid: 'peer', peerUin: '123456',
    valid: () => true, prepare: async () => {}, invoke: async (cmd, params, requestId) => { commands.push({ cmd, params, requestId }); return { posted: true, id: commands.length }; },
    beginRoom: () => { rooms++; }, restore: async () => { restored++; }, changed: value => progress.push(value),
    failed: (value, unknown) => failures.push({ value, unknown }), delayMs: 5, acknowledgementMs: 50, connectionMs: 100,
    ...options });
  return { upgrade, commands, progress, failures, restored: () => restored, rooms: () => rooms };
}
test('DAV upgrade has distinct official Close reason and invitation, waits for the new room and same peer', async t => {
  const f = machine(); t.after(() => f.upgrade.cancel());
  assert.equal(JSON.parse(buildPrivateDialParams({ selfUid: 'self', peerUid: 'peer', peerUin: '123456', media: 'screen' })[0]).invite_reason, 0);
  assert.equal(JSON.parse(buildPrivateScreenUpgradeParams({ selfUid: 'self', peerUid: 'peer', peerUin: '123456' })[0]).invite_reason, 3);
  await f.upgrade.start(); assert.deepEqual(f.commands[0], { cmd: 10, params: [1, 'peer', 8], requestId: f.upgrade.closeId });
  f.upgrade.handle(20004, [0]); assert.equal(f.restored(), 0);
  f.upgrade.handle(10, [0, ''], 'wrong'); assert.equal(f.commands.length, 1);
  f.upgrade.handle(10, [0, ''], f.upgrade.closeId); assert.equal(f.commands.length, 1);
  await until(() => f.commands.length === 2);
  const next = JSON.parse(f.commands[1].params[0]);
  assert.deepEqual([next.scene_id, next.sub_business_type, next.invite_original, next.invite_reason, next.invite_uids], [2, 3, 5, 3, ['peer']]);
  f.upgrade.handle(4, [0, ''], f.upgrade.startId);
  f.upgrade.handle(20004, [0]); assert.equal(f.restored(), 0);
  f.upgrade.handle(20008, [], null, { type: 'participant.join', participant: { uid: 'other' } }); assert.equal(f.restored(), 0);
  f.upgrade.handle(20008, [], null, { type: 'participant.join', participant: { uid: 'peer' } });
  await f.upgrade.finished;
  assert.equal(f.restored(), 1); assert.equal(f.rooms(), 1); assert.equal(f.failures.length, 0);
  assert.equal(f.upgrade.progress.status, 'completed');
});
test('uncertain Close or failed handover never dials repeatedly or pretends to restore DAV', async t => {
  const f = machine({ acknowledgementMs: 5 }); t.after(() => f.upgrade.cancel()); await f.upgrade.start();
  await assert.rejects(Promise.race([f.upgrade.finished, delay(100).then(() => assert.fail('No timeout'))]), e => e.code === 'SCREEN_UPGRADE_CLOSE_TIMEOUT');
  assert.equal(f.commands.length, 1); assert.equal(f.failures[0].unknown, true); assert.equal(f.restored(), 0);
  assert.equal(f.failures[0].value.audioReady, false);
  f.upgrade.handle(10, [0, ''], f.upgrade.closeId); await delay(10); assert.equal(f.commands.length, 1);
});
test('hangup while the official 2-second delay is pending cancels the invitation', async () => {
  const f = machine(); await f.upgrade.start(); f.upgrade.handle(10, [0, ''], f.upgrade.closeId);
  f.upgrade.cancel('User hung up'); await assert.rejects(f.upgrade.finished, e => e.code === 'SCREEN_UPGRADE_CANCELLED');
  await delay(10); assert.equal(f.commands.length, 1); assert.equal(f.rooms(), 0);
});

async function controllerFixture(t, options = {}) {
  let listener, screenSendError = null, videoState = { supported: true, sending: {}, tracks: [], shareScreenSupported: false };
  const commands = [], hostCalls = [];
  const controller = createController({ mediaEnabled: true, platform: 'linux', arch: 'arm64', screenUpgradeDelayMs: 5,
    ackTimeoutMs: 100, screenUpgradeConnectionMs: 150, selfInfo: { uid: 'self', uin: '98765' }, core: { dataPath: '/fake' },
    session: { getAVSDKService: () => ({ isNull: () => false, addKernelAVSDKListener: x => { listener = x; return 1; }, setActionFromAVSDK: async () => {} }),
      getUixConvertService: () => ({ getUin: async () => ({ uinInfo: new Map([['peer', '123456']]) }) }) },
    probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], bootId: 'host-1', nativeProfile: PROFILE }),
    invokeHost: async (command, params, requestId) => {
      commands.push({ command, params, requestId });
      if (command === 43) queueMicrotask(() => controller.nativeOutput({ command, value: [1, ''], requestId }));
      return { posted: true, id: commands.length };
    },
    hostRequest: async (route, body) => {
      hostCalls.push({ route, body });
      if (route.startsWith('/v1/video/sources')) return [{ id: 'external-frames', kind: 'screen', channels: ['screen', 'camera'] }, { id: 'camera:selected', kind: 'camera', channels: ['camera'] }];
      if (route === '/v1/video/session') {
        videoState.sessionId = body.callId;
        if (!body.callId) videoState = { ...videoState, tracks: [], sending: {} };
      }
      if (route === '/v1/video/send') {
        if (body.kind === 'screen' && screenSendError) throw screenSendError;
        videoState.sending[body.kind] = { state: 'sending', sourceId: body.sourceId };
      }
      return structuredClone(videoState);
    }, ...options });
  controller.start({ loginAutomatically: false }); t.after(() => controller.stop());
  await controller.login(); listener.onInviteActionToAVSDK({ invite_type: 1 }, 2, 'opaque');
  await controller.nativeOutput({ command: 20006, value: [1, 'peer', 'self', 1, '123456', null, null, null, null, null, false, ''] });
  const call = controller.current(); await controller.control('accept', { requestId: 'accept', callId: call.id });
  await controller.nativeOutput({ command: 5, requestId: 'accept', value: [0] }); await controller.nativeOutput({ command: 20004, value: [0] });
  await controller.video('state');
  return { controller, call, commands, hostCalls, setVideo: value => { videoState = { ...videoState, ...value }; }, failScreen: error => { screenSendError = error; } };
}
test('controller preserves one logical call, exposes transition, and opens the explicit source only after both sides connect', async t => {
  const f = await controllerFixture(t);
  assert.equal((await f.controller.video('state')).shareScreenRequiresUpgrade, true);
  f.setVideo({ sending: { camera: { state: 'sending', sourceId: 'camera:selected' } } });
  const input = { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'external-frames' };
  const sending = f.controller.video('send', input), repeated = f.controller.video('send', input);
  await until(() => f.commands.some(x => x.command === 10));
  assert.equal(f.controller.current().phase, 'connected'); assert.equal(f.controller.current().id, f.call.id);
  assert.equal((await f.controller.video('state')).mediaTransition.status, 'closing');
  await f.controller.video('cancel', { callId: f.call.id, requestId: 'late-cancel', targetRequestId: 'an-older-send' });
  await f.controller.video('cancel', { callId: f.call.id, requestId: 'unscoped-cancel' });
  assert.equal(f.controller.current().mediaTransition.status, 'closing', 'stale or unscoped cancellation cannot touch this handover');
  await assert.rejects(f.controller.video('send', { ...input, requestId: 'other' }), e => e.code === 'MEDIA_TRANSITION');
  const close = f.commands.find(x => x.command === 10);
  await f.controller.nativeOutput({ command: 10, requestId: close.requestId, value: [0, ''] });
  await until(() => f.commands.some(x => x.command === 4));
  const start = f.commands.find(x => x.command === 4);
  await f.controller.nativeOutput({ command: 4, requestId: start.requestId, value: [0, ''] });
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.hostCalls.filter(x => x.route === '/v1/video/send').length, 0);
  await f.controller.nativeOutput({ command: 20008, value: ['peer', 0, false, '', 0, 0, 0] });
  const [a, b] = await Promise.all([sending, repeated]);
  assert.equal(a.mediaTransition.status, 'completed'); assert.deepEqual(a, b);
  assert.equal(a.sending.screen.state, 'sending'); assert.equal(a.sending.camera.sourceId, 'camera:selected');
  assert.equal(f.commands.filter(x => x.command === 4).length, 1);
  assert.equal(f.controller.current().id, f.call.id); assert.equal(f.controller.current().nativeSceneId, 2);
  const stopCount = f.hostCalls.filter(x => x.route === '/v1/video/stop').length;
  await f.controller.video('cancel', { callId: f.call.id, requestId: 'already-completed', targetRequestId: 'screen' });
  assert.equal(f.hostCalls.filter(x => x.route === '/v1/video/stop').length, stopCount);
  await f.controller.control('hangup', { callId: f.call.id, requestId: 'finish' });
  assert.deepEqual(f.commands.at(-1).params, [2, 0]); assert.equal(f.commands.at(-1).command, 8);
});
test('bad source and unaudited upgrade profiles leave the voice call untouched', async t => {
  const f = await controllerFixture(t);
  await assert.rejects(f.controller.video('send', { callId: f.call.id, requestId: 'bad', kind: 'screen', sourceId: 'missing' }), e => e.code === 'INVALID_SOURCE');
  assert.equal(f.commands.filter(x => x.command === 10 || x.command === 4).length, 0);
  const g = await controllerFixture(t, { arch: 'x64', probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], bootId: 'x64', nativeProfile: LINUX_X64_PROFILE }) });
  assert.equal((await g.controller.video('state')).shareScreenRequiresUpgrade, undefined);
  await assert.rejects(g.controller.video('send', { callId: g.call.id, requestId: 'unsupported', kind: 'screen', sourceId: 'external-frames' }), e => e.code === 'VIDEO_SCENE_UNSUPPORTED');
  assert.equal(g.commands.filter(x => x.command === 10 || x.command === 4).length, 0);
});
test('remote close during the handover cancels it and never emits a replacement invitation', async t => {
  const f = await controllerFixture(t);
  const sending = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'external-frames' });
  await until(() => f.commands.some(x => x.command === 10));
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, -1, '', ''] });
  await assert.rejects(sending, e => e.code === 'SCREEN_UPGRADE_CANCELLED');
  assert.equal(f.controller.current().phase, 'ended'); await delay(10);
  assert.equal(f.commands.filter(x => x.command === 4).length, 0);
});

test('cancel during native preflight prevents later Close and never stops a working camera', async t => {
  const commands = [];
  const f = await controllerFixture(t, { invokeHost: async (command, params, requestId) => { commands.push({ command, params, requestId }); return { posted: true, id: commands.length }; } });
  f.setVideo({ sending: { camera: { state: 'sending', sourceId: 'camera:selected' } } });
  const sending = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'external-frames' });
  await until(() => commands.some(x => x.command === 43));
  const cancel = { callId: f.call.id, requestId: 'cancel-early', targetRequestId: 'screen' };
  const a = await f.controller.video('cancel', cancel); const b = await f.controller.video('cancel', cancel);
  assert.deepEqual(a, b); assert.equal(a.sending.camera.state, 'sending');
  const check = commands.find(x => x.command === 43);
  await f.controller.nativeOutput({ command: 43, requestId: check.requestId, value: [1, ''] });
  await assert.rejects(sending, e => e.code === 'STALE_CALL');
  assert.equal(commands.filter(x => x.command === 10 || x.command === 4).length, 0);
  assert.equal(f.hostCalls.filter(x => x.route === '/v1/video/stop').length, 0);
  assert.equal(f.controller.current().phase, 'connected');
});
test('cancelling a submitted handover rejects its send and preserves explicit native cleanup', async t => {
  const f = await controllerFixture(t);
  const sending = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'external-frames' });
  await until(() => f.commands.some(x => x.command === 10));
  await f.controller.video('cancel', { callId: f.call.id, requestId: 'cancel', targetRequestId: 'screen' });
  await assert.rejects(sending, e => e.code === 'SCREEN_UPGRADE_CANCELLED');
  assert.equal(f.controller.current().phase, 'error'); assert.equal(f.controller.current().nativeTeardownUnknown, true);
  const close = f.commands.find(x => x.command === 10);
  await f.controller.nativeOutput({ command: 10, requestId: close.requestId, value: [0, ''] });
  await delay(10); assert.equal(f.commands.filter(x => x.command === 4).length, 0);
  await f.controller.control('hangup', { callId: f.call.id, requestId: 'cleanup' });
  assert.equal(f.commands.at(-1).command, 10); assert.deepEqual(f.commands.at(-1).params, [1, 'peer', 0]);
});
test('media publication failure after a verified handover keeps the new voice connection usable', async t => {
  const f = await controllerFixture(t); f.failScreen(Object.assign(new Error('Explicit source disappeared'), { code: 'INVALID_SOURCE' }));
  const sending = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'external-frames' });
  await until(() => f.commands.some(x => x.command === 10)); const close = f.commands.find(x => x.command === 10);
  await f.controller.nativeOutput({ command: 10, requestId: close.requestId, value: [0, ''] });
  await until(() => f.commands.some(x => x.command === 4)); const start = f.commands.find(x => x.command === 4);
  await f.controller.nativeOutput({ command: 4, requestId: start.requestId, value: [0, ''] });
  await f.controller.nativeOutput({ command: 20008, value: ['peer', 0, false, '', 0, 0, 0] });
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  await assert.rejects(sending, e => e.code === 'INVALID_SOURCE');
  assert.equal(f.controller.current().phase, 'connected'); assert.equal(f.controller.current().nativeSceneId, 2);
  assert.equal(f.controller.current().mediaTransition.status, 'failed'); assert.notEqual(f.controller.current().nativeTeardownUnknown, true);
  assert.equal(f.controller.current().mediaTransition.audioReady, true);
});
test('source discovery without a call is read-only and does not initialize a video session', async t => {
  const calls = [];
  const controller = createController({ mediaEnabled: true, hostRequest: async (route, body) => { calls.push({ route, body }); return []; } });
  t.after(() => controller.stop());
  assert.deepEqual(await controller.video('sources'), []);
  assert.deepEqual(calls, [{ route: '/v1/video/sources', body: undefined }]);
  assert.equal(controller.current(), null);
});

test('maximum length public request IDs produce bounded native correlation IDs', async t => {
  const f = machine({ requestId: 'r'.repeat(128) }); t.after(() => f.upgrade.cancel());
  await f.upgrade.start();
  assert.match(f.upgrade.closeId, /^[A-Za-z0-9._:-]{1,128}$/); assert.match(f.upgrade.startId, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.notEqual(f.upgrade.closeId, f.upgrade.startId);
});

test('cancellation can overtake a future send while remaining scoped to that exact request', async t => {
  const f = await controllerFixture(t);
  const body = { callId: f.call.id, kind: 'screen', sourceId: 'external-frames' };
  await f.controller.video('cancel', { callId: f.call.id, requestId: 'cancel-before-send', targetRequestId: 'delayed-send' });
  await assert.rejects(f.controller.video('send', { ...body, requestId: 'delayed-send' }), e => e.code === 'SCREEN_UPGRADE_CANCELLED');
  assert.equal(f.commands.filter(x => [4, 10, 43].includes(x.command)).length, 0);
  assert.equal(f.controller.current().phase, 'connected');
  const fresh = f.controller.video('send', { ...body, requestId: 'fresh-send' });
  await until(() => f.commands.some(x => x.command === 10));
  assert.equal(f.controller.current().mediaTransition.requestId, 'fresh-send');
  await f.controller.video('cancel', { callId: f.call.id, requestId: 'cancel-fresh', targetRequestId: 'fresh-send' });
  await assert.rejects(fresh, e => e.code === 'SCREEN_UPGRADE_CANCELLED');
});

test('pre-close media preparation failure explicitly preserves the original voice transport', async () => {
  const f = machine({ prepare: async () => { throw new Error('Video surface unavailable'); } });
  await assert.rejects(f.upgrade.start(), /Video surface unavailable/);
  await assert.rejects(f.upgrade.finished, /Video surface unavailable/);
  assert.equal(f.commands.length, 0); assert.equal(f.failures[0].unknown, false);
  assert.equal(f.failures[0].value.audioReady, true);
});

async function nativeVideoFixture(t) {
  let scene = 1, devices = ['chosen-camera'], cameraPreflightFailure = false;
  const nativeCommands = [], enumerations = [], sends = [];
  const host = new videoModule.VideoHost({ enabled: true, surface: async () => {}, capture: async () => null,
    listWindows: async () => [{ id: 'screen:chosen-window', name: 'Explicit window', handle: 41 }],
    outputBackend: { cameraAvailable: () => false, close: async () => {} },
    send: async (command, params, id) => {
      nativeCommands.push({ command, params, generation: host.generation, scene });
      const value = command === 46 ? [0, '', devices.map(() => 'Fixture camera'), devices]
        : [[30, 31].includes(command) ? scene === 1 ? 0 : 1 : [33, 34, 35, 36].includes(command) ? 1 : 0, ''];
      queueMicrotask(() => {
        host.handle({ cmd: command, id, value });
        if (command === 30 && scene === 2) host.handle({ cmd: 20026, value: [0] });
      });
    } });
  const f = await controllerFixture(t, { hostRequest: async (route, body) => {
    const url = new URL(route, 'http://fixture');
    if (url.pathname === '/v1/video/session') return host.session(body);
    if (url.pathname === '/v1/video/state') return host.state();
    if (url.pathname === '/v1/video/sources') {
      const result = await host.sources(Object.fromEntries(url.searchParams));
      enumerations.push({ generation: host.generation, scene: host.nativeSceneId, callId: host.sessionId });
      return result;
    }
    if (url.pathname === '/v1/video/send') {
      if (cameraPreflightFailure && scene === 2 && body.kind === 'camera') throw Object.assign(new Error('Camera became unavailable'), {
        code: 'INVALID_SOURCE', videoSendFailure: { requestId: body.requestId, callId: body.callId, kind: body.kind, sourceId: body.sourceId, outcome: 'unchanged' },
      });
      sends.push({ ...body, generation: host.generation }); return host.startSend(body);
    }
    if (url.pathname === '/v1/video/stop') return host.stopSend(body);
    throw new Error(`Unexpected fixture route ${route}`);
  } });
  t.after(() => host.clear());
  return { ...f, host, nativeCommands, enumerations, sends, setDevices: value => { devices = value; }, failCameraRestore: () => { cameraPreflightFailure = true; },
    enterMav: async () => {
      await until(() => f.commands.some(x => x.command === 10)); const close = f.commands.find(x => x.command === 10);
      await f.controller.nativeOutput({ command: 10, requestId: close.requestId, value: [0, ''] });
      await until(() => f.commands.some(x => x.command === 4)); const start = f.commands.find(x => x.command === 4);
      scene = 2;
      await f.controller.nativeOutput({ command: 4, requestId: start.requestId, value: [0, ''] });
      // Exercise the actual Host's native-room clear, not a permissive mock
      // whose send accepts a source catalogue from the previous session.
      host.handle({ cmd: 20004, value: [0] });
      await f.controller.nativeOutput({ command: 20004, value: [0] });
      await f.controller.nativeOutput({ command: 20008, value: ['peer', 0, false, '', 0, 0, 0] });
    } };
}

test('real VideoHost rebuilds sources after DAV room teardown before the first screen send and selected-camera restoration', async t => {
  const f = await nativeVideoFixture(t);
  await f.controller.video('sources', { callId: f.call.id });
  await f.controller.video('send', { callId: f.call.id, requestId: 'camera', kind: 'camera', sourceId: 'camera:chosen-camera' });
  const originalGeneration = f.host.generation;
  const sharing = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'screen:chosen-window' });
  await f.enterMav();
  const result = await sharing;
  assert.equal(result.mediaTransition.status, 'completed');
  assert.equal(result.sending.screen.sourceId, 'screen:chosen-window'); assert.equal(result.sending.screen.state, 'sending');
  assert.equal(result.sending.camera.sourceId, 'camera:chosen-camera'); assert.equal(result.sending.camera.state, 'sending');
  assert.ok(f.host.generation > originalGeneration);
  const currentEnumeration = f.enumerations.find(x => x.generation === f.host.generation && x.scene === 2);
  assert.equal(currentEnumeration?.callId, f.call.id, 'the restored catalogue belongs to this MAV room');
  assert.equal(f.sends.filter(x => x.kind === 'screen').length, 1, 'first send succeeds without stop/retry');
  assert.deepEqual(f.nativeCommands.filter(x => x.command === 47).map(x => x.params[0]), ['chosen-camera', 'chosen-camera']);
  assert.deepEqual(f.nativeCommands.find(x => x.command === 44)?.params, [false, 41, false]);
});

test('camera removed during the handover is not silently replaced by another device', async t => {
  const f = await nativeVideoFixture(t);
  await f.controller.video('sources', { callId: f.call.id });
  await f.controller.video('send', { callId: f.call.id, requestId: 'camera', kind: 'camera', sourceId: 'camera:chosen-camera' });
  const sharing = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'screen:chosen-window' });
  await until(() => f.commands.some(x => x.command === 10)); f.setDevices(['unselected-other-camera']);
  await f.enterMav();
  await assert.rejects(sharing, e => {
    assert.equal(e.code, 'INVALID_SOURCE'); assert.match(e.message, /camera source/);
    assert.deepEqual(e.videoSendFailure, { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'screen:chosen-window', outcome: 'unchanged' });
    return true;
  });
  assert.equal(f.controller.current().phase, 'connected'); assert.equal(f.controller.current().mediaTransition.audioReady, true);
  assert.equal(f.sends.filter(x => x.kind === 'screen').length, 0, 'all saved source IDs are checked before any new publication');
  assert.deepEqual(f.nativeCommands.filter(x => x.command === 47).map(x => x.params[0]), ['chosen-camera']);
});

test('a camera restore rejection cannot attest that an already published screen was unchanged', async t => {
  const f = await nativeVideoFixture(t);
  await f.controller.video('sources', { callId: f.call.id });
  await f.controller.video('send', { callId: f.call.id, requestId: 'camera', kind: 'camera', sourceId: 'camera:chosen-camera' });
  f.failCameraRestore();
  const sharing = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'screen:chosen-window' });
  await f.enterMav();
  await assert.rejects(sharing, e => e.code === 'INVALID_SOURCE' && e.videoSendFailure === undefined);
  assert.equal(f.host.state().sending.screen.state, 'sending');
  assert.equal(f.controller.current().phase, 'connected'); assert.equal(f.controller.current().mediaTransition.audioReady, true);
});

test('restored source enumeration cannot authorize publication after the call is ended', async t => {
  const f = await nativeVideoFixture(t);
  const sharing = f.controller.video('send', { callId: f.call.id, requestId: 'screen', kind: 'screen', sourceId: 'screen:chosen-window' });
  await until(() => f.commands.some(x => x.command === 10));
  let release, discovered;
  const gate = new Promise(resolve => { release = resolve; }), discovery = new Promise(resolve => { discovered = resolve; });
  f.host.listWindows = async () => { discovered(); await gate; return [{ id: 'screen:chosen-window', name: 'Explicit window', handle: 41 }]; };
  await f.enterMav(); await discovery;
  const rejected = assert.rejects(sharing, e => e.code === 'SCREEN_UPGRADE_CANCELLED');
  await f.controller.control('hangup', { callId: f.call.id, requestId: 'stop-during-enumeration' });
  release(); await rejected;
  await f.controller.video('state');
  assert.equal(f.sends.length, 0); assert.equal(f.host.state().sessionId, null);
  assert.equal(f.nativeCommands.filter(x => x.command === 44 || x.command === 35).length, 0);
});
