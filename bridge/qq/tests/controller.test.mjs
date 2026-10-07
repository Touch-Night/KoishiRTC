// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import hostProfiles from '../av-host/profiles.cjs';
import videoModule from '../av-host/video.cjs';
import { createController, buildAcceptParams, summarize } from '../napcat-plugin/controller.mjs';
import { PROFILES, WINDOWS_PROFILE, MAC_PROFILES, PROFILE, LINUX_X64_PROFILE, buildGroupJoinParams, buildGroupStartParams, buildPrivateDialParams, decodeGroupActivity, decodeObservation } from '../napcat-plugin/native-profile.mjs';
import { createHttpServer, createHostTransport, parseSettings } from '../napcat-plugin/http.mjs';

const invite = [1, 'caller-uid', 'self-uid', 2, '123456', null, null, null, null, null, false, 'dsp-model'];
function fixture(options = {}) {
  let listener; let nativeId = 0;
  const invocations = [], transports = [];
  const service = { isNull: () => false,
    addKernelAVSDKListener: value => { listener = value; return 3; },
    removeKernelAVSDKListener: value => assert.equal(value, 3),
    setActionFromAVSDK: async (actionType, payload) => { transports.push({ actionType, payload }); },
    allowAlbumNotify: () => {},
  };
  const controller = createController({
    session: { getAVSDKService: () => service, getAccountPath: () => '/fake/account',
      getUixConvertService: () => ({ getUin: async () => ({ uinInfo: new Map([['caller-uid', '123456']]) }),
        getUid: async () => ({ uidInfo: new Map([['123456', 'caller-uid']]) }) }) },
    core: { dataPath: '/fake/QQ-root' },
    selfInfo: { uid: 'self-uid', uin: '98765' }, mediaEnabled: true, platform: 'linux', arch: 'arm64',
    invokeHost: async (command, params, requestId) => {
      invocations.push({ command, params, requestId });
      return { posted: true, id: ++nativeId };
    },
    probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: PROFILE }),
    ...options,
  });
  controller.start({ loginAutomatically: false });
  return { controller, invocations, transports, native: (name, ...args) => listener[name](...args) };
}
async function incoming(f) {
  await f.controller.login();
  f.native('onInviteActionToAVSDK', { invite_type: 1 }, 2, 'opaque-kernel-payload');
  await f.controller.nativeOutput({ command: 20006, value: invite });
  return f.controller.current();
}
async function connected(f) {
  const call = await incoming(f);
  await f.controller.control('accept', { requestId: 'accept-1', callId: call.id });
  await f.controller.nativeOutput({ command: 5, requestId: 'accept-1', value: [0] });
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  return f.controller.current();
}

test('Accept separates logged-in identity, inviter and numeric native room relation', () => {
  assert.deepEqual(buildAcceptParams(invite, 'self-uid'), [1, 'self-uid', ['caller-uid'], 2, '123456', false, 'dsp-model']);
  assert.throws(() => buildAcceptParams([1, 'x']), /Incomplete/);
  assert.throws(() => buildAcceptParams(invite), /Unknown native Accept argument shape/);
  for (const relation of ['opaque-ticket', '18446744073709551616', '']) {
    const invalid = [...invite]; invalid[4] = relation;
    assert.throws(() => buildAcceptParams(invalid, 'self-uid'), /Unknown native Accept argument shape/);
  }
});
test('no auto-answer; submitted, native acceptance and room entry remain separate', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  const call = await incoming(f);
  assert.equal(f.invocations.filter(x => x.command === 5).length, 0);
  assert.equal(call.phase, 'ringing');
  assert.equal(call.media, 'video', 'incoming subtype 2 is a video invitation');
  const receipt = await f.controller.control('accept', { requestId: 'request-1', callId: call.id });
  assert.equal(receipt.status, 'submitted');
  assert.equal(f.controller.current().phase, 'accepting');
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.controller.current().phase, 'accepting', 'uncorrelated room event cannot confirm submission');
  await f.controller.nativeOutput({ command: 5, requestId: 'old-request', value: [0] });
  assert.equal(f.controller.current().phase, 'accepting');
  await f.controller.nativeOutput({ command: 5, requestId: 'request-1', value: [0] });
  assert.equal(f.controller.current().phase, 'accepted');
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.controller.current().phase, 'connected');
  assert.equal((await f.controller.control('accept', { requestId: 'request-1', callId: call.id })).status, 'confirmed');
});
test('concurrent idempotent requests produce one native command; stale calls conflict', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); const call = await incoming(f);
  const input = { requestId: 'same-request', callId: call.id };
  const results = await Promise.all([f.controller.control('accept', input), f.controller.control('accept', input)]);
  assert.equal(results[0].requestId, results[1].requestId);
  assert.equal(f.invocations.filter(x => x.command === 5).length, 1);
  await assert.rejects(f.controller.control('accept', { requestId: 'same-request', callId: 'old' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.controller.control('accept', { requestId: 'different', callId: 'old' }), e => e.code === 'CALL_STATE_CONFLICT');
});
test('unknown submission is reserved and never repeated', async t => {
  let accepts = 0;
  const f = fixture({ invokeHost: async (cmd) => {
    if (cmd === 5) { accepts++; throw new Error('network timed out after delivery'); }
    return { posted: true, id: 1 };
  } });
  t.after(() => f.controller.stop()); const call = await incoming(f);
  const input = { requestId: 'unknown-1', callId: call.id };
  assert.equal((await f.controller.control('accept', input)).status, 'unknown');
  assert.equal((await f.controller.control('accept', input)).status, 'unknown');
  assert.equal(accepts, 1);
  await assert.rejects(f.controller.control('accept', { ...input, requestId: 'unknown-2' }), e => e.code === 'CALL_STATE_CONFLICT');
});
test('diagnostics mode observes without login, native forwarding or accept', async t => {
  const f = fixture({ mediaEnabled: false }); t.after(() => f.controller.stop());
  f.native('onInviteActionToAVSDK', { invite_type: 1 }, 2, 'opaque');
  assert.equal(f.invocations.length, 0);
  assert.equal(f.controller.capabilities().capabilities['private.accept'].status, 'unavailable');
  await assert.rejects(f.controller.control('accept', { requestId: 'a', callId: f.controller.current().id }), e => e.code === 'CAPABILITY_UNAVAILABLE');
  for (const op of ['dial', 'reject', 'hangup', 'group.join', 'group.leave']) {
    await assert.rejects(f.controller.control(op, { requestId: 'a', callId: 'fixture-call', groupId: '123456' }), e => e.status === 503);
  }
});
test('profile-pinned native reject and hangup use recovered enums, never arbitrary command IDs', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); const call = await incoming(f);
  const rejected = await f.controller.control('reject', { requestId: 'reject-1', callId: call.id });
  assert.equal(rejected.status, 'submitted');
  assert.deepEqual(f.invocations.at(-1).params, [1, 'caller-uid', 2]);
  assert.equal(f.invocations.at(-1).command, 9);
  await f.controller.nativeOutput({ command: 9, requestId: 'reject-1', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'rejecting');
  await f.controller.nativeOutput({ command: 20019, value: [] });
  assert.equal(f.controller.current().phase, 'ended');
  const g = fixture(); t.after(() => g.controller.stop()); const active = await connected(g);
  await g.controller.control('hangup', { requestId: 'hangup-1', callId: active.id });
  assert.equal(g.invocations.at(-1).command, 10);
  assert.deepEqual(g.invocations.at(-1).params, [1, 'caller-uid', 0]);
  await g.controller.nativeOutput({ command: 10, requestId: 'hangup-1', value: [0, ''] });
  assert.equal(g.controller.current().phase, 'ending');
  await g.controller.nativeOutput({ command: 20022, value: [0, 0, 1, -1, '', ''] });
  assert.equal(g.controller.current().phase, 'ended');
});

