// SPDX-License-Identifier: GPL-3.0-only
// AVSDK mappings derived from ClaudiaGardner/maibot-qq-voice-call 0.3.4.
import { createHash, randomUUID } from 'node:crypto';
import { buildGroupJoinParams, buildGroupStartParams, buildPrivateDialParams, decodeGroupActivity, decodeObservation, profileById } from './native-profile.mjs';

export const PROTOCOL_VERSION = 1;
export const NATIVE = Object.freeze({ LOGIN: 1, START_CALL: 4, ACCEPT: 5, KERNEL: 55, SDK_INFO: 57,
  QUIT: 8, REJECT: 9, CLOSE: 10, ROOM_INFO: 13, CHATTING_ROOM: 14, CHECK_PRIVATE_SCREEN: 43, NETWORK: 20001, ENTER_ROOM: 20004, INVITE: 20006 });
// Official GUI build 53644 forwards all of these envelopes to the same Kernel
// method. The native binding accepts the base64 string unchanged; the GUI's
// TextEncoder is an IPC serialization detail, not a base64 decoding operation.
const KERNEL_OUTPUTS = new Set([55, 20000, 20001, 20002, 120003]);
const UPSTREAM = 'https://github.com/ClaudiaGardner/maibot-qq-voice-call/tree/main/bridge';
const UNKNOWN = 'No verified native command and parameter mapping. Disabled; native method names alone are not proof.';
export class BridgeError extends Error {
  constructor(code, message, status = 400, detail = {}) {
    super(message); this.code = code; this.status = status; Object.assign(this, detail);
  }
}

export function buildAcceptParams(invite, selfUid) {
  if (!Array.isArray(invite) || invite.length < 12) throw new BridgeError('INVALID_INVITE', 'Incomplete AVSDK invite');
  // GUI Accept's second argument is the logged-in selfUid, independently of
  // the inviter list. Preserve the invitation's relationId; it is not always
  // the remote caller's account number (especially in private MAV rooms).
  const p = [invite[0], selfUid, [invite[1]], invite[3], invite[4], Boolean(invite[10]), invite[11]];
  if (!Number.isInteger(p[0]) || typeof p[1] !== 'string' || !p[1] ||
      p[1].length > 512 || typeof invite[1] !== 'string' || !invite[1] || invite[1].length > 512 ||
      !Number.isInteger(p[3]) || typeof p[4] !== 'string' || !/^\d{1,20}$/.test(p[4]) ||
      BigInt(p[4]) > 18446744073709551615n || typeof p[6] !== 'string') {
    throw new BridgeError('INVALID_INVITE', 'Unknown native Accept argument shape');
  }
  return p;
}

// Shape-only diagnostics. Never return native strings, tickets, binary content or pointers.
export function summarize(value, depth = 0) {
  if (value === null) return { type: 'null' };
  if (depth > 2) return { type: typeof value };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { type: 'binary', length: value.byteLength };
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.slice(0, 8).map(v => summarize(v, depth + 1)) };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 40).map(key => ({
    key, value: /(auth|ticket|token|sign|cookie|session|password|secret|pointer)/i.test(key) ? { type: 'redacted' } : summarize(value[key], depth + 1),
  })) };
  if (typeof value === 'string') return { type: 'string', length: value.length };
  return { type: typeof value }; // even numeric native values may contain pointers/account IDs
}

function methodsOf(value) {
  const methods = new Set();
  for (let item = value, depth = 0; item && depth < 5; item = Object.getPrototypeOf(item), depth++) {
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || key === 'constructor') continue;
      try { if (typeof value[key] === 'function') methods.add(key); } catch { /* native getter */ }
    }
  }
  return [...methods].sort();
}
const snapshot = value => JSON.parse(JSON.stringify(value));