test('uncorrelated Kernel S2C metadata cannot end a connected call or bypass native hangup acknowledgement', async t => {
  const sessions = [];
  const f = fixture({ hostRequest: async (route, body) => { if (route === '/v1/video/session') sessions.push(body); return {}; } });
  t.after(() => f.controller.stop()); const active = await connected(f);
  for (const payload of [{ destroyReason: 0 }, { actionType: 10, notifyInfo: { destroyReason: 0 } },
    { actionType: 19, notifyInfo: { destroyReason: 1, pushRoomInfoList: [{ roomId: 'another-room' }] } }]) {
    f.native('onS2CActionToAVSDK', payload);
    assert.equal(f.controller.current().phase, 'connected');
    assert.equal(f.controller.current().endedAt, null);
  }
  await f.controller.video('state');
  assert.equal(sessions.at(-1).callId, active.id);
  const before = f.invocations.length;
  f.native('onS2CActionToAVSDK', { destroyReason: 0 }, 10);
  assert.equal(f.invocations.length, before, 'metadata is not an opaque CallKernel transport');
  const notice = f.controller.getEvents().events.filter(event => event.type === 'kernel.notification').at(-1);
  assert.equal(notice.actionType, 10); assert.equal(notice.destroyReason, 0);
  await f.controller.control('hangup', { requestId: 'real-close', callId: active.id });
  f.native('onS2CActionToAVSDK', { destroyReason: 0 });
  assert.equal(f.controller.current().phase, 'ending');
  await f.controller.nativeOutput({ command: 10, requestId: 'real-close', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'ending');
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, -1, '', ''] });
  assert.equal(f.controller.current().phase, 'ended');
  assert.equal(f.controller.current().nativeEndEvent, 'chat.closed');
});
test('shape diagnostics never retain tickets, numeric pointers or native string payloads', () => {
  const value = summarize({ ticket: 'secret-ticket', unknown: ['secret-unknown', 12345678], bytes: Buffer.from('secret-buffer') });
  const text = JSON.stringify(value);
  for (const secret of ['secret-ticket', 'secret-unknown', '12345678', 'secret-buffer']) assert.ok(!text.includes(secret));
});
test('member callbacks are fingerprint-pinned and leave UID is value[1]', async t => {
  assert.equal(decodeObservation(20009, [0, 'uid', 1, 0, 0, 0, 0, '', ''], 'unverified'), null);
  const f = fixture(); t.after(() => f.controller.stop()); await connected(f);
  await f.controller.nativeOutput({ command: 20008, value: ['peer-a', 1, 0, 0, 0, 0, ''] });
  assert.deepEqual(f.controller.current().participants.map(p => p.uid), ['caller-uid', 'peer-a']);
  assert.equal(f.controller.current().participantsKnown, false);
  await f.controller.nativeOutput({ command: 20009, value: [100, 'peer-a', 1, 0, 0, 0, 0, '', ''] });
  assert.deepEqual(f.controller.current().participants.map(p => p.uid), ['caller-uid']);
  const room = { relation_id: '123456', scene_id: 1, user_num: 1, user_list: [{ uid: 'peer-b', account_type: 1 }] };
  await f.controller.nativeOutput({ command: 20010, value: [JSON.stringify(room), 0] });
  assert.equal(f.controller.current().participantsKnown, true);
  await f.controller.nativeOutput({ command: 20010, value: ['', 1] });
  assert.deepEqual(f.controller.current().participants.map(p => p.uid), ['peer-b']);
  await f.controller.nativeOutput({ command: 20010, value: [JSON.stringify({ ...room, relation_id: 'wrong', user_list: [] }), 0] });
  assert.deepEqual(f.controller.current().participants.map(p => p.uid), ['peer-b']);
});
test('bounded event cursor exposes gaps and process restart resets', t => {
  const f = fixture({ maxEvents: 3 }); t.after(() => f.controller.stop());
  for (let i = 0; i < 10; i++) f.native('onUnknown', i);
  assert.equal(f.controller.getEvents(0).events.length, 3);
  assert.equal(f.controller.getEvents(0).gap, true);
  assert.equal(f.controller.getEvents(100, 'other-boot').reset, true);
});
test('HTTP authentication, true unavailable errors and malformed cursor', async t => {
  const f = fixture({ mediaEnabled: false }); const token = 'a'.repeat(32);
  const server = createHttpServer(f.controller, token);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await f.controller.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/v1/status')).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const unsupported = await fetch(base + '/v1/groups/join', { method: 'POST', headers, body: JSON.stringify({ requestId: 'test', groupId: '123456' }) });
  assert.equal(unsupported.status, 503);
  assert.equal((await unsupported.json()).error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await fetch(base + '/v1/events?after=NaN', { headers })).status, 400);
  assert.throws(() => parseSettings({ KOISHI_RTC_QQ_BRIDGE_HOST: '0.0.0.0' }, '/nonexistent'), /loopback/);
});
test('private dial follows recovered GUI JSON, binds real UID/UIN, and awaits room entry', async t => {
  const expected = { scene_id: 1, self_uid: 'self-uid', invite_count: 1, invite_uids: ['caller-uid'],
    sub_business_type: 1, invite_reason: 0, relation_id: '123456', invite_original: 0,
    use_ntrtc_dsp: false, ntrtc_ai_denoise_update_model: '', c2c_extend_params: {}, opensdk_enter_room_params: {} };
  assert.deepEqual(JSON.parse(buildPrivateDialParams({ selfUid: 'self-uid', peerUid: 'caller-uid', peerUin: '123456' })[0]), expected);
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  const input = { requestId: 'dial-1', peerUid: '123456' };
  const result = await f.controller.control('dial', input);
  assert.equal(result.status, 'submitted');
  assert.equal(f.invocations.at(-1).command, 4);
  assert.deepEqual(JSON.parse(f.invocations.at(-1).params[0]), expected);
  assert.equal(f.controller.current().phase, 'dialing');
  await f.controller.nativeOutput({ command: 4, requestId: 'dial-1', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'calling');
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.controller.current().phase, 'connected');
  assert.equal((await f.controller.control('dial', input)).callId, result.callId);
  assert.equal(f.invocations.filter(x => x.command === 4).length, 1);
  assert.equal(f.controller.status().selfId, '98765');
});
test('private video dial uses DAV subtype 2 and never opens a capture device', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  const input = { requestId: 'video-new', peerUid: '123456', media: 'video' };
  const result = await f.controller.control('dial', input);
  assert.equal(result.status, 'submitted');
  const params = JSON.parse(f.invocations.at(-1).params[0]);
  assert.equal(params.scene_id, 1); assert.equal(params.sub_business_type, 2);
  assert.equal(params.invite_original, 0); assert.equal(params.invite_reason, 0);
  assert.equal(params.relation_id, '123456'); assert.deepEqual(params.invite_uids, ['caller-uid']);
  assert.equal(f.controller.current().media, 'video');
  assert.equal(f.controller.current().nativeSceneId, 1);
  assert.equal(f.invocations.some(x => [30, 43, 46, 47, 48].includes(x.command)), false);
  assert.equal((await f.controller.control('dial', input)).callId, result.callId);
  await assert.rejects(f.controller.control('dial', { ...input, media: 'audio' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
});
test('dial rejects mismatched identity and unresolved targets before native invocation', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  await assert.rejects(f.controller.control('dial', { requestId: 'mismatch', peerUid: 'caller-uid', peerUin: '999999' }), e => e.code === 'TARGET_MISMATCH');
  await assert.rejects(f.controller.control('dial', { requestId: 'missing', peerUid: '777777' }), e => e.code === 'TARGET_UNRESOLVED');
  assert.equal(f.invocations.filter(x => x.command === 4).length, 0);
});
test('private screen dial waits for correlated bool capability then starts a new scene 2 invitation', async t => {
  const invocations = []; let checkSent;
  const pendingCheck = new Promise(resolve => { checkSent = resolve; });
  const f = fixture({ invokeHost: async (command, params, requestId) => {
    invocations.push({ command, params, requestId });
    if (command === 43) checkSent(requestId);
    return { posted: true, id: invocations.length };
  } });
  t.after(() => f.controller.stop()); await f.controller.login();
  const input = { requestId: 'screen-new', peerUid: '123456', media: 'screen' };
  const pendingCall = f.controller.control('dial', input);
  const checkId = await pendingCheck;
  assert.deepEqual(invocations.at(-1).params, ['caller-uid']);
  assert.equal(f.controller.current(), null, 'posting a query does not start a call');
  await f.controller.nativeOutput({ command: 43, requestId: 'stale-query', value: [1, ''] });
  assert.equal(invocations.filter(entry => entry.command === 4).length, 0);
  await f.controller.nativeOutput({ command: 43, requestId: checkId, value: [1, ''] });
  const receipt = await pendingCall;
  const params = JSON.parse(invocations.at(-1).params[0]);
  assert.equal(invocations.at(-1).command, 4);
  assert.deepEqual(params, { scene_id: 2, self_uid: 'self-uid', invite_count: 1, invite_uids: ['caller-uid'],
    sub_business_type: 3, invite_reason: 0, relation_id: '123456', invite_original: 5,
    use_ntrtc_dsp: false, ntrtc_ai_denoise_update_model: '', c2c_extend_params: {}, opensdk_enter_room_params: {} });
  assert.equal(f.controller.current().media, 'screen');
  assert.deepEqual(f.controller.current().nativeRoom, { sceneId: 2, relationId: '123456' });
  await f.controller.nativeOutput({ command: 4, requestId: input.requestId, value: [0, ''] });
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.controller.current().phase, 'connected');
  assert.deepEqual(invocations.at(-1), { command: 13, params: [2, '123456'], requestId: invocations.at(-1).requestId });
  assert.equal((await f.controller.control('dial', input)).callId, receipt.callId);
  await assert.rejects(f.controller.control('dial', { ...input, media: 'audio' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(invocations.filter(entry => entry.command === 43).length, 1);
  assert.equal(invocations.filter(entry => entry.command === 4).length, 1);
  await f.controller.control('hangup', { requestId: 'screen-end', callId: receipt.callId });
  assert.equal(invocations.at(-1).command, 8); assert.deepEqual(invocations.at(-1).params, [2, 0]);
  await f.controller.nativeOutput({ command: 8, requestId: 'screen-end', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'ending', 'Quit ACK is not termination evidence');
  await f.controller.nativeOutput({ command: 20011, value: [2, '123456', 'screen-room'] });
  assert.equal(f.controller.current().phase, 'ended');
});
test('screen capability false, invalid reply, timeout and failed transport never start a call', async t => {
  for (const outcome of ['unsupported', 'malformed', 'timeout', 'transport']) {
    const invocations = [];
    const f = fixture({ ackTimeoutMs: 10, invokeHost: async (command, params, requestId) => {
      invocations.push({ command, params, requestId });
      if (command === 43) {
        if (outcome === 'transport') throw new Error('offline');
        if (outcome !== 'timeout') queueMicrotask(() => void f.controller.nativeOutput({ command, requestId, value: outcome === 'unsupported' ? [0, ''] : [true, ''] }));
      }
      return { posted: true, id: invocations.length };
    } });
    t.after(() => f.controller.stop()); await f.controller.login();
    const expected = { unsupported: 'PEER_SCREEN_UNSUPPORTED', malformed: 'INVALID_OUTPUT', timeout: 'NATIVE_CHECK_TIMEOUT', transport: 'NATIVE_CHECK_FAILED' }[outcome];
    await assert.rejects(f.controller.control('dial', { requestId: 'not-started', peerUid: '123456', media: 'screen' }), error => error.code === expected);
    assert.equal(f.controller.current(), null); assert.equal(invocations.filter(entry => entry.command === 4).length, 0);
  }
});
test('screen dial cannot displace an active call or bypass exact platform support', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); const active = await connected(f);
  await assert.rejects(f.controller.control('dial', { requestId: 'no-upgrade', peerUid: '123456', media: 'screen' }), error => error.code === 'CALL_STATE_CONFLICT');
  assert.equal(f.controller.current().id, active.id);
  assert.equal(f.controller.current().nativeSceneId, 1);
  assert.equal(f.invocations.filter(entry => entry.command === 43).length, 0);
  await assert.rejects(f.controller.nativeOutput({ command: 20006, value: [2, ...invite.slice(1)] }), error => error.code === 'STALE_INVITE');
  assert.equal(f.controller.current().nativeSceneId, 1, 'a late scene 2 callback cannot upgrade a connected DAV call');
  await assert.rejects(f.controller.control('dial', { requestId: 'unknown-media', peerUid: '123456', media: 'unknown' }), error => error.code === 'INVALID_REQUEST');
  const windows = fixture({ platform: 'win32', arch: 'x64', probeHost: async () => ({ ready: true, pluginFound: true,
    methods: ['postMessage'], nativeProfile: { ...WINDOWS_PROFILE, id: 'unknown-new-build' }, audioRouting: { ready: true } }) });
  t.after(() => windows.controller.stop()); await assert.rejects(windows.controller.login(), /Audited native profile unavailable/);
  assert.equal(windows.controller.capabilities().capabilities['private.screenDial'].status, 'unavailable');
  await assert.rejects(windows.controller.control('dial', { requestId: 'unverified-screen', peerUid: '123456', media: 'screen' }), error => error.code === 'CAPABILITY_UNAVAILABLE');
  assert.equal(windows.invocations.filter(entry => [4, 43].includes(entry.command)).length, 0);
});
test('an incoming call during the capability check stays active; no implicit upgrade is submitted', async t => {
  let checkSent;
  const pendingCheck = new Promise(resolve => { checkSent = resolve; });
  const invocations = [];
  const f = fixture({ invokeHost: async (command, params, requestId) => {
    invocations.push({ command, params, requestId }); if (command === 43) checkSent(requestId);
    return { posted: true, id: invocations.length };
  } });
  t.after(() => f.controller.stop()); await f.controller.login();
  const call = f.controller.control('dial', { requestId: 'racing-screen', peerUid: '123456', media: 'screen' });
  const checkId = await pendingCheck;
  f.native('onInviteActionToAVSDK', { invite_type: 1 }, 2, 'opaque');
  await f.controller.nativeOutput({ command: 20006, value: invite });
  const incomingId = f.controller.current().id;
  await f.controller.nativeOutput({ command: 43, requestId: checkId, value: [1, ''] });
  await assert.rejects(call, error => error.code === 'CALL_STATE_CONFLICT');
  assert.equal(f.controller.current().id, incomingId); assert.equal(f.controller.current().phase, 'ringing');
  assert.equal(invocations.filter(entry => entry.command === 4).length, 0);
});
test('concurrent screen requests submit one call and Host restart cancels an unresolved check', async t => {
  const checks = [], invocations = []; let bothSent;
  const both = new Promise(resolve => { bothSent = resolve; });
  let bootId = 'host-one';
  const f = fixture({ probeHost: async () => ({ bootId, ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: PROFILE }),
    invokeHost: async (command, params, requestId) => {
      invocations.push({ command, params, requestId });
      if (command === 43) { checks.push(requestId); if (checks.length === 2) bothSent(); }
      return { posted: true, id: invocations.length };
    } });
  t.after(() => f.controller.stop()); await f.controller.login();
  const input = { requestId: 'same-screen', peerUid: '123456', media: 'screen' };
  const pending = [f.controller.control('dial', input), f.controller.control('dial', input)];
  await both;
  for (const requestId of checks) await f.controller.nativeOutput({ command: 43, requestId, value: [1, ''] });
  const results = await Promise.all(pending);
  assert.equal(results[0].callId, results[1].callId);
  assert.equal(invocations.filter(entry => entry.command === 4).length, 1);
  const gChecks = []; let querySent;
  const query = new Promise(resolve => { querySent = resolve; });
  const g = fixture({ probeHost: async () => ({ bootId, ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: PROFILE }),
    invokeHost: async (command, params, requestId) => {
      gChecks.push({ command, params, requestId }); if (command === 43) querySent(requestId);
      return { posted: true, id: gChecks.length };
    } });
  t.after(() => g.controller.stop()); await g.controller.login();
  const interrupted = g.controller.control('dial', { ...input, requestId: 'interrupted-screen' });
  const rejects = assert.rejects(interrupted, error => error.code === 'HOST_RESTARTED');
  const oldCheck = await query;
  bootId = 'host-two'; await g.controller.probe(); await rejects;
  await g.controller.nativeOutput({ command: 43, requestId: oldCheck, value: [1, ''] });
  assert.equal(g.controller.current(), null); assert.equal(gChecks.filter(entry => entry.command === 4).length, 0);
});
test('incoming private screen invite retains scene through acceptance, identity lookup and room membership', async t => {
  for (const action of ['accept', 'reject']) {
    const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
    f.native('onInviteActionToAVSDK', { invite_type: 2 }, 2, 'opaque-screen');
    const screenInvite = [...invite]; screenInvite[0] = 2; screenInvite[3] = 3; screenInvite[4] = '98765';
    await f.controller.nativeOutput({ command: 20006, value: screenInvite });
    const call = f.controller.current();
    assert.equal(call.kind, 'private'); assert.equal(call.media, 'screen'); assert.equal(call.acceptReady, true);
    assert.deepEqual(call.nativeRoom, { sceneId: 2, relationId: '98765' });
    await f.controller.control(action, { requestId: 'screen-response', callId: call.id });
    if (action === 'reject') {
      assert.equal(f.invocations.at(-1).command, 9); assert.deepEqual(f.invocations.at(-1).params, [2, 'caller-uid', 2]);
      continue;
    }
    assert.equal(f.invocations.at(-1).command, 5);
    assert.deepEqual(f.invocations.at(-1).params, [2, 'self-uid', ['caller-uid'], 3, '98765', false, 'dsp-model']);
    await f.controller.nativeOutput({ command: 5, requestId: 'screen-response', value: [0] });
    await f.controller.nativeOutput({ command: 20004, value: [0] });
    const room = { relation_id: '98765', scene_id: 2, user_num: 1, user_list: [{ uid: 'caller-uid', account_type: 1 }] };
    await f.controller.nativeOutput({ command: 20010, value: [JSON.stringify(room), 0] });
    assert.equal(f.controller.current().participantsKnown, true);
    assert.deepEqual(f.controller.current().participants, [{ uid: 'caller-uid', accountType: 1 }]);
    await f.controller.nativeOutput({ command: 20010, value: [JSON.stringify({ ...room, scene_id: 1, user_list: [] }), 0] });
    assert.equal(f.controller.current().participants.length, 1);
  }
});
const activity = { group_code: '234567', onlineCount: 2, expireTimestamp: 123,
  memberUins: ['123456', '223344'], seq: '100', businessType: 1, isNativeTimeout: false };
test('native group notifications preserve true field types and do not guess GUI wrapping', () => {
  assert.equal(decodeGroupActivity([{ notifyInfo: activity }]), null);
  assert.equal(decodeGroupActivity([{ ...activity, group_code: 234567 }]), null);
  assert.equal(decodeGroupActivity([activity]).onlineCount, 2);
  assert.equal(decodeGroupActivity([{ ...activity, businessType: 0 }]).isAudio, true);
  assert.equal(decodeGroupActivity([{ ...activity, businessType: 2 }]).isAudio, false);
});
test('group join requires fresh real activity, invites no one, and leaves with native group Quit', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  await assert.rejects(f.controller.control('group.join', { requestId: 'empty', groupId: '234567' }), e => e.code === 'CAPABILITY_UNAVAILABLE');
  f.native('onGroupAudioMemNumChange', activity);
  const result = await f.controller.control('group.join', { requestId: 'join-1', groupId: '234567' });
  assert.equal(result.status, 'submitted');
  const params = JSON.parse(f.invocations.at(-1).params[0]);
  assert.equal(params.scene_id, 3); assert.equal(params.relation_id, '234567');
  assert.deepEqual(params.invite_uids, []); assert.equal(params.invite_count, 0);
  assert.equal(params.invite_original, 3);
  assert.deepEqual(f.invocations.at(-1).params, buildGroupJoinParams({ selfUid: 'self-uid', groupId: '234567' }));
  assert.equal(f.controller.current().joinExistingIsAtomic, false);
  await f.controller.nativeOutput({ command: 4, requestId: 'join-1', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'joining');
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.controller.current().phase, 'connected');
  assert.deepEqual(f.invocations.at(-1).params, [3, '234567']);
  assert.equal(f.invocations.at(-1).command, 13);
  await f.controller.control('group.leave', { requestId: 'leave-1', callId: result.callId });
  assert.equal(f.invocations.at(-1).command, 8); assert.deepEqual(f.invocations.at(-1).params, [3, 0]);
  await f.controller.nativeOutput({ command: 8, requestId: 'leave-1', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'ending');
  await f.controller.nativeOutput({ command: 20011, value: [3, '234567', 'room-id'] });
  assert.equal(f.controller.current().phase, 'ended');
});
test('expired, replayed, ended and unknown group notifications cannot silently start a group call', async t => {
  let currentTime = Date.parse('2026-10-05T12:00:00Z');
  const f = fixture({ now: () => new Date(currentTime).toISOString() });
  t.after(() => f.controller.stop()); await f.controller.login();
  f.native('onGroupAudioMemNumChange', activity);
  currentTime += 61000;
  f.native('onGroupAudioMemNumChange', activity); // replay must not refresh observedAt
  await assert.rejects(f.controller.control('group.join', { requestId: 'stale', groupId: '234567' }), e => e.code === 'STALE_GROUP_ACTIVITY');
  f.native('onGroupAudioMemNumChange', { ...activity, seq: '101', onlineCount: 0 });
  await assert.rejects(f.controller.control('group.join', { requestId: 'ended', groupId: '234567' }), e => e.code === 'GROUP_NOT_ACTIVE');
  f.native('onGroupAudioMemNumChange', { ...activity, seq: '102', businessType: 99 });
  await assert.rejects(f.controller.control('group.join', { requestId: 'unknown-type', groupId: '234567' }), e => e.code === 'GROUP_TYPE_UNSUPPORTED');
  assert.equal(f.invocations.filter(x => x.command === 4).length, 0);
});

test('joining a fresh video or screen room does not implicitly open a local camera', async t => {
  for (const businessType of [2, 3]) {
    const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
    f.native('onGroupAudioMemNumChange', { ...activity, businessType });
    await f.controller.control('group.join', { requestId: 'video-room', groupId: '234567' });
    assert.equal(JSON.parse(f.invocations.at(-1).params[0]).sub_business_type, 1);
    assert.equal(f.invocations.some(item => [35, 44, 47, 48].includes(item.command)), false);
  }
});

test('video native metadata is build-pinned, member-bound and preserves terminal identity', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await connected(f);
  await f.controller.nativeOutput({ command: 20008, value: ['caller-uid', 0, 0, 0, 6, 0, ''] });
  assert.equal(f.controller.current().participants[0].terminalType, 6);
  await f.controller.nativeOutput({ command: 20025, value: ['caller-uid', 1] });
  assert.equal(f.controller.current().videoTracks[0].available, true);
  await f.controller.nativeOutput({ command: 20031, value: ['caller-uid', 1, 640, 480] });
  assert.equal(f.controller.current().videoTracks[0].width, 640);
  await f.controller.nativeOutput({ command: 20033, value: ['unknown-user', 1] });
  assert.equal(f.controller.current().videoTracks.length, 1);
  assert.equal(decodeObservation(20025, ['caller-uid', 1], 'unverified'), null);
  assert.equal(decodeObservation(20025, ['caller-uid', 1], LINUX_X64_PROFILE.id)?.type, 'video.availability');
  for (const profile of [WINDOWS_PROFILE, ...MAC_PROFILES]) assert.equal(decodeObservation(20025, ['caller-uid', 1], profile.id)?.type, 'video.availability');
  assert.equal(decodeObservation(20031, ['caller-uid', 1, 100000, 480], PROFILE.id), null);
});

test('video proxy derives session membership, checks call IDs, and never repeats a mutation', async t => {
  const calls = [];
  const f = fixture({ hostRequest: async (route, body) => { calls.push({ route, body }); return { ok: true }; } });
  t.after(() => f.controller.stop()); const active = await connected(f);
  await f.controller.nativeOutput({ command: 20008, value: ['caller-uid', 0, 0, 0, 6, 0, ''] });
  const input = { callId: active.id, uid: 'caller-uid', kind: 'camera', requestId: 'video-subscribe' };
  await Promise.all([f.controller.video('subscribe', input), f.controller.video('subscribe', input)]);
  assert.equal(calls.filter(item => item.route === '/v1/video/subscribe').length, 1);
  assert.deepEqual(calls.filter(item => item.route === '/v1/video/session').at(-1).body,
    { callId: active.id, selfUid: 'self-uid', nativeSceneId: 1, participants: ['caller-uid'] });
  await assert.rejects(f.controller.video('subscribe', { ...input, kind: 'screen' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.controller.video('subscribe', { ...input, requestId: 'outsider', uid: 'somebody-else' }), error => error.code === 'INVALID_TARGET');
  await assert.rejects(f.controller.video('frame', { callId: 'old-call', trackId: 'track' }), error => error.code === 'CALL_STATE_CONFLICT');
  await assert.rejects(f.controller.video('send', { callId: active.id, kind: 'camera', requestId: 'start' }), error => error.code === 'INVALID_REQUEST');
  await f.controller.video('frame', { callId: active.id, trackId: 'camera a/b' });
  assert.ok(calls.at(-1).route.includes('trackId=camera+a%2Fb'));
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, -1, '', ''] });
  await f.controller.video('state');
  assert.equal(calls.filter(item => item.route === '/v1/video/session').at(-1).body.callId, null);
  await f.controller.video('stop', { callId: active.id, kind: 'camera', requestId: 'late-cleanup' });
  assert.equal(calls.at(-1).route, '/v1/video/state', 'ended-call cleanup uses the synchronized empty session');
});