export function createController({ session, core, selfInfo, mediaEnabled = false, invokeHost, hostRequest,
  probeHost = async () => ({ ready: false }), now = () => new Date().toISOString(), id = randomUUID,
  platform = process.platform, arch = process.arch, maxEvents = 256, ackTimeoutMs = 10000, closeCheckIntervalMs = 250, closeCheckTimeoutMs = 2000 } = {}) {
  let service = null, listenerId = null, stopped = false, loginTimer = null, activeInvite = null;
  let inviteFingerprint = null, acceptRequestId = null, host = null;
  let loginRequestId = id();
  let lastHostBootId = null;
  let loginInFlight = false;
  let concurrentInviteSeen = false;
  let pendingControl = null, closeCheck = null;
  let eventSeq = 0;
  const events = [], requests = new Map(), groups = new Map(), groupInvitations = new Map();
  const videoRequests = new Map();
  const nativeQueries = new Map();
  let videoSync = Promise.resolve(), videoSessionFingerprint = null;
  const GROUP_FRESHNESS_MS = 60000;
  const bootId = id();
  const state = { version: '0.1.0', bootId, startedAt: now(), platform, arch, mediaEnabled,
    listenerRegistered: false, serviceAvailable: false, serviceNull: null, serviceMethods: [],
    loginPosted: false, sdkInfoPosted: false, loginIdentityMode: null,
    sdkLogMessages: 0, lastSdkLogCommand: null, groupNotificationsRequested: false, lastError: null, call: null,
    group: { known: false, groupId: null, participants: [], reason: UNKNOWN } };

  function emit(type, data) {
    events.push({ seq: ++eventSeq, at: now(), type, ...snapshot(data) });
    while (events.length > maxEvents) events.shift();
  }
  function callEvent() {
    if (closeCheck && !matchesCloseCheck(closeCheck)) cancelCloseCheck();
    emit('call.state', { call: state.call });
    if (hostRequest && mediaEnabled) void syncVideoSession().catch(() => {});
  }
  function syncVideoSession() {
    if (typeof hostRequest !== 'function') throw new BridgeError('VIDEO_UNAVAILABLE', 'AV Host video transport is unavailable', 503);
    const call = state.call;
    const description = call?.phase === 'connected'
      ? { callId: call.id, selfUid: identity().selfUid, nativeSceneId: call.nativeSceneId, participants: [...new Set((call.participants ?? []).map(member => member.uid))] }
      : { callId: null, selfUid: identity().selfUid, participants: [] };
    const fingerprint = JSON.stringify(description);
    videoSync = videoSync.catch(() => {}).then(async () => {
      if (fingerprint === videoSessionFingerprint) return;
      await hostRequest('/v1/video/session', description); videoSessionFingerprint = fingerprint;
    });
    return videoSync;
  }
  function reconcileGroupLeave(group) {
    const call = state.call;
    if (!call || call.kind !== 'group' || call.phase !== 'ending' || group?.groupId !== call.groupId) return;
    const entry = requests.get(call.groupLeaveRequestId);
    if (entry?.receipt.operation !== 'group.leave' || entry.receipt.status !== 'confirmed' ||
        entry.receipt.nativeResult !== 0 || group.nativeTimeout || group.onlineCount !== group.memberUins.length ||
        !identity().selfId || group.memberUins.includes(identity().selfId)) return;
    // The Linux SDK can acknowledge Quit without emitting OnChatClose. Require
    // a newer, complete server membership observation as separate exit evidence.
    const before = entry.groupSequence;
    if (!/^\d+$/.test(before ?? '') || !/^\d+$/.test(group.seq) || BigInt(group.seq) <= BigInt(before) ||
        Date.parse(group.observedAt) < Date.parse(entry.receipt.submittedAt)) return;
    call.phase = 'ended'; call.endedAt = now(); call.endReason = null; call.acceptReady = false;
    call.nativeTeardownUnknown = false; call.nativeAckTimedOut = false;
    call.nativeEndEvent = 'group.membership.left';
    call.groupLeaveEvidence = { seq: group.seq, observedAt: group.observedAt, onlineCount: group.onlineCount };
    clearAckTimer(entry.receipt.requestId);
    activeInvite = null; acceptRequestId = null; pendingControl = null; callEvent();
  }
  function matchesCloseCheck(check) {
    return !stopped && closeCheck === check && check.generation === loginRequestId &&
      check.hostBootId === lastHostBootId && state.call?.id === check.callId &&
      state.call.phase === 'ending' && state.call.nativeCloseRequestId === check.closeRequestId;
  }
  function cancelCloseCheck() {
    if (closeCheck) clearTimeout(closeCheck.timer);
    closeCheck = null;
  }
  function startCloseCheck(entry) {
    const profile = profileById(host?.nativeProfile?.id);
    if (!profile?.roomIdleQuery || profile.platform !== platform || profile.arch !== arch || state.call?.phase !== 'ending') return;
    cancelCloseCheck();
    // Audited command 14 returns [0, '', uint64 roomId]. Empty room strings
    // denote an unavailable service, and cannot be interpreted as idle.
    const check = closeCheck = { callId: state.call.id, closeRequestId: entry.receipt.requestId,
      generation: loginRequestId, hostBootId: lastHostBootId, attempt: 0, timer: null, requestId: null };
    function retry(reason) {
      if (!matchesCloseCheck(check)) return;
      clearTimeout(check.timer); check.requestId = null;
      if (check.attempt >= 6) {
        state.call.nativeCloseCheck = { status: 'unknown', attempts: check.attempt, reason };
        state.call.nativeTeardownUnknown = true;
        state.call.nativeError = 'Native close was accepted, but local idle could not be confirmed: ' + reason;
        cancelCloseCheck(); callEvent(); return;
      }
      check.timer = setTimeout(poll, closeCheckIntervalMs); check.timer.unref?.();
    }
    function poll() {
      if (!matchesCloseCheck(check)) return;
      const requestId = check.requestId = `close-room:${id()}`;
      check.attempt++;
      check.timer = setTimeout(() => { if (check.requestId === requestId) retry('room query timed out'); }, closeCheckTimeoutMs);
      check.timer.unref?.();
      // Only the read-only query is repeated. Never repeat Close/Quit implicitly.
      Promise.resolve().then(() => {
        if (matchesCloseCheck(check) && check.requestId === requestId) return invokeHost(NATIVE.CHATTING_ROOM, [], requestId);
      }).then(result => {
        if (matchesCloseCheck(check) && check.requestId === requestId && (!result?.posted || !Number.isInteger(result.id))) retry('room query was not submitted');
      }, () => { if (matchesCloseCheck(check) && check.requestId === requestId) retry('room query transport failed'); });
    }
    check.accept = value => {
      if (!matchesCloseCheck(check)) return;
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== 0 || value[1] !== '' ||
          typeof value[2] !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value[2]) || BigInt(value[2]) > 18446744073709551615n) {
        retry('invalid or unavailable room query result'); return;
      }
      if (value[2] !== '0') { retry('native room remains active'); return; }
      const call = state.call;
      call.phase = 'ended'; call.endedAt = now(); call.endReason = null; call.acceptReady = false;
      call.nativeTeardownUnknown = false; call.nativeAckTimedOut = false;
      call.nativeEndEvent = 'native.roomIdle'; call.remoteEndedConfirmed = false;
      call.nativeCloseCheck = { status: 'idle', attempts: check.attempt, command: NATIVE.CHATTING_ROOM,
        requestId: check.requestId, closeRequestId: check.closeRequestId, roomId: '0', hostBootId: check.hostBootId };
      activeInvite = null; acceptRequestId = null; pendingControl = null;
      cancelCloseCheck(); callEvent();
    };
    state.call.nativeCloseCheck = { status: 'checking', attempts: 0 };
    callEvent(); poll();
  }
  function clearAckTimer(requestId) {
    const entry = requests.get(requestId);
    if (entry?.ackTimer) { clearTimeout(entry.ackTimer); entry.ackTimer = null; }
  }
  function cancelNativeQueries(code, message) {
    for (const query of nativeQueries.values()) {
      clearTimeout(query.timer); query.reject(new BridgeError(code, message, 503));
    }
    nativeQueries.clear();
  }
  function checkPrivateScreen(peerUid) {
    if (nativeQueries.size >= 32) throw new BridgeError('CAPACITY_REACHED', 'Too many pending native capability checks', 503);
    const requestId = `private-screen:${id()}`;
    return new Promise((resolve, reject) => {
      const fail = error => {
        const query = nativeQueries.get(requestId); if (!query) return;
        clearTimeout(query.timer); nativeQueries.delete(requestId); reject(error);
      };
      // Command 43 is a synchronous native capability read. Keep it below the
      // daemon's control HTTP deadline rather than leaving a late dial running.
      const timer = setTimeout(() => fail(new BridgeError('NATIVE_CHECK_TIMEOUT', 'Peer screen-share capability check timed out; no call was started', 504)), Math.min(ackTimeoutMs, 2500));
      nativeQueries.set(requestId, { resolve, reject, timer });
      Promise.resolve().then(() => invokeHost(NATIVE.CHECK_PRIVATE_SCREEN, [peerUid], requestId)).then(result => {
        if (!result?.posted || !Number.isInteger(result.id)) fail(new BridgeError('NATIVE_CHECK_FAILED', 'Peer screen-share check was not submitted; no call was started', 503));
      }, () => fail(new BridgeError('NATIVE_CHECK_FAILED', 'Peer screen-share check failed; no call was started', 503)));
    });
  }
  function watchAcknowledgement(requestId) {
    const entry = requests.get(requestId);
    if (!entry || entry.receipt.status !== 'submitted') return;
    entry.ackTimer = setTimeout(() => {
      entry.ackTimer = null;
      if (stopped || entry.receipt.status !== 'submitted') return;
      entry.receipt.status = 'unknown'; entry.receipt.errorCode = 'NATIVE_ACK_TIMEOUT';
      if (state.call?.id === entry.receipt.callId && pendingControl === requestId) {
        state.call.nativeAckTimedOut = true;
        state.call.nativeError = 'Native acknowledgement timed out; delivery and teardown remain unknown';
        callEvent();
      }
      emit('control.receipt', { receipt: entry.receipt });
    }, ackTimeoutMs);
    entry.ackTimer.unref?.();
  }
  function cap(status, reason, evidence = null) { return { status, reason, evidence }; }
  function identity() {
    const actual = core?.selfInfo ?? selfInfo;
    const uin = actual?.uin == null ? '' : String(actual.uin);
    return { selfId: /^[1-9]\d{4,15}$/.test(uin) ? uin : null,
      selfUid: typeof actual?.uid === 'string' && actual.uid ? actual.uid : null };
  }
  function capabilities() {
    const receiving = state.listenerRegistered && state.serviceNull !== true;
    const profile = profileById(host?.nativeProfile?.id);
    const exactProfile = Boolean(profile && profile.platform === platform && profile.arch === arch);
    let transport = cap('unavailable', 'Media mode is disabled; this is an observation-only installation.');
    if (mediaEnabled) {
      if (!['linux', 'win32', 'darwin'].includes(platform)) transport = cap('unavailable', 'No AVSDK Host implementation for this platform.');
      else if (platform !== 'linux' && !exactProfile) transport = cap('unavailable', 'An audited native library/build/architecture profile is required.');
      else if (!receiving || typeof service?.setActionFromAVSDK !== 'function') transport = cap('unavailable', 'QQ AVSDK listener or Kernel return transport is missing.');
      else if (!host?.ready || !host?.pluginFound || !host?.methods?.includes('postMessage')) transport = cap('unavailable', 'AVSDK Host is missing or native postMessage is not available.');
      else if (!state.loginPosted) transport = cap('unverified', 'AVSDK login has not been submitted.');
      else transport = cap('supported', 'Implemented native transport; this QQ build still requires a real-call check.', UPSTREAM);
    }
    const audioReady = platform === 'linux' || host?.audioRouting?.ready === true || host?.routeReady === true;
    const accept = transport.status === 'supported' && !audioReady
      ? cap('unavailable', 'Select and confirm separate native virtual microphone and speaker devices first.') : transport;
    const controlCapability = exactProfile ? cap(transport.status,
      transport.status === 'supported' ? 'Native control and GUI enum statically verified for this exact build; real-call validation still required.' : transport.reason,
      profile.platform === 'linux' ? 'bridge/qq/native-evidence.json' : `bridge/qq/${profile.platform === 'win32' ? 'windows' : 'macos'}/native-evidence.json`)
      : cap('unavailable', 'Requires an exact audited QQ library, build, platform and architecture.');
    const startCapability = controlCapability.status === 'supported' && !audioReady ? accept : controlCapability;
    return { protocolVersion: PROTOCOL_VERSION, provider: 'qq-napcat', bootId, platform, arch,
      ...identity(),
      mediaEnabled, nativeCommands: [NATIVE.LOGIN, NATIVE.ACCEPT, NATIVE.KERNEL, ...(exactProfile ? [NATIVE.START_CALL, NATIVE.CLOSE, NATIVE.REJECT, NATIVE.QUIT, NATIVE.ROOM_INFO, ...(profile.platform === 'linux' ? [NATIVE.SDK_INFO] : []), ...(profile.privateScreen ? [NATIVE.CHECK_PRIVATE_SCREEN] : []), ...(profile.roomIdleQuery ? [NATIVE.CHATTING_ROOM] : [])] : [])],
      capabilities: {
        'private.receive': cap(receiving ? 'supported' : 'unavailable', receiving ? 'QQ AVSDK listener registered.' : 'QQ AVSDK listener unavailable.'),
        'private.accept': accept,
        'private.reject': controlCapability, 'private.dial': startCapability,
        'private.screenDial': exactProfile && profile.privateScreen ? startCapability : cap('unavailable', 'Private screen-share invitations require an audited native profile.'),
        'private.hangup': controlCapability,
        'group.join': startCapability.status === 'supported' && !groups.size
          ? cap('unverified', 'Waiting for a native group activity notification before enabling join.') : startCapability,
        'group.start': startCapability,
        'private.participants': cap(exactProfile && profile.participants ? 'supported' : 'unavailable',
          'Version-pinned native UID observations. Completeness requires a valid room snapshot; no speaker attribution.'),
        'group.leave': controlCapability,
        'group.participants': exactProfile && profile.participants ? cap('supported', 'Native room UID observations; full roster only after a valid room snapshot. No speaker identity.') : cap('unavailable', 'Requires the audited native callback profile.'),
        'audio.duplex': cap(mediaEnabled ? 'unverified' : 'unavailable', 'Separate virtual audio bridge; successful room entry alone does not prove bidirectional audio.'),
      } };
  }
  async function probe() {
    if (mediaEnabled) {
      try { host = await probeHost(); } catch { host = null; }
      const observedBootId = typeof host?.bootId === 'string' && host.bootId.length > 0 ? host.bootId : null;
      if (observedBootId && observedBootId !== lastHostBootId) {
        const previous = lastHostBootId; lastHostBootId = observedBootId;
        if (previous) {
          cancelCloseCheck();
          cancelNativeQueries('HOST_RESTARTED', 'AV Host restarted during the capability check; no call was started');
          // A distinct native process proves the old local AVSDK was released.
          // It does not prove that the remote client has observed termination.
          state.loginPosted = false; state.sdkInfoPosted = false; state.loginIdentityMode = null;
          videoSessionFingerprint = null;
          loginRequestId = id(); loginInFlight = false;
          activeInvite = null; acceptRequestId = null; pendingControl = null; concurrentInviteSeen = false;
          for (const requestId of requests.keys()) clearAckTimer(requestId);
          if (state.call && state.call.phase !== 'ended') {
            state.call = { ...state.call, phase: 'ended', endedAt: now(), acceptReady: false,
              nativeTeardownUnknown: false, nativeAckTimedOut: false,
              nativeEndEvent: 'host.restarted', remoteEndedConfirmed: false };
            callEvent();
          }
          emit('host.restarted', { previousBootId: previous, bootId: observedBootId });
          scheduleLogin();
        }
      }
    }
    return capabilities();
  }
  function current() { return snapshot(state.call); }
  function groupState() { return { known: groups.size > 0, groups: snapshot([...groups.values()]),
    invitations: snapshot([...groupInvitations.values()]),
    current: state.call?.kind === 'group' ? current() : null,
    joinExistingIsAtomic: false, activityMaxAgeMs: GROUP_FRESHNESS_MS }; }
  function status() { return { ...snapshot(state), group: groupState(), ...identity(), eventSeq, host: host ? {
    ready: Boolean(host.ready), pluginFound: Boolean(host.pluginFound), methods: host.methods ?? [], nativeProfile: host.nativeProfile ?? null, audioRouting: host.audioRouting ?? null, routeReady: host.routeReady ?? null,
    bootId: host.bootId ?? null, nativeFailure: host.nativeFailure ?? null, error: host.error ?? null,
  } : null }; }
  function getEvents(after = 0, requestedBootId = null) {
    if (!Number.isSafeInteger(after) || after < 0) throw new BridgeError('INVALID_CURSOR', 'after must be a nonnegative integer');
    const reset = Boolean(requestedBootId && requestedBootId !== bootId);
    const effectiveAfter = reset ? 0 : after;
    return { bootId, events: snapshot(events.filter(e => e.seq > effectiveAfter)), nextSeq: eventSeq,
      reset, gap: !reset && events.length > 0 && effectiveAfter < events[0].seq - 1 };
  }
  function recordNative(name, args) {
    if (stopped) return;
    const lower = name.toLowerCase();
    emit('native.observation', { name, arguments: summarize(args) });
    if (lower === 'ongroupaudiomemnumchange') {
      const activity = decodeGroupActivity(args);
      if (activity) {
        const prior = groups.get(activity.groupId);
        // A replay cannot refresh our freshness gate; monotonic numeric sequences
        // may be compared without truncating their native uint64 string values.
        if (prior?.seq === activity.seq || (prior && /^\d+$/.test(prior.seq) && /^\d+$/.test(activity.seq) && BigInt(activity.seq) < BigInt(prior.seq))) return;
        const group = { ...activity, observedAt: now() };
        if (groups.size >= 2000 && !groups.has(group.groupId)) groups.delete(groups.keys().next().value);
        groups.set(group.groupId, group); emit('group.activity', { group });
        reconcileGroupLeave(group);
      }
      return;
    }
    if (lower === 'oninviteactiontoavsdk') {
      if (args[0]?.invite_type === 3) {
        // A group invitation is a notification about an existing room, not a
        // connected call or an incoming private call. Only explicit group.join
        // may claim the single active-call slot and initialize media.
        const relation = args[0]?.relation_id;
        const groupId = typeof relation === 'string' && /^[1-9]\d{4,15}$/.test(relation) ? relation : null;
        const invitation = { groupId, nativeInviteType: 3, observedAt: now(),
          inviterUid: typeof args[0]?.from_uid === 'string' && args[0].from_uid ? args[0].from_uid : null };
        if (groupId) {
          if (groupInvitations.size >= 20 && !groupInvitations.has(groupId)) groupInvitations.delete(groupInvitations.keys().next().value);
          groupInvitations.set(groupId, invitation);
        }
        emit('group.invitation', { invitation });
      } else {
      const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex');
      if (fingerprint !== inviteFingerprint || !state.call || state.call.phase === 'ended') {
        if (state.call && (!['ended', 'error'].includes(state.call.phase) || state.call.nativeTeardownUnknown)) {
          // The single-call bridge cannot displace a call to make room for another invite.
          emit('call.concurrentInvite', { callId: state.call.id, reason: 'A different call is already active; invitation not auto-accepted.' });
          concurrentInviteSeen = true;
          return;
        }
        inviteFingerprint = fingerprint; activeInvite = null; acceptRequestId = null; pendingControl = null;
        concurrentInviteSeen = false;
        state.call = { id: id(), kind: 'private', direction: 'incoming', phase: 'ringing',
          inviteAt: now(), callerUid: null, callerUin: null, callerName: null,
          nativeInviteType: typeof args[0]?.invite_type === 'number' ? args[0].invite_type : null,
          acceptReady: false, endedAt: null, endReason: null, participants: [],
          participantsKnown: false, participantsSource: 'none', nativeRoom: null };
        callEvent();
      }
      }
    } else if (lower === 'ons2cactiontoavsdk') {
      // This is a general Kernel notification, not a correlated call-close.
      // Normal connection/terminal notifications also carry destroyReason=0.
      // Let the SDK's lifecycle callbacks establish termination; never derive
      // it from an optional field on this uncorrelated metadata envelope.
      const payload = args[0], info = payload?.notifyInfo ?? payload;
      // Native listener order is (notifyInfo, actionType); GUI IPC wraps both.
      const actionType = Number.isInteger(args[1]) ? args[1] : payload?.actionType;
      emit('kernel.notification', {
        ...(Number.isInteger(actionType) ? { actionType } : {}),
        ...(Number.isInteger(info?.destroyReason) ? { destroyReason: info.destroyReason } : {}),
      });
    } else if (lower.includes('groupvideo')) {
      emit('group.observation', { known: false, reason: 'Undecoded native group event; no participant identity inferred.' });
    }
    if (!mediaEnabled) return;
    const transport = lower === 'oninviteactiontoavsdk' ? [args[1], args[2]] : lower === 'onactiontoavsdk' ? [args[0], args[1]] : null;
    if (transport && Number.isInteger(transport[0]) && typeof transport[1] === 'string') {
      // Never retry an uncertain native invocation. A retry may repeat a state-changing action.
      void invokeHost(NATIVE.KERNEL, transport, id()).catch(() => {
        state.lastError = 'Kernel forwarding failed; delivery may be unknown.';
        emit('bridge.error', { code: 'KERNEL_FORWARD_FAILED' });
      });
    }
  }
  async function resolveIdentity(uid, callId) {
    try {
      const result = await session?.getUixConvertService?.().getUin([uid]);
      const value = result?.uinInfo?.get?.(uid) ?? result?.uinInfo?.[uid];
      if (state.call?.id === callId && value != null && String(value) !== '0') {
        state.call.callerUin = String(value); state.call.peerUin = String(value);
        callEvent();
      }
    } catch { /* the trusted UID remains available; no guessed numeric identity */ }
  }
  async function nativeOutput(body) {
    if (!mediaEnabled) throw new BridgeError('MEDIA_DISABLED', 'Native media transport is disabled', 409);
    const { command, value, requestId } = body ?? {};
    if (!Number.isInteger(command)) throw new BridgeError('INVALID_OUTPUT', 'Missing native command');
    if (command === NATIVE.CHATTING_ROOM) {
      if (closeCheck && closeCheck.requestId === requestId && typeof requestId === 'string') closeCheck.accept(value);
    } else if (command === NATIVE.CHECK_PRIVATE_SCREEN) {
      const query = nativeQueries.get(requestId);
      if (!query) return;
      clearTimeout(query.timer); nativeQueries.delete(requestId);
      if (!Array.isArray(value) || value.length !== 2 || ![0, 1].includes(value[0]) || typeof value[1] !== 'string') {
        query.reject(new BridgeError('INVALID_OUTPUT', 'Unknown peer screen-share capability response', 502)); return;
      }
      // This one command reports a bool, not the usual ret=0 success convention.
      query.resolve(value[0] === 1);
    } else if (KERNEL_OUTPUTS.has(command)) {
      if (!Array.isArray(value) || !Number.isInteger(value[0]) || typeof value[1] !== 'string' || value[1].length > 1024 * 1024) throw new BridgeError('INVALID_OUTPUT', 'Invalid Kernel transport');
      if (typeof service?.setActionFromAVSDK !== 'function') throw new BridgeError('TRANSPORT_UNAVAILABLE', 'Kernel return transport is unavailable', 503);
      await service.setActionFromAVSDK(value[0], value[1]);
      emit('native.transport', { command, actionType: value[0], payloadBytes: Buffer.byteLength(value[1]) });
    } else if (command === NATIVE.INVITE) {
      // Native shape acceptance is necessary, never infer caller identity from chat history.
      buildAcceptParams(value, identity().selfUid);
      if (value[0] === 3) {
        // The SDK also reports group invites through ReceiveInvite. Retain the
        // verified UID as an observation without inventing a room association
        // or changing any private/group call already controlled by this bridge.
        emit('group.sdkInvitation', { nativeSceneId: 3, inviterUid: value[1] });
        return;
      }
      if (!state.call || state.call.direction !== 'incoming' || state.call.phase !== 'ringing') throw new BridgeError('STALE_INVITE', 'No pending matching Kernel invitation', 409);
      if (state.call.callerUid && state.call.callerUid !== value[1]) throw new BridgeError('CONCURRENT_INVITE', 'Another caller is active', 409);
      activeInvite = value;
      state.call.nativeSceneId = value[0];
      // SceneFriendShare=2 is a private MAV room, not a group or an upgraded DAV session.
      state.call.kind = [1, 2].includes(value[0]) ? 'private' : 'unknown';
      state.call.media = value[0] === 2 ? 'screen' : value[0] === 1 ? (value[3] === 2 ? 'video' : 'audio') : null;
      state.call.nativeRoom = { sceneId: value[0], relationId: value[4] };
      state.call.callerUid = value[1]; state.call.peerUid = value[1];
      state.call.peerIdentitySource = 'native-invite';
      state.call.acceptReady = value[0] === 1 || (value[0] === 2 && profileById(host?.nativeProfile?.id)?.privateScreen === true); callEvent();
      void resolveIdentity(value[1], state.call.id);
    } else if (command === NATIVE.ACCEPT) {
      if (!acceptRequestId || requestId !== acceptRequestId || !state.call || state.call.phase !== 'accepting') return;
      if (!Array.isArray(value) || !Number.isInteger(value[0])) throw new BridgeError('INVALID_OUTPUT', 'Unknown Accept result shape');
      const receipt = requests.get(requestId)?.receipt;
      clearAckTimer(requestId); state.call.nativeAckTimedOut = false;
      if (receipt) Object.assign(receipt, { status: value[0] === 0 ? 'confirmed' : 'failed', nativeResult: value[0] });
      state.call.phase = value[0] === 0 ? 'accepted' : 'ringing';
      pendingControl = null;
      if (value[0] !== 0) acceptRequestId = null;
      callEvent(); if (receipt) emit('control.receipt', { receipt });
    } else if (command === NATIVE.START_CALL) {
      const entry = requests.get(requestId);
      if (!entry || entry.nativeCommand !== command || pendingControl !== requestId || entry.receipt.callId !== state.call?.id) return;
      if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[0]) || typeof value[1] !== 'string') throw new BridgeError('INVALID_OUTPUT', 'Unknown StartCall result shape');
      clearAckTimer(requestId); state.call.nativeAckTimedOut = false;
      entry.receipt.status = value[0] === 0 ? 'confirmed' : 'failed'; entry.receipt.nativeResult = value[0];
      state.call.phase = value[0] === 0 ? (state.call.kind === 'group' ? 'joining' : 'calling') : 'error';
      state.call.nativeStartAcknowledged = value[0] === 0; pendingControl = null;
      callEvent(); emit('control.receipt', { receipt: entry.receipt });
    } else if (command === NATIVE.REJECT || command === NATIVE.CLOSE || command === NATIVE.QUIT) {
      const entry = requests.get(requestId);
      if (!entry || entry.nativeCommand !== command || pendingControl !== requestId || entry.receipt.callId !== state.call?.id) return;
      if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[0]) || typeof value[1] !== 'string') throw new BridgeError('INVALID_OUTPUT', 'Unknown control result shape');
      clearAckTimer(requestId); state.call.nativeAckTimedOut = false;
      entry.receipt.status = value[0] === 0 ? 'confirmed' : 'failed';
      entry.receipt.nativeResult = value[0];
      pendingControl = null;
      if (value[0] !== 0) state.call.phase = entry.previousPhase;
      // Native acceptance of Reject/Close is not proof of remote termination.
      // Keep rejecting/ending until a lifecycle callback or an audited local-idle query confirms it.
      callEvent(); emit('control.receipt', { receipt: entry.receipt });
      if (command === NATIVE.QUIT && value[0] === 0) reconcileGroupLeave(groups.get(state.call.groupId));
      if ([NATIVE.CLOSE, NATIVE.QUIT].includes(command) && value[0] === 0) startCloseCheck(entry);
    } else if (command === NATIVE.ENTER_ROOM) {
      if (!(state.call?.phase === 'accepted' && acceptRequestId) &&
          !(state.call?.phase === 'calling' && state.call.direction === 'outgoing') &&
          !(state.call?.phase === 'joining' && state.call.nativeStartAcknowledged)) return;
      if (!Array.isArray(value) || !Number.isInteger(value[0])) throw new BridgeError('INVALID_OUTPUT', 'Unknown room result shape');
      state.call.phase = value[0] === 0 ? 'connected' : 'error';
      // DAV may never emit a MAV room roster. Its connected peer is already
      // identified by the validated invite or the explicit UID/UIN dial target.
      // Seed once at connection, never reauthorize after a later leave/snapshot.
      if (value[0] === 0 && state.call.kind === 'private' && state.call.nativeSceneId === 1 &&
          ['native-invite', 'verified-dial'].includes(state.call.peerIdentitySource) &&
          state.call.peerUid && state.call.peerUid !== identity().selfUid &&
          !state.call.participants.some(member => member.uid === state.call.peerUid)) {
        state.call.participants.push({ uid: state.call.peerUid,
          ...(state.call.peerUin ? { uin: state.call.peerUin } : {}),
          identitySource: state.call.peerIdentitySource, membershipSource: 'direct-peer' });
        state.call.participantsKnown = false; state.call.participantsSource = 'direct-peer';
      }
      callEvent();
      if (value[0] === 0 && profileById(host?.nativeProfile?.id)?.participants && state.call.nativeRoom) {
        void invokeHost(NATIVE.ROOM_INFO, [state.call.nativeRoom.sceneId, state.call.nativeRoom.relationId], `room:${id()}`).catch(() => {
          emit('bridge.error', { code: 'ROOM_SNAPSHOT_UNAVAILABLE' });
        });
      }
    } else if (command === 20050 || command === 120043) {
      // Audited native methods: 20050=LogSend(string), 120043=AlertMessage(string).
      // These are diagnostics, never logout/reset events. Do not expose raw logs
      // (which can carry private data) or trigger Login from diagnostic output.
      state.lastSdkLogCommand = command;
      state.sdkLogMessages++;

    } else {
      const observation = decodeObservation(command, value, host?.nativeProfile?.id);
      const call = state.call;
      if (!observation || !call || concurrentInviteSeen || call.phase === 'ended') {
        emit('native.output', { command, shape: summarize(value) });
        return;
      }
      // These callbacks do not all carry a room ID. Only attach to one active call.
      if (observation.type === 'call.error' && call.nativeRoom &&
          call.nativeRoom.sceneId === observation.sceneId && call.nativeRoom.relationId === observation.relationId) {
        // Preserve only the decoded error field, never the surrounding native log
        // or transport envelope. OnError does not prove that teardown completed.
        call.phase = 'error'; call.nativeError = observation.message; call.nativeTeardownUnknown = true;
        call.nativeErrorAt = now(); pendingControl = null;
        emit('call.error', { callId: call.id, command, nativeError: observation.message }); callEvent();
      } else if (observation.type === 'call.connectTimeout' &&
          ['dialing', 'calling', 'joining', 'accepting', 'accepted'].includes(call.phase)) {
        call.phase = 'error'; call.nativeError = 'Native connection timed out'; call.nativeTeardownUnknown = true;
        call.nativeErrorAt = now(); pendingControl = null;
        emit('call.error', { callId: call.id, command, code: 'NATIVE_CONNECT_TIMEOUT' }); callEvent();
      } else if (['accepted', 'connected'].includes(call.phase) && observation.type === 'participant.join') {
        call.participants = call.participants.filter(p => p.uid !== observation.participant.uid);
        call.participants.push(observation.participant);
        if (call.participantsSource === 'none') call.participantsSource = 'observed';
        callEvent();
      } else if (['accepted', 'connected'].includes(call.phase) && observation.type === 'participant.leave') {
        call.participants = call.participants.filter(p => p.uid !== observation.uid);
        if (call.videoTracks) call.videoTracks = call.videoTracks.filter(track => track.uid !== observation.uid);
        callEvent();
      } else if (['accepted', 'connected'].includes(call.phase) && observation.type === 'room.snapshot') {
        const room = observation.nativeRoom;
        if (call.nativeRoom && (call.nativeRoom.sceneId !== room.sceneId || call.nativeRoom.relationId !== room.relationId)) {
          emit('native.unmatchedRoom', { callId: call.id }); return;
        }
        if (activeInvite && room.sceneId !== activeInvite[0]) return;
        call.nativeRoom = room; call.participants = observation.participants.map(member => ({
          ...call.participants.find(prior => prior.uid === member.uid), ...member }));
        call.participantsKnown = observation.complete; call.participantsSource = 'snapshot'; callEvent();
      } else if (call.phase === 'connected' && observation.type.startsWith('video.')) {
        // These callbacks describe only the one native room, never carry pixels.
        // Do not invent a member if a delayed callback refers to another room.
        if (observation.uid && !call.participants.some(member => member.uid === observation.uid)) return;
        if (observation.uid) {
          const tracks = call.videoTracks ??= [];
          let track = tracks.find(item => item.uid === observation.uid && item.sourceType === observation.sourceType);
          if (!track) { track = { uid: observation.uid, sourceType: observation.sourceType }; tracks.push(track); }
          Object.assign(track, observation, { observedAt: now() }); delete track.type;
        }
        emit(observation.type, { callId: call.id, ...observation }); callEvent();
      } else if ((observation.type === 'peer.cancel' && ['ringing', 'accepting', 'rejecting'].includes(call.phase)) ||
          (observation.type === 'peer.reject' && ['calling', 'dialing'].includes(call.phase)) ||
          (observation.type === 'chat.closed' && ['accepted', 'connected', 'ending', 'rejecting', 'calling', 'dialing', 'joining', 'error'].includes(call.phase)) ||
          (observation.type === 'room.destroy' && call.nativeRoom &&
            call.nativeRoom.sceneId === observation.sceneId && call.nativeRoom.relationId === observation.relationId)) {
        call.phase = 'ended'; call.endedAt = now(); call.endReason = observation.reason ?? null;
        call.nativeTeardownUnknown = false; call.nativeAckTimedOut = false;
        if (pendingControl) clearAckTimer(pendingControl);
        call.nativeEndEvent = observation.type;
        if (observation.errorCode !== undefined) call.nativeErrorCode = observation.errorCode;
        call.acceptReady = false; activeInvite = null; acceptRequestId = null; pendingControl = null; callEvent();
      } else emit('native.observation', { command, observation });
    }
  }
  async function resolvePeer(body) {
    const supplied = body.peerUid;
    if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 512)) throw new BridgeError('INVALID_TARGET', 'peerUid must be a UID or QQ number string');
    const requestedUin = body.peerUin ?? (/^\d+$/.test(supplied ?? '') ? supplied : null);
    const requestedUid = supplied && !/^\d+$/.test(supplied) ? supplied : null;
    if (requestedUin !== null && (typeof requestedUin !== 'string' || !/^[1-9]\d{4,15}$/.test(requestedUin))) throw new BridgeError('INVALID_TARGET', 'peerUin must be a QQ number string');
    if (!requestedUid && !requestedUin) throw new BridgeError('INVALID_TARGET', 'peerUid or peerUin is required');
    const conversion = session?.getUixConvertService?.();
    let uid = requestedUid, uin = requestedUin;
    try {
      if (uid) {
        const data = await conversion?.getUin?.([uid]);
        const actual = data?.uinInfo?.get?.(uid) ?? data?.uinInfo?.[uid];
        if (actual == null || !/^[1-9]\d{4,15}$/.test(String(actual))) throw new Error('unresolved');
        if (uin && uin !== String(actual)) throw new BridgeError('TARGET_MISMATCH', 'The supplied UID and QQ number refer to different users');
        uin = String(actual);
      } else {
        const data = await conversion?.getUid?.([uin]);
        uid = data?.uidInfo?.get?.(uin) ?? data?.uidInfo?.[uin];
        if (typeof uid !== 'string' || !uid) throw new Error('unresolved');
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('TARGET_UNRESOLVED', 'QQ cannot verify this target UID/UIN mapping', 503);
    }
    if (uid === identity().selfUid || uin === identity().selfId) throw new BridgeError('INVALID_TARGET', 'Calling the logged-in account itself is not supported');
    return { uid, uin };
  }
  async function control(operation, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestId)) {
      throw new BridgeError('INVALID_REQUEST', 'requestId must be a stable identifier (1–128 characters)');
    }
    const capability = operation.startsWith('group.') ? operation : `private.${operation}`;
    if (!['private.accept', 'private.reject', 'private.hangup', 'private.dial', 'group.join', 'group.start', 'group.leave'].includes(capability)) throw new BridgeError('CAPABILITY_UNAVAILABLE', UNKNOWN, 501, { capability });
    if (!['dial', 'group.join', 'group.start'].includes(operation) && typeof body.callId !== 'string') throw new BridgeError('INVALID_REQUEST', 'callId is required');
    const media = operation === 'dial' ? body.media ?? 'audio' : null;
    if (operation === 'dial' && !['audio', 'video', 'screen'].includes(media)) throw new BridgeError('INVALID_REQUEST', 'Private call media must be audio, video or screen');
    if (operation === 'group.start' && (!Array.isArray(body.inviteeIds) || body.inviteeIds.length < 1 ||
        body.inviteeIds.length > 20 || body.inviteeIds.some(value => typeof value !== 'string' || !/^[1-9]\d{4,15}$/.test(value)) ||
        new Set(body.inviteeIds).size !== body.inviteeIds.length)) {
      throw new BridgeError('INVALID_TARGET', 'inviteeIds must contain 1–20 distinct QQ account number strings');
    }
    const fingerprint = JSON.stringify([operation, body.callId ?? null, body.peerUid ?? null, body.peerUin ?? null, body.groupId ?? null,
      operation === 'group.start' ? body.inviteeIds : null, media]);
    const prior = requests.get(body.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'requestId was used for a different operation', 409);
      return snapshot(prior.receipt);
    }
    await probe();
    // An identical concurrent request may have completed while the host was probed.
    if (requests.has(body.requestId)) {
      const prior = requests.get(body.requestId);
      if (prior.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'requestId was used for a different operation', 409);
      return snapshot(prior.receipt);
    }
    const capabilityState = capabilities().capabilities[capability];
    if (capabilityState.status !== 'supported') throw new BridgeError('CAPABILITY_UNAVAILABLE', capabilityState.reason, 503, { capability });
    let nativeCommand, params;
    // A distinct explicit close may reconcile an uncertain open; this is never
    // an automatic retry of the original control. Keep its receipt unknown.
    const closingUnknown = pendingControl && requests.get(pendingControl)?.receipt.status === 'unknown';
    const needsCleanup = state.call?.nativeTeardownUnknown || state.call?.nativeAckTimedOut || closingUnknown;
    if (operation === 'dial') {
      if (!identity().selfId || !identity().selfUid) throw new BridgeError('IDENTITY_UNAVAILABLE', 'QQ logged-in identity is unavailable', 503);
      if (media === 'screen' && capabilities().capabilities['private.screenDial'].status !== 'supported') throw new BridgeError('CAPABILITY_UNAVAILABLE', 'Private screen-share invitations require an audited native profile', 503, { capability: 'private.screenDial' });
      const peer = await resolvePeer(body);
      const already = requests.get(body.requestId);
      if (already) {
        if (already.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'requestId was reused', 409);
        return snapshot(already.receipt);
      }
      if (state.call && (!['ended', 'error'].includes(state.call.phase) || state.call.nativeTeardownUnknown)) throw new BridgeError('CALL_STATE_CONFLICT', 'A call is already active or native teardown is unknown', 409);
      if (media === 'screen') {
        const checkedBootId = lastHostBootId;
        const supported = await checkPrivateScreen(peer.uid);
        // The read-only native check yields. Never replace an incoming call or
        // submit twice when a concurrent request has already reserved this slot.
        const prior = requests.get(body.requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'requestId was reused', 409);
          return snapshot(prior.receipt);
        }
        if (stopped || checkedBootId !== lastHostBootId || capabilities().capabilities['private.screenDial'].status !== 'supported') throw new BridgeError('NATIVE_CHECK_FAILED', 'Native session changed during the screen-share check; no call was started', 503);
        if (state.call && (!['ended', 'error'].includes(state.call.phase) || state.call.nativeTeardownUnknown)) throw new BridgeError('CALL_STATE_CONFLICT', 'A call became active during the screen-share check', 409);
        if (!supported) throw new BridgeError('PEER_SCREEN_UNSUPPORTED', 'QQ reports that this peer cannot join a private screen-share session', 409);
      }
      if (requests.size >= 10000) throw new BridgeError('CAPACITY_REACHED', 'Drain calls before restarting the bridge', 503);
      nativeCommand = NATIVE.START_CALL;
      const sceneId = media === 'screen' ? 2 : 1;
      params = buildPrivateDialParams({ selfUid: identity().selfUid, peerUid: peer.uid, peerUin: peer.uin, media });
      state.call = { id: id(), kind: 'private', media, direction: 'outgoing', phase: 'dialing',
        inviteAt: now(), callerUid: identity().selfUid, callerUin: identity().selfId, callerName: null,
        peerUid: peer.uid, peerUin: peer.uin, peerIdentitySource: 'verified-dial', nativeSceneId: sceneId, nativeInviteType: null,
        acceptReady: false, endedAt: null, endReason: null, participants: [], participantsKnown: false,
        participantsSource: 'none', nativeRoom: { sceneId, relationId: peer.uin } };
      activeInvite = null; acceptRequestId = null; inviteFingerprint = null; concurrentInviteSeen = false;
    } else if (operation === 'group.join' || operation === 'group.start') {
      if (!identity().selfId || !identity().selfUid) throw new BridgeError('IDENTITY_UNAVAILABLE', 'QQ logged-in identity is unavailable', 503);
      if (typeof body.groupId !== 'string' || !/^[1-9]\d{4,15}$/.test(body.groupId)) throw new BridgeError('INVALID_TARGET', 'groupId must be a QQ group number string');
      const invitees = operation === 'group.start' ? await Promise.all(body.inviteeIds.map(peerUin => resolvePeer({ peerUin }))) : [];
      // Identity resolution yields; a concurrent request may have already reserved a call.
      const already = requests.get(body.requestId);
      if (already) {
        if (already.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'requestId was reused', 409);
        return snapshot(already.receipt);
      }
      if (new Set(invitees.map(peer => peer.uid)).size !== invitees.length) throw new BridgeError('TARGET_MISMATCH', 'Invited accounts resolve to duplicate QQ identities');
      if (state.call && (!['ended', 'error'].includes(state.call.phase) || state.call.nativeTeardownUnknown)) throw new BridgeError('CALL_STATE_CONFLICT', 'A call is already active or native teardown is unknown', 409);
      const activity = groups.get(body.groupId);
      if (operation === 'group.join') {
        if (!activity || activity.nativeTimeout || activity.onlineCount <= 0) throw new BridgeError('GROUP_NOT_ACTIVE', 'QQ has not reported an active call for this group', 409);
        if (![0, 1, 2, 3].includes(activity.businessType)) throw new BridgeError('GROUP_TYPE_UNSUPPORTED', 'The reported group room type is unsupported', 409);
        const age = Date.parse(now()) - Date.parse(activity.observedAt);
        if (!Number.isFinite(age) || age < 0 || age > GROUP_FRESHNESS_MS) throw new BridgeError('STALE_GROUP_ACTIVITY', 'A fresh native group activity notification is required', 409);
      }
      if (requests.size >= 10000) throw new BridgeError('CAPACITY_REACHED', 'Drain calls before restarting the bridge', 503);
      nativeCommand = NATIVE.START_CALL;
      params = operation === 'group.start'
        ? buildGroupStartParams({ selfUid: identity().selfUid, groupId: body.groupId, inviteUids: invitees.map(peer => peer.uid) })
        : buildGroupJoinParams({ selfUid: identity().selfUid, groupId: body.groupId });
      state.call = { id: id(), kind: 'group', direction: 'outgoing', phase: 'joining', groupId: body.groupId,
        inviteAt: now(), callerUid: identity().selfUid, callerUin: identity().selfId, callerName: null,
        peerUid: null, peerUin: null, nativeSceneId: 3, nativeInviteType: null,
        acceptReady: false, endedAt: null, endReason: null, participants: [], participantsKnown: false,
        participantsSource: 'none', nativeRoom: { sceneId: 3, relationId: body.groupId },
        ...(operation === 'group.join' ? { joinBasis: { observedAt: activity.observedAt, seq: activity.seq, onlineCount: activity.onlineCount } }
          : { creationRequested: true, invitedAccounts: invitees.map(peer => ({ userId: peer.uin, uid: peer.uid })) }),
        joinExistingIsAtomic: false };
      activeInvite = null; acceptRequestId = null; inviteFingerprint = null; concurrentInviteSeen = false;
    } else if (operation === 'group.leave') {
      if (!state.call || state.call.id !== body.callId || state.call.kind !== 'group' ||
          !['connected', 'joining', ...(needsCleanup ? ['error', 'ending'] : [])].includes(state.call.phase) || (pendingControl && !closingUnknown)) throw new BridgeError('CALL_STATE_CONFLICT', 'The requested group call is not ready to leave', 409);
      nativeCommand = NATIVE.QUIT; params = [3, 0];
    } else {
      if (!state.call || state.call.id !== body.callId || state.call.kind !== 'private' || ![1, 2].includes(state.call.nativeSceneId)) throw new BridgeError('CALL_STATE_CONFLICT', 'The requested private call is unavailable', 409);
      if (state.call.nativeSceneId === 2 && !profileById(host?.nativeProfile?.id)?.privateScreen) throw new BridgeError('CAPABILITY_UNAVAILABLE', 'Private screen-share controls require an audited native profile', 503);
      const allowedPhases = operation === 'hangup' ? ['calling', 'accepted', 'connected', ...(closingUnknown ? ['dialing', 'accepting'] : []), ...(needsCleanup ? ['error', 'ending'] : [])] : ['ringing'];
      if (!allowedPhases.includes(state.call.phase) || (pendingControl && !(operation === 'hangup' && closingUnknown))) throw new BridgeError('CALL_STATE_CONFLICT', 'Another control is pending or the call is in the wrong phase', 409);
      if (operation !== 'hangup' && !activeInvite) throw new BridgeError('CALL_STATE_CONFLICT', 'Native invitation is not ready', 409);
      const sceneId = state.call.nativeSceneId;
      nativeCommand = operation === 'accept' ? NATIVE.ACCEPT : operation === 'reject' ? NATIVE.REJECT : sceneId === 2 ? NATIVE.QUIT : NATIVE.CLOSE;
      // GUI uses Quit for private MAV screen rooms and Close for ordinary DAV.
      params = operation === 'accept' ? buildAcceptParams(activeInvite, identity().selfUid) : operation === 'reject' ? [sceneId, activeInvite[1], 2] : sceneId === 2 ? [2, 0] : [1, state.call.peerUid ?? state.call.callerUid, 0];
    }
    if (requests.size >= 10000) throw new BridgeError('CAPACITY_REACHED', 'Drain calls before restarting the bridge', 503);
    const receipt = { requestId: body.requestId, callId: state.call.id, operation, status: 'submitted', submittedAt: now() };
    requests.set(body.requestId, { fingerprint, receipt, nativeCommand, previousPhase: state.call.phase,
      ...(operation === 'group.leave' ? { groupSequence: groups.get(state.call.groupId)?.seq ?? null } : {}) });
    if (operation === 'group.leave') state.call.groupLeaveRequestId = body.requestId;
    if ([NATIVE.CLOSE, NATIVE.QUIT].includes(nativeCommand)) {
      cancelCloseCheck(); state.call.nativeCloseRequestId = body.requestId;
    }
    // Never evict request IDs while the process is alive: a replay must not make a second call.
    if (operation === 'accept') acceptRequestId = body.requestId;
    if (needsCleanup && ['hangup', 'group.leave'].includes(operation)) state.call.nativeTeardownUnknown = true;
    pendingControl = body.requestId;
    state.call.phase = operation === 'dial' ? 'dialing' : ['group.join', 'group.start'].includes(operation) ? 'joining' : operation === 'accept' ? 'accepting' : operation === 'reject' ? 'rejecting' : 'ending'; callEvent();
    try {
      const result = await invokeHost(nativeCommand, params, body.requestId);
      if (!result?.posted || !Number.isInteger(result.id)) throw new Error('No positive submission receipt');
      watchAcknowledgement(body.requestId);
    } catch {
      if (receipt.status === 'submitted') receipt.status = 'unknown';
      // Keep the call reserved after uncertain delivery; callers must reconcile native events.
      state.lastError = 'Control submission result is unknown; not retried.';
    }
    emit('control.receipt', { receipt });
    return snapshot(receipt);
  }
  function scheduleLogin(delay = 100) {
    if (stopped || !mediaEnabled || !['linux', 'win32', 'darwin'].includes(platform)) return;
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => { void login().catch(() => {
      state.lastError = 'AVSDK login transport unavailable.';
      scheduleLogin(Math.min(delay * 2, 5000));
    }); }, delay);
    loginTimer.unref?.();
  }
  async function login() {
    if (stopped || !mediaEnabled || !['linux', 'win32', 'darwin'].includes(platform)) return;
    await probe();
    const profile = profileById(host?.nativeProfile?.id);
    if (platform !== 'linux' && (!profile || profile.platform !== platform || profile.arch !== arch)) throw new Error('Audited native profile unavailable');
    const { selfUid: uid, selfId: uin } = identity();
    // GUI uses the QQ user-data root, not the per-account subdirectory.
    // NapCat core.dataPath follows the actual (possibly isolated) native root.
    const dataPath = core?.dataPath;
    if (!uid || !uin || typeof dataPath !== 'string' || !dataPath) throw new Error('QQ identity or user-data root unavailable');
    if (loginInFlight) return;
    if (state.loginPosted) return;
    const generation = loginRequestId;
    loginInFlight = true;
    try {
      if (profile?.platform === 'linux' && !state.sdkInfoPosted) {
        // Official GUI default. SetSDKInfo has no native ACK; only submission
        // is recorded, and the stable request ID prevents duplicate invocation.
        const sdkInfo = await invokeHost(NATIVE.SDK_INFO, ['1.0.1230'], `sdk-info:${generation}`);
        if (generation !== loginRequestId) return;
        if (!sdkInfo?.posted) throw new Error('AVSDK SDKInfo not submitted');
        state.sdkInfoPosted = true;
      }
      // Empty selfAvTinyid selects UID login. Repeating UIN in this slot selects
      // the legacy AV identity branch and differs from QQ's current GUI.
      const result = await invokeHost(NATIVE.LOGIN, [uid, uin, '', dataPath, ''], `login:${generation}`);
      if (generation !== loginRequestId) return;
      if (!result?.posted) throw new Error('AVSDK login not submitted');
      state.loginPosted = true; state.loginIdentityMode = 'uid'; state.lastError = null; await probe();
    } finally { if (generation === loginRequestId) loginInFlight = false; }

  }
  function start({ loginAutomatically = true } = {}) {
    stopped = false;
    try {
      service = session?.getAVSDKService?.() ?? null;
      state.serviceAvailable = Boolean(service); state.serviceMethods = methodsOf(service);
      state.serviceNull = service?.isNull ? Boolean(service.isNull()) : null;
      if (typeof service?.addKernelAVSDKListener === 'function' && state.serviceNull !== true) {
        const listener = new Proxy({}, { get(_target, name) {
          if (typeof name !== 'string' || name === 'then') return undefined;
          return (...args) => recordNative(name, args);
        } });
        listenerId = service.addKernelAVSDKListener(listener);
        state.listenerRegistered = true;
        if (mediaEnabled && typeof service.allowAlbumNotify === 'function') {
          // Verified GUI subscription entry point; does not create/join a group call.
          Promise.resolve(service.allowAlbumNotify()).then(() => {
            if (!stopped) state.groupNotificationsRequested = true;
          }, () => { state.lastError = 'Group activity notification subscription failed.'; });
        }
      }
    } catch { state.lastError = 'QQ AVSDK service/listener initialization failed.'; }
    emit('bridge.started', { capabilities: capabilities() });
    if (loginAutomatically) scheduleLogin();
  }
  async function stop() {
    stopped = true; clearTimeout(loginTimer); cancelCloseCheck();
    cancelNativeQueries('BRIDGE_STOPPED', 'Bridge stopped during the capability check; no call was started');
    for (const requestId of requests.keys()) clearAckTimer(requestId);
    if (listenerId !== null) {
      try { service?.removeKernelAVSDKListener?.(listenerId); } catch { /* shutdown only */ }
    }
    listenerId = null; state.listenerRegistered = false; activeInvite = null;
    // Cleanup intentionally does not claim to hang up an active native call.
  }
  async function video(operation, body = {}) {
    if (!mediaEnabled || typeof hostRequest !== 'function') throw new BridgeError('VIDEO_UNAVAILABLE', 'AV Host video transport is unavailable', 503);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BridgeError(operation === 'write' ? 'INVALID_VIDEO' : 'INVALID_REQUEST', 'Expected a JSON object');
    if (!['session', 'state', 'sources', 'frame', 'subscribe', 'unsubscribe', 'send', 'stop', 'write'].includes(operation)) throw new BridgeError('NOT_FOUND', 'Unknown video operation', 404);
    const passive = ['state', 'sources', 'session'].includes(operation);
    const call = state.call;
    if (operation === 'sources' && (!call || call.phase !== 'connected' || (body.callId !== undefined && body.callId !== call.id))) throw new BridgeError('CALL_STATE_CONFLICT', 'Video sources require the current connected call', 409);
    const cleanup = ['unsubscribe', 'stop'].includes(operation) && call && body.callId === call.id && ['ending', 'ended', 'error'].includes(call.phase);
    if (!passive && !cleanup && (!call || call.phase !== 'connected' || body.callId !== call.id)) throw new BridgeError('CALL_STATE_CONFLICT', 'The requested call is not connected', 409);
    const payload = { callId: call?.phase === 'connected' ? call.id : null };
    if (operation === 'write') {
      if (!['camera', 'screen'].includes(body.kind) || body.encoding !== 'jpeg' ||
          !Number.isInteger(body.width) || body.width < 1 || body.width > 4096 ||
          !Number.isInteger(body.height) || body.height < 1 || body.height > 4096 || body.width * body.height > 2073600 ||
          !Number.isSafeInteger(body.sequence) || body.sequence < 0 || !Number.isFinite(body.timestamp) || body.timestamp < 0 ||
          typeof body.data !== 'string' || body.data.length < 8 || body.data.length > 349528 || body.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
        throw new BridgeError('INVALID_VIDEO', 'Expected a timestamped JPEG frame, valid dimensions, and at most 256 KiB of canonical base64 data');
      }
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 4 || bytes.length > 256 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9 || bytes.toString('base64') !== body.data) {
        throw new BridgeError('INVALID_VIDEO', 'Expected a JPEG frame of at most 256 KiB');
      }
      Object.assign(payload, { kind: body.kind, encoding: 'jpeg', width: body.width, height: body.height,
        sequence: body.sequence, timestamp: body.timestamp, data: body.data });
    }
    if (operation === 'subscribe') {
      if (typeof body.uid !== 'string' || !call.participants.some(member => member.uid === body.uid) || body.uid === identity().selfUid) throw new BridgeError('INVALID_TARGET', 'Video target must be a remote member of this call');
      if (!['camera', 'screen'].includes(body.kind)) throw new BridgeError('INVALID_REQUEST', 'Video kind must be camera or screen');
      payload.uid = body.uid; payload.kind = body.kind;
    }
    if (operation === 'frame' || operation === 'unsubscribe') {
      if (typeof body.trackId !== 'string' || !body.trackId || body.trackId.length > 512) throw new BridgeError('INVALID_REQUEST', 'trackId is required');
      payload.trackId = body.trackId;
    }
    if (operation === 'send' || operation === 'stop') {
      if (!['camera', 'screen'].includes(body.kind)) throw new BridgeError('INVALID_REQUEST', 'Video kind must be camera or screen');
      payload.kind = body.kind;
      if (operation === 'send') {
        if (typeof body.sourceId !== 'string' || !body.sourceId || body.sourceId.length > 2048) throw new BridgeError('INVALID_REQUEST', 'An explicit video sourceId is required');
        payload.sourceId = body.sourceId;
        if (body.framing !== undefined) {
          if (!['full', 'portrait-safe'].includes(body.framing) || body.kind !== 'camera' || body.sourceId !== 'external-frames') throw new BridgeError('INVALID_REQUEST', 'Framing only applies to supplied camera frames');
          payload.framing = body.framing;
        }
      }
    }
    const mutation = ['subscribe', 'unsubscribe', 'send', 'stop'].includes(operation);
    if (mutation && (typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestId))) throw new BridgeError('INVALID_REQUEST', 'requestId is required');
    const fingerprint = mutation ? JSON.stringify([operation, body.callId ?? null, payload]) : null;
    const previous = mutation ? videoRequests.get(body.requestId) : null;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'requestId was used for a different video operation', 409);
      return previous.promise;
    }
    if (mutation && videoRequests.size >= 10000) throw new BridgeError('CAPACITY_REACHED', 'Drain calls before restarting the bridge', 503);
    const execute = async () => {
      await syncVideoSession();
      if (cleanup) {
        if (state.call?.id !== call.id || state.call.phase === 'connected') throw new BridgeError('CALL_STATE_CONFLICT', 'Call changed while clearing video', 409);
        return hostRequest('/v1/video/state');
      }
      if ((!passive || operation === 'sources') && (state.call?.id !== call.id || state.call.phase !== 'connected')) throw new BridgeError('CALL_STATE_CONFLICT', 'Call ended while synchronizing video', 409);
      if (operation === 'subscribe' && !state.call.participants.some(member => member.uid === payload.uid)) throw new BridgeError('INVALID_TARGET', 'Video target left the call');
      if (operation === 'session' || operation === 'state') return hostRequest('/v1/video/state');
      if (operation === 'sources') return hostRequest(`/v1/video/sources?${new URLSearchParams({ callId: payload.callId })}`);
      if (operation === 'frame') return hostRequest(`/v1/video/frame?${new URLSearchParams({ callId: payload.callId, trackId: payload.trackId })}`);
      // Frames are transient. Host owns bounded sequence/backpressure state;
      // never retain JPEGs in the long-lived control idempotency ledger.
      if (operation === 'write') return hostRequest('/v1/video/write', payload);
      return hostRequest(`/v1/video/${operation}`, { ...payload, requestId: body.requestId });
    };
    const promise = execute();
    if (mutation) videoRequests.set(body.requestId, { fingerprint, promise });
    return promise;
  }
  return { start, stop, probe, capabilities, status, current, getEvents, nativeOutput, control,
    group: groupState, login, video };
}