test('DAV authorizes the verified direct peer only after connection without inventing a complete roster', async t => {
  for (const direction of ['incoming', 'outgoing']) {
    const calls = [];
    const f = fixture({ hostRequest: async (route, body) => { calls.push({ route, body }); return {}; } });
    t.after(() => f.controller.stop());
    let call;
    if (direction === 'incoming') {
      call = await incoming(f);
      await f.controller.control('accept', { requestId: 'dav-accept', callId: call.id });
      await f.controller.nativeOutput({ command: 5, requestId: 'dav-accept', value: [0] });
    } else {
      await f.controller.login();
      await f.controller.control('dial', { requestId: 'dav-dial', peerUin: '123456', media: 'video' });
      call = f.controller.current();
      await f.controller.nativeOutput({ command: 4, requestId: 'dav-dial', value: [0, ''] });
    }
    const input = { callId: call.id, uid: 'caller-uid', kind: 'camera', requestId: 'dav-video' };
    assert.deepEqual(f.controller.current().participants, []);
    await assert.rejects(f.controller.video('subscribe', input), error => error.code === 'CALL_STATE_CONFLICT');
    await f.controller.nativeOutput({ command: 20004, value: [0] });
    const current = f.controller.current();
    assert.equal(current.participantsKnown, false); assert.equal(current.participantsSource, 'direct-peer');
    assert.deepEqual(current.participants.map(member => member.uid), ['caller-uid']);
    assert.equal(current.participants[0].identitySource, direction === 'incoming' ? 'native-invite' : 'verified-dial');
    assert.equal(current.participants[0].membershipSource, 'direct-peer');
    await f.controller.video('subscribe', input);
    assert.deepEqual(calls.filter(item => item.route === '/v1/video/session').at(-1).body.participants, ['caller-uid']);
    for (const uid of ['self-uid', 'stranger']) await assert.rejects(f.controller.video('subscribe', { ...input, uid, requestId: uid }), error => error.code === 'INVALID_TARGET');
    if (direction === 'incoming') await f.controller.nativeOutput({ command: 20009, value: [0, 'caller-uid', 1, 0, 0, 0, 0, '', ''] });
    else await f.controller.nativeOutput({ command: 20010, value: [JSON.stringify({ relation_id: '123456', scene_id: 1, user_num: 0, user_list: [] }), 0] });
    await f.controller.video('state');
    assert.deepEqual(f.controller.current().participants, []);
    await assert.rejects(f.controller.video('subscribe', { ...input, requestId: 'after-leave' }), error => error.code === 'INVALID_TARGET');
  }
});

test('unknown video delivery remains reserved and is not retried', async t => {
  let posts = 0;
  const f = fixture({ hostRequest: async route => {
    if (route === '/v1/video/subscribe') { posts++; throw new Error('connection lost after submission'); }
    return {};
  } });
  t.after(() => f.controller.stop()); const active = await connected(f);
  await f.controller.nativeOutput({ command: 20008, value: ['caller-uid', 0, 0, 0, 6, 0, ''] });
  const input = { callId: active.id, uid: 'caller-uid', kind: 'camera', requestId: 'once' };
  await assert.rejects(f.controller.video('subscribe', input), /connection lost/);
  await assert.rejects(f.controller.video('subscribe', input), /connection lost/);
  assert.equal(posts, 1);
});

test('camera framing crosses the proxy and participates in request identity', async t => {
  const sent = [];
  const f = fixture({ hostRequest: async (route, body) => { if (route === '/v1/video/send') sent.push(body); return {}; } });
  t.after(() => f.controller.stop()); const call = await connected(f);
  const request = { callId: call.id, kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe', requestId: 'framed' };
  await f.controller.video('send', request);
  await f.controller.video('send', request);
  assert.equal(sent.length, 1); assert.equal(sent[0].framing, 'portrait-safe');
  await assert.rejects(f.controller.video('send', { ...request, framing: 'full' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  for (const invalid of [{ kind: 'screen' }, { sourceId: 'camera:physical' }, { framing: 'unknown' }]) {
    await assert.rejects(f.controller.video('send', { ...request, ...invalid, requestId: 'invalid' }), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(sent.length, 1);
});

test('JPEG writes bind the connected call and remain transient outside the control request ledger', async t => {
  const forwarded = []; let lastSequence = -1;
  const f = fixture({ hostRequest: async (route, frame) => {
    if (route !== '/v1/video/write') return {};
    forwarded.push(frame);
    const state = frame.sequence > lastSequence ? 'accepted' : 'dropped'; lastSequence = Math.max(lastSequence, frame.sequence);
    return { callId: frame.callId, kind: frame.kind, sequence: frame.sequence, state, evidence: 'host-frame-queue', acceptedBytes: state === 'accepted' ? 4 : 0 };
  } });
  t.after(() => f.controller.stop()); const call = await connected(f);
  const frame = { callId: call.id, kind: 'camera', encoding: 'jpeg', width: 1, height: 1, sequence: 0, timestamp: 1, data: Buffer.from([255, 216, 255, 217]).toString('base64') };
  assert.equal((await f.controller.video('write', { ...frame, requestId: 'reused-control-key' })).state, 'accepted');
  assert.equal((await f.controller.video('write', frame)).state, 'dropped', 'Host owns the bounded frame sequence policy');
  assert.equal((await f.controller.video('write', { ...frame, sequence: 1, requestId: 'reused-control-key' })).state, 'accepted');
  await f.controller.video('stop', { callId: call.id, kind: 'camera', requestId: 'reused-control-key' });
  assert.equal(forwarded.length, 3);
  assert.deepEqual(Object.keys(forwarded[0]).sort(), Object.keys(frame).sort(), 'only the frame envelope crosses to Host');
  for (const invalid of [null, [], { ...frame, callId: 'other-call' }, { ...frame, kind: 'desktop' }, { ...frame, encoding: 'png' },
    { ...frame, width: 0 }, { ...frame, height: 4097 }, { ...frame, width: 4097, height: 1 },
    { ...frame, width: 1921, height: 1080 }, { ...frame, sequence: -1 }, { ...frame, sequence: 0.5 },
    { ...frame, timestamp: Infinity }, { ...frame, data: 'invalid!' }, { ...frame, data: '/9j/2R==' },
    { ...frame, data: Buffer.alloc(256 * 1024 + 1).toString('base64') }, { ...frame, data: Buffer.from([0, 216, 255, 217]).toString('base64') }]) {
    await assert.rejects(f.controller.video('write', invalid), error => ['INVALID_VIDEO', 'CALL_STATE_CONFLICT'].includes(error.code));
  }
  assert.equal(forwarded.length, 3, 'invalid frames never reach native Host');
  const proxy = createHttpServer(f.controller, 'write-frame-test-secret-1234567890');
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/video/write`, { method: 'POST',
    headers: { Authorization: 'Bearer write-frame-test-secret-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...frame, sequence: 2, width: 1080, height: 1920 }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.sequence, 2);
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, -1, '', ''] });
  await assert.rejects(f.controller.video('write', { ...frame, sequence: 3 }), error => error.code === 'CALL_STATE_CONFLICT');
  assert.equal(forwarded.length, 4);
});

test('video source HTTP proxy honors the real VideoHost call contract and retains bounded native errors', async t => {
  const token = 'source-contract-secret-token-1234567890';
  const routes = []; let failure = null;
  const native = new videoModule.VideoHost({ enabled: true, surface: async () => {}, capture: async () => null,
    send: async (cmd, _params, id) => { if (cmd === 46) queueMicrotask(() => native.handle({ cmd, id, value: [0, '', ['Fixture camera'], ['fixture-camera']] })); } });
  // Inject only the frame producer dependency; exercise the real source/session contract.
  native.outputBackend = { cameraAvailable: () => false, close: async () => {} };
  const hostServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); routes.push(url);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    try {
      let data;
      if (url.pathname === '/v1/video/session') {
        let text = ''; for await (const chunk of req) text += chunk;
        data = await native.session(JSON.parse(text));
      } else if (url.pathname === '/v1/video/sources') {
        if (failure) throw failure;
        // Invoke the actual Host implementation, whose require(callId) catches
        // a missing query rather than accepting arbitrary mock arguments.
        data = await native.sources(Object.fromEntries(url.searchParams));
      } else data = native.state();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, data }));
    } catch (error) {
      res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: -1, message: error.message, errorCode: error.code }));
    }
  });
  await new Promise(resolve => hostServer.listen(0, '127.0.0.1', resolve));
  const transport = createHostTransport({ avHost: '127.0.0.1', avPort: hostServer.address().port }, token);
  const f = fixture({ hostRequest: transport.hostRequest });
  const proxy = createHttpServer(f.controller, token);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await f.controller.stop(); for (const server of [proxy, hostServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const call = await connected(f), base = `http://127.0.0.1:${proxy.address().port}`, headers = { Authorization: `Bearer ${token}` };
  const sources = await fetch(base + '/v1/video/sources?callId=' + encodeURIComponent(call.id), { headers });
  assert.equal(sources.status, 200);
  const listed = (await sources.json()).data;
  assert.deepEqual(listed.find(source => source.id === 'camera:fixture-camera'), { id: 'camera:fixture-camera', name: 'Fixture camera', kind: 'camera', sourceType: 'device', channels: ['camera'] });
  assert.deepEqual(listed.find(source => source.id === 'external-frames').channels, ['screen']);
  assert.equal(routes.filter(url => url.pathname === '/v1/video/sources').at(-1).searchParams.get('callId'), call.id);
  assert.equal((await fetch(base + '/v1/video/sources?callId=old-call', { headers })).status, 409);
  failure = Object.assign(new Error('Video command 44 failed: Screen capture is not yet supported on wayland!'), { code: 'NATIVE_VIDEO_ERROR' });
  const failed = await fetch(base + '/v1/video/sources', { headers });
  assert.equal(failed.status, 409);
  assert.deepEqual((await failed.json()).error, { code: 'NATIVE_VIDEO_ERROR', message: failure.message });
  failure = Object.assign(new Error(`Bearer ${token}\n${'detail '.repeat(200)}`), { code: 'NATIVE_VIDEO_ERROR' });
  const limited = (await (await fetch(base + '/v1/video/sources', { headers })).json()).error;
  assert.equal(limited.code, 'NATIVE_VIDEO_ERROR'); assert.ok(limited.message.length <= 500);
  assert.ok(!limited.message.includes(token)); assert.ok(!limited.message.includes('\n'));
});

test('group Quit ACK plus newer complete membership excluding self confirms local exit', async t => {
  for (const ackFirst of [true, false]) {
    const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
    f.native('onGroupAudioMemNumChange', { ...activity, memberUins: ['98765', '123456'] });
    const call = await f.controller.control('group.join', { requestId: 'join', groupId: '234567' });
    await f.controller.nativeOutput({ command: 4, requestId: 'join', value: [0, ''] });
    await f.controller.nativeOutput({ command: 20004, value: [0] });
    await f.controller.control('group.leave', { requestId: 'leave', callId: call.callId });
    const ack = () => f.controller.nativeOutput({ command: 8, requestId: 'leave', value: [0, ''] });
    if (ackFirst) await ack();
    f.native('onGroupAudioMemNumChange', { ...activity, seq: '101', onlineCount: 2, memberUins: ['123456'] });
    assert.equal(f.controller.current().phase, 'ending', 'incomplete list cannot prove absence');
    f.native('onGroupAudioMemNumChange', { ...activity, seq: '102', onlineCount: 1, memberUins: ['123456'], isNativeTimeout: true });
    assert.equal(f.controller.current().phase, 'ending', 'expiry timeout is not server exit evidence');
    f.native('onGroupAudioMemNumChange', { ...activity, seq: '103', onlineCount: 1, memberUins: ['123456'] });
    if (!ackFirst) {
      assert.equal(f.controller.current().phase, 'ending', 'membership alone does not confirm native Quit');
      await ack();
    }
    assert.equal(f.controller.current().phase, 'ended');
    assert.equal(f.controller.current().nativeEndEvent, 'group.membership.left');
    assert.equal(f.controller.current().groupLeaveEvidence.seq, '103');
  }
});

test('explicit group creation resolves only named invitees and is idempotent without room activity', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  assert.equal(f.controller.capabilities().capabilities['group.join'].status, 'unverified');
  assert.equal(f.controller.capabilities().capabilities['group.start'].status, 'supported');
  const body = { requestId: 'create-group', groupId: '234567', inviteeIds: ['123456'] };
  const results = await Promise.all([f.controller.control('group.start', body), f.controller.control('group.start', body)]);
  assert.equal(results[0].callId, results[1].callId);
  const commands = f.invocations.filter(item => item.command === 4);
  assert.equal(commands.length, 1);
  const expected = buildGroupStartParams({ selfUid: 'self-uid', groupId: '234567', inviteUids: ['caller-uid'] });
  assert.deepEqual(commands[0].params, expected);
  assert.deepEqual(JSON.parse(expected[0]), { ...JSON.parse(buildGroupJoinParams({ selfUid: 'self-uid', groupId: '234567' })[0]),
    invite_count: 1, invite_uids: ['caller-uid'] });
  assert.equal(f.controller.current().creationRequested, true);
  assert.deepEqual(f.controller.current().invitedAccounts, [{ userId: '123456', uid: 'caller-uid' }]);
  assert.equal(f.controller.current().phase, 'joining');
  await f.controller.nativeOutput({ command: 4, requestId: body.requestId, value: [0, ''] });
  assert.equal(f.controller.current().phase, 'joining', 'StartCall ACK is not entry evidence');
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  assert.equal(f.controller.current().phase, 'connected');
  await assert.rejects(f.controller.control('group.start', { ...body, inviteeIds: ['223344'] }), e => e.code === 'IDEMPOTENCY_CONFLICT');
});

test('group create rejects implicit, duplicate, unresolved and self invitations before native calls', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  for (const inviteeIds of [undefined, [], ['123456', '123456'], ['caller-uid'], [123456], Array.from({ length: 21 }, (_, i) => String(123450 + i))]) {
    await assert.rejects(f.controller.control('group.start', { requestId: 'bad', groupId: '234567', inviteeIds }), e => e.code === 'INVALID_TARGET');
  }
  await assert.rejects(f.controller.control('group.start', { requestId: 'unknown', groupId: '234567', inviteeIds: ['223344'] }), e => e.code === 'TARGET_UNRESOLVED');
  assert.throws(() => buildGroupStartParams({ selfUid: 'self-uid', groupId: '234567', inviteUids: ['self-uid'] }));
  assert.equal(f.invocations.filter(item => item.command === 4).length, 0);
});

test('HTTP group creation uses its explicit route and preserves join-existing semantics', async t => {
  const f = fixture(); await f.controller.login(); const token = 'a'.repeat(32);
  const server = createHttpServer(f.controller, token);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await f.controller.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/groups/start`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'http-create', groupId: '234567', inviteeIds: ['123456'] }),
  });
  assert.equal(response.status, 202); assert.equal((await response.json()).data.operation, 'group.start');
});

test('pre-Quit and reordered membership cannot release the call reservation', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  f.native('onGroupAudioMemNumChange', activity);
  const call = await f.controller.control('group.join', { requestId: 'join', groupId: '234567' });
  await f.controller.nativeOutput({ command: 4, requestId: 'join', value: [0, ''] });
  await f.controller.nativeOutput({ command: 20004, value: [0] });
  await f.controller.control('group.leave', { requestId: 'leave', callId: call.callId });
  await f.controller.nativeOutput({ command: 8, requestId: 'leave', value: [0, ''] });
  assert.equal(f.controller.current().phase, 'ending', 'pre-Quit snapshot excluding self is insufficient');
  f.native('onGroupAudioMemNumChange', { ...activity, seq: '99', onlineCount: 0, memberUins: [] });
  assert.equal(f.controller.current().phase, 'ending', 'reordered activity cannot release reservation');
});


test('Host and controller audited build profiles agree exactly', () => {
  assert.deepEqual(hostProfiles, PROFILES.map(({ participants, ...profile }) => profile));
});
test('audited Linux x64 initializes the UID identity and keeps native errors explicitly cleanable', async t => {
  const f = fixture({ arch: 'x64', probeHost: async () => ({ ready: true, pluginFound: true,
    methods: ['postMessage'], nativeProfile: LINUX_X64_PROFILE }) });
  t.after(() => f.controller.stop());
  const call = await incoming(f);
  assert.deepEqual(f.invocations.slice(0, 2).map(({ command, params }) => ({ command, params })), [
    { command: 57, params: ['1.0.1230'] },
    { command: 1, params: ['self-uid', '98765', '', '/fake/QQ-root', ''] },
  ]);
  await f.controller.control('accept', { requestId: 'x64-accept', callId: call.id });
  assert.deepEqual(f.invocations.at(-1).params, buildAcceptParams(invite, 'self-uid'));
  await f.controller.nativeOutput({ command: 5, requestId: 'x64-accept', value: [0] });
  await f.controller.nativeOutput({ command: 20005, value: [] });
  assert.equal(f.controller.current().nativeTeardownUnknown, true);
  await f.controller.control('hangup', { requestId: 'x64-cleanup', callId: call.id });
  assert.equal(f.invocations.at(-1).command, 10);
  assert.deepEqual(f.invocations.at(-1).params, [1, 'caller-uid', 0]);
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, -1, '', ''] });
  assert.equal(f.controller.current().phase, 'ended');
  assert.deepEqual(decodeObservation(20003, [3, '234567', 'fixture native error'], LINUX_X64_PROFILE.id),
    { type: 'call.error', sceneId: 3, relationId: '234567', message: 'fixture native error' });
  assert.equal(decodeObservation(20003, [3, '234567', 'fixture'], WINDOWS_PROFILE.id), null);
  assert.equal(decodeObservation(20005, [0], LINUX_X64_PROFILE.id), null);
  assert.equal(decodeObservation(20009, [1, 'uid', 2, 0, 0, 0, 0, '', ''], LINUX_X64_PROFILE.id)?.uid, 'uid');
});
test('Windows and Mac require explicit audio routes for starting calls, but login and rejection remain available', async t => {
  for (const profile of [WINDOWS_PROFILE, ...MAC_PROFILES]) {
    let ready = false;
    const f = fixture({ platform: profile.platform, arch: profile.arch,
      probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: profile, audioRouting: { ready } }) });
    t.after(() => f.controller.stop()); const call = await incoming(f);
    assert.equal(f.invocations[0].command, 1, 'login is necessary before device initialization');
    assert.equal(f.controller.capabilities().capabilities['private.accept'].status, 'unavailable');
    assert.equal(f.controller.capabilities().capabilities['private.reject'].status, 'supported');
    await assert.rejects(f.controller.control('accept', { requestId: 'route-not-ready', callId: call.id }), e => e.code === 'CAPABILITY_UNAVAILABLE');
    ready = true;
    await f.controller.control('accept', { requestId: 'route-confirmed', callId: call.id });
    await f.controller.nativeOutput({ command: 5, requestId: 'route-confirmed', value: [0] });
    await f.controller.nativeOutput({ command: 20004, value: [0] });
    ready = false;
    await f.controller.control('hangup', { requestId: 'lost-route-close', callId: call.id });
    assert.equal(f.invocations.at(-1).command, 10, 'ending cannot be deadlocked by lost audio route');
    await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, 0, '', ''] });
    assert.equal(f.controller.current().phase, 'ended');
  }
});
test('unverified platform/architecture profile cannot enable controls or non-Linux login', async t => {
  const f = fixture({ platform: 'win32', arch: 'arm64', probeHost: async () => ({
    ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: WINDOWS_PROFILE, routeReady: true }) });
  t.after(() => f.controller.stop());
  await assert.rejects(f.controller.login(), /Audited native profile unavailable/);
  assert.equal(f.invocations.length, 0);
  assert.equal(f.controller.capabilities().capabilities['private.dial'].status, 'unavailable');
});
test('Mac and Windows exact callback profiles decode independently verified member layouts', () => {
  for (const profile of [...MAC_PROFILES, WINDOWS_PROFILE]) assert.equal(decodeObservation(20009, [1, 'uid', 2, 0, 0, 0, 0, '', ''], profile.id)?.uid, 'uid');
  assert.equal(decodeObservation(20009, [1, 'uid', 2, 0, 0, 0, 0, '', ''], 'unverified'), null);
});


test('an explicit hangup can reconcile unknown accept without retrying it or claiming completion', async t => {
  const posted = [];
  const f = fixture({ invokeHost: async (command, params, requestId) => {
    posted.push({ command, params, requestId });
    if (command === 5) throw new Error('unknown native delivery');
    return { posted: true, id: posted.length };
  } });
  t.after(() => f.controller.stop()); const call = await incoming(f);
  const original = { requestId: 'accept-uncertain', callId: call.id };
  assert.equal((await f.controller.control('accept', original)).status, 'unknown');
  await f.controller.control('hangup', { requestId: 'explicit-reconcile', callId: call.id });
  assert.deepEqual(posted.at(-1).params, [1, 'caller-uid', 0]);
  assert.equal(posted.at(-1).command, 10);
  assert.equal(f.controller.current().phase, 'ending');
  assert.equal((await f.controller.control('accept', original)).status, 'unknown');
  assert.equal(posted.filter(p => p.command === 5).length, 1);
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, 0, '', ''] });
  assert.equal(f.controller.current().phase, 'ended');
});

test('native initialization notices cannot reenter Login or create a login feedback loop', async t => {
  let controller, loginCount = 0;
  const f = fixture({ invokeHost: async command => {
    if (command === 1) {
      loginCount++;
      await controller.nativeOutput({ command: 120043, value: [] });
      await controller.nativeOutput({ command: 20050, value: [] });
    }
    return { posted: true, id: loginCount + 1 };
  } });
  controller = f.controller; t.after(() => controller.stop());
  await controller.login();
  for (let i = 0; i < 10; i++) await controller.nativeOutput({ command: 120043, value: [] });
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(loginCount, 1);
  assert.equal(controller.status().loginPosted, true);
  assert.equal(controller.status().sdkLogMessages, 12);
});

test('a native group invitation never occupies the call slot; explicit join still uses the fresh active room', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  f.native('onInviteActionToAVSDK', { invite_type: 3, relation_id: '857518324', from_uid: '' }, 1, 'opaque-group-invitation');
  assert.equal(f.controller.current(), null);
  assert.equal(f.controller.group().invitations[0].groupId, '857518324');
  await f.controller.nativeOutput({ command: 20006, value: [3, ...invite.slice(1)] });
  assert.equal(f.controller.current(), null);
  assert.equal(f.invocations.filter(x => x.command === 5 || x.command === 4).length, 0);
  f.native('onGroupAudioMemNumChange', { group_code: '857518324', onlineCount: 1,
    expireTimestamp: 0, memberUins: ['123456'], seq: '7', businessType: 1, isNativeTimeout: false });
  await f.controller.control('group.join', { requestId: 'join-from-invitation', groupId: '857518324' });
  assert.equal(f.controller.current().kind, 'group');
  assert.equal(f.controller.current().groupId, '857518324');
  assert.equal(f.controller.current().phase, 'joining');
  assert.equal(f.invocations.at(-1).command, 4);
});


test('all official GUI Kernel output branches preserve opaque payloads exactly', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  for (const command of [55, 20000, 20001, 20002, 120003]) {
    await f.controller.nativeOutput({ command, value: [1, 'dGVzdC1wYXlsb2Fk'] });
  }
  assert.equal(f.transports.length, 5);
  assert.ok(f.transports.every(x => x.actionType === 1 && x.payload === 'dGVzdC1wYXlsb2Fk'));
  assert.equal(f.controller.getEvents().events.filter(e => e.type === 'native.transport').length, 5);
  await assert.rejects(f.controller.nativeOutput({ command: 20000, value: [1, [1, 2]] }), e => e.code === 'INVALID_OUTPUT');
  assert.equal(f.transports.length, 5);
});

test('native group timeout and matching OnError report failure without asserting teardown', async t => {
  const f = fixture(); t.after(() => f.controller.stop()); await f.controller.login();
  f.native('onGroupAudioMemNumChange', { group_code: '857518324', onlineCount: 1,
    expireTimestamp: 0, memberUins: ['123456'], seq: '7', businessType: 1, isNativeTimeout: false });
  const receipt = await f.controller.control('group.join', { requestId: 'join-timeout', groupId: '857518324' });
  await f.controller.nativeOutput({ command: 4, requestId: 'join-timeout', value: [0, ''] });
  await f.controller.nativeOutput({ command: 20003, value: [3, '111111111', 'wrong room'] });
  assert.equal(f.controller.current().phase, 'joining');
  await f.controller.nativeOutput({ command: 20005, value: [] });
  assert.equal(f.controller.current().phase, 'error');
  assert.equal(f.controller.current().nativeError, 'Native connection timed out');
  await f.controller.nativeOutput({ command: 20003, value: [3, '857518324', '连接超时'] });
  assert.equal(f.controller.current().nativeError, '连接超时');
  assert.equal(f.controller.current().endedAt, null);
  await assert.rejects(f.controller.control('group.join', { requestId: 'unsafe-retry', groupId: '857518324' }), e => e.code === 'CALL_STATE_CONFLICT');
  await f.controller.control('group.leave', { requestId: 'explicit-timeout-cleanup', callId: receipt.callId });
  assert.equal(f.invocations.at(-1).command, 8);
  await f.controller.nativeOutput({ command: 8, requestId: 'explicit-timeout-cleanup', value: [0, ''] });
  assert.equal(f.controller.current().nativeTeardownUnknown, true);
  await f.controller.control('group.leave', { requestId: 'second-explicit-cleanup', callId: receipt.callId });
  assert.equal(f.controller.current().phase, 'ending');
  await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, 0, '', ''] });
  assert.equal(f.controller.current().phase, 'ended');
  assert.equal(f.controller.current().nativeTeardownUnknown, false);
  assert.equal(f.controller.current().nativeAckTimedOut, false);
});


test('audited Linux initialization follows GUI SDKInfo, UID identity and QQ data root', async t => {
  const f = fixture(); t.after(() => f.controller.stop());
  await f.controller.login();
  assert.deepEqual(f.invocations.slice(0, 2).map(({ command, params }) => ({ command, params })), [
    { command: 57, params: ['1.0.1230'] },
    { command: 1, params: ['self-uid', '98765', '', '/fake/QQ-root', ''] },
  ]);
  assert.equal(f.controller.status().sdkInfoPosted, true);
  assert.equal(f.controller.status().loginIdentityMode, 'uid');
  const noRoot = fixture({ core: null }); t.after(() => noRoot.controller.stop());
  await assert.rejects(noRoot.controller.login(), /user-data root unavailable/);
  assert.equal(noRoot.invocations.length, 0, 'account path must not substitute for the QQ data root');
});


test('missing native ACK becomes unknown, remains reserved and can be explicitly closed', async t => {
  const f = fixture({ ackTimeoutMs: 10 }); t.after(() => f.controller.stop());
  const call = await incoming(f);
  const input = { requestId: 'missing-ack', callId: call.id };
  assert.equal((await f.controller.control('accept', input)).status, 'submitted');
  await new Promise(resolve => setTimeout(resolve, 20));
  const receipt = await f.controller.control('accept', input);
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.errorCode, 'NATIVE_ACK_TIMEOUT');
  assert.equal(f.controller.current().nativeAckTimedOut, true);
  assert.equal(f.invocations.filter(x => x.command === 5).length, 1);
  await f.controller.control('hangup', { requestId: 'ack-timeout-cleanup', callId: call.id });
  assert.equal(f.invocations.at(-1).command, 10);
  await f.controller.nativeOutput({ command: 10, requestId: 'ack-timeout-cleanup', value: [0, ''] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.controller.current().nativeAckTimedOut, false);
  assert.equal(f.controller.current().phase, 'ending');
});


test('only an observed Host boot change releases local call and initializes a new native process once', async t => {
  let bootId = 'host-process-A';
  const f = fixture({ probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: PROFILE, bootId }) });
  t.after(() => f.controller.stop()); await connected(f);
  for (let i = 0; i < 4; i++) { await f.controller.probe(); await f.controller.login(); }
  assert.equal(f.invocations.filter(x => x.command === 1).length, 1);
  bootId = 'host-process-B'; await f.controller.probe();
  assert.equal(f.controller.current().phase, 'ended');
  assert.equal(f.controller.current().nativeEndEvent, 'host.restarted');
  assert.equal(f.controller.current().remoteEndedConfirmed, false);
  assert.equal(f.controller.status().loginPosted, false);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(f.controller.status().loginPosted, true);
  for (let i = 0; i < 4; i++) { await f.controller.probe(); await f.controller.login(); }
  assert.equal(f.invocations.filter(x => x.command === 1).length, 2);
  assert.equal(f.invocations.filter(x => x.command === 57).length, 2);
  assert.equal(new Set(f.invocations.filter(x => x.command === 1).map(x => x.requestId)).size, 2);
});

// Native Close queues work and does not guarantee a local OnChatClosed event.
// Query replies below are protocol fixtures, not a QQ runtime acceptance test.
async function closeQuery(f) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const query = f.invocations.filter(item => item.command === 14).at(-1);
    if (query) return query;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('expected a bounded read-only native room query');
}
test('Close and private/group Quit require a correlated native idle readback', async t => {
  for (const scene of [1, 2, 3]) {
    const f = fixture(); t.after(() => f.controller.stop());
    if (scene === 1) await connected(f);
    else if (scene === 2) {
      await f.controller.login();
      f.native('onInviteActionToAVSDK', { invite_type: 2 }, 2, 'opaque-screen');
      const value = [...invite]; value[0] = 2; value[3] = 3;
      await f.controller.nativeOutput({ command: 20006, value });
      await f.controller.control('accept', { requestId: 'accept-screen', callId: f.controller.current().id });
      await f.controller.nativeOutput({ command: 5, requestId: 'accept-screen', value: [0] });
      await f.controller.nativeOutput({ command: 20004, value: [0] });
    } else {
      await f.controller.login(); f.native('onGroupAudioMemNumChange', activity);
      await f.controller.control('group.join', { requestId: 'join-idle', groupId: activity.group_code });
      await f.controller.nativeOutput({ command: 4, requestId: 'join-idle', value: [0, ''] });
      await f.controller.nativeOutput({ command: 20004, value: [0] });
    }
    const call = f.controller.current();
    await f.controller.control(scene === 3 ? 'group.leave' : 'hangup', { requestId: 'close-idle', callId: call.id });
    assert.equal(f.invocations.some(item => item.command === 14), false, 'do not query before the close ACK');
    await f.controller.nativeOutput({ command: scene === 1 ? 10 : 8, requestId: 'close-idle', value: [0, ''] });
    const query = await closeQuery(f);
    assert.deepEqual(query.params, []);
    assert.equal(f.controller.current().phase, 'ending', 'ACK remains distinct from local termination');
    await f.controller.nativeOutput({ command: 14, requestId: 'unrelated-query', value: [0, '', '0'] });
    await f.controller.nativeOutput({ command: 14, value: [0, '', '0'] });
    await f.controller.nativeOutput({ command: 20013, value: ['1234567890123456789', 0, 'caller-uid'] });
    assert.equal(f.controller.current().phase, 'ending', 'other-terminal events and unsolicited idle results are not proof');
    await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: [0, '', '0'] });
    const ended = f.controller.current();
    assert.equal(ended.phase, 'ended'); assert.equal(ended.nativeEndEvent, 'native.roomIdle');
    assert.equal(ended.remoteEndedConfirmed, false);
    assert.equal(ended.nativeCloseCheck.closeRequestId, 'close-idle');
    assert.equal(ended.nativeCloseCheck.roomId, '0');
  }
});
test('nonzero, empty, malformed and timed-out room queries never synthesize termination', async t => {
  for (const value of [[0, '', '1234567890123456789'], [0, '', ''], [1, '', '0'], [0, '', '00'], [0, '', '18446744073709551616'], null]) {
    const f = fixture({ closeCheckIntervalMs: 1, closeCheckTimeoutMs: 5 }); t.after(() => f.controller.stop());
    const call = await connected(f);
    await f.controller.control('hangup', { requestId: 'close-unconfirmed', callId: call.id });
    await f.controller.nativeOutput({ command: 10, requestId: 'close-unconfirmed', value: [0, ''] });
    let answered = new Set();
    for (let tick = 0; tick < 200 && f.controller.current().nativeCloseCheck.status !== 'unknown'; tick++) {
      for (const query of f.invocations.filter(item => item.command === 14)) if (!answered.has(query.requestId)) {
        answered.add(query.requestId);
        if (value) await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value });
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(f.controller.current().nativeCloseCheck.status, 'unknown');
    assert.equal(f.controller.current().nativeTeardownUnknown, true);
    assert.equal(f.controller.current().phase, 'ending');
    assert.equal(f.invocations.filter(item => item.command === 14).length, 6, 'finite read-only budget');
    assert.equal(f.invocations.filter(item => item.command === 10).length, 1, 'never repeat Close implicitly');
    const old = f.invocations.filter(item => item.command === 14).at(-1);
    await f.controller.control('hangup', { requestId: 'explicit-cleanup', callId: call.id });
    await f.controller.nativeOutput({ command: 14, requestId: old.requestId, value: [0, '', '0'] });
    assert.equal(f.controller.current().phase, 'ending', 'superseded query cannot confirm a new close');
  }
});
test('close verification is cancelled by a lifecycle callback, stop or Host generation change', async t => {
  for (const action of ['native-end', 'stop', 'restart']) {
    let bootId = 'native-A';
    const f = fixture({ closeCheckIntervalMs: 1, closeCheckTimeoutMs: 10,
      probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: PROFILE, bootId }) });
    t.after(() => f.controller.stop()); const call = await connected(f);
    await f.controller.control('hangup', { requestId: 'old-close', callId: call.id });
    await f.controller.nativeOutput({ command: 10, requestId: 'old-close', value: [0, ''] });
    const query = await closeQuery(f);
    if (action === 'native-end') await f.controller.nativeOutput({ command: 20022, value: [0, 0, 1, 0, '', ''] });
    else if (action === 'stop') await f.controller.stop();
    else { bootId = 'native-B'; await f.controller.probe(); }
    if (action !== 'stop') await incoming(f);
    const current = f.controller.current();
    await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: [0, '', '0'] });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(f.controller.current(), current, 'late readback must not alter stopped or replacement calls');
    assert.equal(f.invocations.filter(item => item.command === 14).length, 1, 'no retry timer survives cancellation');
  }
});
test('audited Windows profile enables room idle readback without inferring a queued close is complete', async t => {
  const f = fixture({ platform: 'win32', arch: 'x64', probeHost: async () => ({ ready: true, pluginFound: true, methods: ['postMessage'], nativeProfile: WINDOWS_PROFILE, routeReady: true }) });
  t.after(() => f.controller.stop()); const call = await connected(f);
  await f.controller.control('hangup', { requestId: 'windows-close', callId: call.id });
  await f.controller.nativeOutput({ command: 10, requestId: 'windows-close', value: [0, ''] });
  assert.equal(f.invocations.some(item => item.command === 14), true);
  assert.equal(f.controller.current().phase, 'ending');
});

test('late idle responses and transport failures cannot cross close-query attempts', async t => {
  const invocations = [], submissions = [];
  const f = fixture({ closeCheckTimeoutMs: 15, closeCheckIntervalMs: 1,
    invokeHost: (command, params, requestId) => {
      invocations.push({ command, params, requestId });
      if (command !== 14) return Promise.resolve({ posted: true, id: invocations.length });
      return new Promise((resolve, reject) => submissions.push({ resolve, reject, requestId }));
    } });
  t.after(() => f.controller.stop()); const call = await connected(f);
  await f.controller.control('hangup', { requestId: 'race-close', callId: call.id });
  await f.controller.nativeOutput({ command: 10, requestId: 'race-close', value: [0, ''] });
  for (let tick = 0; submissions.length < 2 && tick < 100; tick++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(submissions.length, 2);
  const [old, current] = submissions;
  await f.controller.nativeOutput({ command: 14, requestId: old.requestId, value: [0, '', '0'] });
  old.reject(new Error('late transport rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.current().phase, 'ending');
  await f.controller.nativeOutput({ command: 14, requestId: current.requestId, value: [0, '', '0'] });
  assert.equal(f.controller.current().phase, 'ended', 'native result may precede its HTTP submission receipt');
  current.resolve({ posted: true, id: 123 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(submissions.length, 2, 'stale failure and late submission success do not restart polling');
  assert.equal(f.controller.current().nativeCloseCheck.requestId, current.requestId);
});

test('lost Close or Quit ACK reconciles previously connected calls through correlated idle readback', async t => {
  for (const scene of [1, 2, 3]) {
    const f = fixture({ ackTimeoutMs: 5 }); t.after(() => f.controller.stop());
    if (scene === 1) await connected(f);
    else if (scene === 2) {
      await f.controller.login();
      f.native('onInviteActionToAVSDK', { invite_type: 2 }, 2, 'opaque-screen');
      const value = [...invite]; value[0] = 2; value[3] = 3;
      await f.controller.nativeOutput({ command: 20006, value });
      await f.controller.control('accept', { requestId: 'accept-screen', callId: f.controller.current().id });
      await f.controller.nativeOutput({ command: 5, requestId: 'accept-screen', value: [0] });
      await f.controller.nativeOutput({ command: 20004, value: [0] });
    } else {
      await f.controller.login(); f.native('onGroupAudioMemNumChange', activity);
      await f.controller.control('group.join', { requestId: 'join-screen', groupId: activity.group_code });
      await f.controller.nativeOutput({ command: 4, requestId: 'join-screen', value: [0, ''] });
      await f.controller.nativeOutput({ command: 20004, value: [0] });
    }
    const call = f.controller.current(), operation = scene === 3 ? 'group.leave' : 'hangup';
    const input = { requestId: 'lost-close', callId: call.id };
    await f.controller.control(operation, input);
    const query = await closeQuery(f);
    assert.equal(f.controller.current().phase, 'ending');
    assert.equal(f.controller.current().nativeCloseCheck.trigger, 'ack-timeout');
    assert.equal(f.controller.current().nativeTeardownUnknown, true);
    await f.controller.nativeOutput({ command: 14, requestId: 'unrelated', value: [0, '', '0'] });
    assert.equal(f.controller.current().phase, 'ending');
    await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: [0, '', '0'] });
    const ended = f.controller.current();
    assert.equal(ended.phase, 'ended'); assert.equal(ended.nativeEndEvent, 'native.roomIdle');
    assert.equal(ended.remoteEndedConfirmed, false); assert.equal(ended.nativeError, null);
    assert.equal(ended.nativeAckTimedOut, false); assert.equal(ended.nativeTeardownUnknown, false);
    assert.equal((await f.controller.control(operation, input)).status, 'unknown', 'idle observation does not invent a lost ACK');
    assert.equal(f.invocations.filter(item => item.command === (scene === 1 ? 10 : 8)).length, 1);
    await f.controller.nativeOutput({ command: scene === 1 ? 10 : 8, requestId: input.requestId, value: [-1, 'late error'] });
    assert.deepEqual(f.controller.current(), ended, 'late close replies cannot resurrect the ended call');
  }
});

test('unknown close transport is read back once without resubmitting Close', async t => {
  const invocations = [];
  const f = fixture({ invokeHost: async (command, params, requestId) => {
    invocations.push({ command, params, requestId });
    if (command === 10) throw new Error('response lost after posting');
    return { posted: true, id: invocations.length };
  } });
  t.after(() => f.controller.stop()); const call = await connected(f);
  const input = { requestId: 'lost-transport', callId: call.id };
  assert.equal((await f.controller.control('hangup', input)).status, 'unknown');
  const query = await closeQuery({ invocations });
  assert.equal(f.controller.current().phase, 'ending');
  assert.equal(f.controller.current().nativeCloseCheck.trigger, 'submission-unknown');
  await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: [0, '', '0'] });
  assert.equal(f.controller.current().phase, 'ended');
  assert.equal((await f.controller.control('hangup', input)).status, 'unknown');
  assert.equal(invocations.filter(item => item.command === 10).length, 1);
});

test('a stalled native engine remains unknown after the finite lost-ACK readback budget', async t => {
  for (const reply of [null, [0, '', '12345']]) {
    const f = fixture({ ackTimeoutMs: 5, closeCheckIntervalMs: 1, closeCheckTimeoutMs: 5 });
    t.after(() => f.controller.stop()); const call = await connected(f);
    await f.controller.control('hangup', { requestId: 'unresponsive-close', callId: call.id });
    const answered = new Set();
    for (let tick = 0; tick < 150 && f.controller.current().nativeCloseCheck?.status !== 'unknown'; tick++) {
      for (const query of f.invocations.filter(item => item.command === 14)) if (!answered.has(query.requestId)) {
        answered.add(query.requestId);
        if (reply) await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: reply });
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(f.controller.current().phase, 'ending');
    assert.equal(f.controller.current().nativeCloseCheck.status, 'unknown');
    assert.equal(f.controller.current().nativeTeardownUnknown, true);
    assert.match(f.controller.current().nativeError, /could not be confirmed/);
    assert.equal(f.invocations.filter(item => item.command === 14).length, 6);
    assert.equal(f.invocations.filter(item => item.command === 10).length, 1);
    const last = f.invocations.filter(item => item.command === 14).at(-1);
    await f.controller.nativeOutput({ command: 14, requestId: last.requestId, value: [0, '', '0'] });
    assert.equal(f.controller.current().phase, 'ending', 'an expired readback cannot release the call');
  }
});

test('an unconfirmed opening cannot use its initial idle room to bypass a missing close ACK', async t => {
  const f = fixture({ ackTimeoutMs: 5 }); t.after(() => f.controller.stop());
  const call = await incoming(f);
  await f.controller.control('accept', { requestId: 'unconfirmed-open', callId: call.id });
  await new Promise(resolve => setTimeout(resolve, 15));
  await f.controller.control('hangup', { requestId: 'unconfirmed-close', callId: call.id });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.controller.current().phase, 'ending');
  assert.equal(f.invocations.filter(item => item.command === 14).length, 0);
  await f.controller.nativeOutput({ command: 10, requestId: 'unconfirmed-close', value: [0, ''] });
  const query = await closeQuery(f);
  await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: [0, '', '0'] });
  assert.equal(f.controller.current().phase, 'ended', 'a later audited close ACK enables the existing verification path');
});

test('a late close ACK preserves the pending readback and its bounded budget', async t => {
  const f = fixture({ ackTimeoutMs: 5 }); t.after(() => f.controller.stop());
  const call = await connected(f);
  await f.controller.control('hangup', { requestId: 'late-close-ack', callId: call.id });
  const query = await closeQuery(f);
  await f.controller.nativeOutput({ command: 10, requestId: 'late-close-ack', value: [0, ''] });
  assert.equal(f.invocations.filter(item => item.command === 14).length, 1);
  await f.controller.nativeOutput({ command: 14, requestId: query.requestId, value: [0, '', '0'] });
  assert.equal(f.controller.current().phase, 'ended');
  assert.equal(f.controller.current().nativeCloseCheck.attempts, 1);
});
