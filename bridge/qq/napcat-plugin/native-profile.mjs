// SPDX-License-Identifier: GPL-3.0-only
// Exact official builds; Linux ARM64 and x64 native layouts audited separately.
// roomIdleQuery: GetChattingRoomId14 returns [0, empty, decimal uint64 string];
// ARM64 wrapper 0x4e1938 / service 0x692f88; x64 0x54e6f0 / 0x786ea0.
// Missing service returns empty room; scene0 returns "0". Only "0" proves local idle.
export const PROFILE = Object.freeze({ id: 'qq-linux-3.2.34-53644-arm64',
  qqVersion: '3.2.34-53644', arch: 'arm64', platform: 'linux', participants: true, privateScreen: true, roomIdleQuery: true, video: true,
  librarySHA256: '07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c' });
export const LINUX_X64_PROFILE = Object.freeze({ id: 'qq-linux-3.2.34-53644-x64',
  qqVersion: '3.2.34-53644', arch: 'x64', platform: 'linux', participants: true, privateScreen: true, roomIdleQuery: true, video: true,
  librarySHA256: 'c143c4e8ac94c20bcefb037e7062fbeccd0528bd746108d6bf1f0ae8e1710a8b' });
export const WINDOWS_PROFILE = Object.freeze({ id: 'qq-win32-9.9.36-53644-x64',
  qqVersion: '9.9.36-53644', arch: 'x64', platform: 'win32', participants: true, video: true, privateScreen: true, roomIdleQuery: true,
  librarySHA256: '199a6e8d2849908ce33ea21085be702b69ee6938a67191b3e0dbe753caab93ac' });
export const MAC_PROFILES = Object.freeze(['arm64', 'x64'].map(arch => Object.freeze({
  id: `qq-macos-7.0.2-53644-${arch}`, qqVersion: '7.0.2-53644', arch, platform: 'darwin', participants: true, video: true, privateScreen: true, roomIdleQuery: true,
  librarySHA256: '8dcddc9ade6120ba1fecb7f8961d401dded8c4881ce3e12b5a023465089c64c6' })));
export const PROFILES = Object.freeze([PROFILE, LINUX_X64_PROFILE, WINDOWS_PROFILE, ...MAC_PROFILES]);
export const profileById = id => PROFILES.find(profile => profile.id === id) ?? null;
const uid = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const int = Number.isInteger;

export function buildPrivateDialParams({ selfUid, peerUid, peerUin, media = 'audio' }) {
  if (!uid(selfUid) || !uid(peerUid) || selfUid === peerUid || !/^[1-9]\d{4,15}$/.test(peerUin)) {
    throw new Error('Verified local UID and target UID/UIN are required');
  }
  if (!['audio', 'video', 'screen'].includes(media)) throw new Error('Private call media must be audio, video or screen');
  // Recovered from both GUI getStartCallParams and the snake_case converter.
  // Unset optional GUI fields are omitted by JSON.stringify, not filled with invented values.
  // A new screen-share invitation uses Normal(0). Reason 3 is reserved for
  // replacing an existing DAV call, which this bridge does not do implicitly.
  return [JSON.stringify({ scene_id: media === 'screen' ? 2 : 1, self_uid: selfUid, invite_count: 1,
    invite_uids: [peerUid], sub_business_type: media === 'screen' ? 3 : media === 'video' ? 2 : 1, invite_reason: 0,
    relation_id: peerUin, invite_original: media === 'screen' ? 5 : 0, use_ntrtc_dsp: false,
    ntrtc_ai_denoise_update_model: '', c2c_extend_params: {}, opensdk_enter_room_params: {} })];
}

export function buildGroupJoinParams({ selfUid, groupId }) {
  if (!uid(selfUid) || !/^[1-9]\d{4,15}$/.test(groupId)) throw new Error('Local UID and QQ group number required');
  // GUI AudioCallService.onJoin supplies only self; filtering self produces no invitees.
  return [JSON.stringify({ scene_id: 3, self_uid: selfUid, invite_count: 0, invite_uids: [],
    sub_business_type: 1, invite_reason: 0, relation_id: groupId, invite_original: 3,
    use_ntrtc_dsp: false, ntrtc_ai_denoise_update_model: '', c2c_extend_params: {}, opensdk_enter_room_params: {} })];
}

export function buildGroupStartParams({ selfUid, groupId, inviteUids }) {
  if (!uid(selfUid) || !/^[1-9]\d{4,15}$/.test(groupId) || !Array.isArray(inviteUids) ||
      inviteUids.length < 1 || inviteUids.length > 20 || inviteUids.some(value => !uid(value) || value === selfUid) ||
      new Set(inviteUids).size !== inviteUids.length) throw new Error('Verified local UID, group number and distinct invited UIDs required');
  // GUI AudioCallService.onStart passes the explicitly selected userList through
  // the same GroupAV StartCall path; joining uses an empty list instead.
  const params = JSON.parse(buildGroupJoinParams({ selfUid, groupId })[0]);
  params.invite_count = inviteUids.length; params.invite_uids = inviteUids;
  return [JSON.stringify(params)];
}

export function decodeGroupActivity(args) {
  // The native N-API callback has argc=1, passing the object directly. GUI IPC
  // adds {notifyInfo}; that wrapper must not be confused with the native callback.
  if (!Array.isArray(args) || args.length !== 1) return null;
  const data = args[0];
  if (!data || typeof data !== 'object' || !/^[1-9]\d{4,15}$/.test(data.group_code) ||
      typeof data.group_code !== 'string' || !int(data.onlineCount) || data.onlineCount < 0 ||
      !int(data.expireTimestamp) || typeof data.seq !== 'string' || !int(data.businessType) ||
      typeof data.isNativeTimeout !== 'boolean' || !Array.isArray(data.memberUins) ||
      !data.memberUins.every(x => typeof x === 'string' && /^[1-9]\d{4,15}$/.test(x))) return null;
  return { groupId: data.group_code, onlineCount: data.onlineCount,
    memberUins: data.memberUins.slice(0, 2000), businessType: data.businessType,
    // GUI treats 0 as the audio fallback. Video=2 and screen share=3 are distinct.
    isAudio: data.businessType === 0 || data.businessType === 1,
    nativeTimeout: data.isNativeTimeout, seq: data.seq, expireTimestampRaw: data.expireTimestamp };
}

export function decodeObservation(command, value, profileId) {
  const profile = profileById(profileId);
  if (!profile || !Array.isArray(value)) return null;
  // These diagnostics were independently disassembled for both exact Linux builds.
  const linuxDiagnostics = profile.id === PROFILE.id || profile.id === LINUX_X64_PROFILE.id;
  if (linuxDiagnostics && command === 20003 && value.length === 3 &&
      int(value[0]) && typeof value[1] === 'string' && /^\d{1,20}$/.test(value[1]) &&
      typeof value[2] === 'string' && value[2].length <= 1024) {
    return { type: 'call.error', sceneId: value[0], relationId: value[1], message: value[2] };
  }
  if (linuxDiagnostics && command === 20005 && value.length === 0) return { type: 'call.connectTimeout' };
  if ([20008, 20009, 20010].includes(command) && !profile.participants) return null;
  // See desktop-video-evidence.json for separately audited Windows/macOS slices.
  const videoAudited = profile.video === true;
  if (videoAudited && [20025, 20033].includes(command) && value.length === 2 && uid(value[0]) && [0, 1].includes(value[1])) {
    return { type: 'video.availability', uid: value[0], kind: command === 20025 ? 'camera' : 'screen',
      sourceType: command === 20025 ? 1 : 2, available: value[1] === 1 };
  }
  if (videoAudited && [20031, 20049].includes(command) && value.length === 4 && uid(value[0]) &&
      [1, 2, 3].includes(value[1]) && value.slice(2).every(size => int(size) && size > 0 && size <= 16384)) {
    return { type: command === 20031 ? 'video.firstFrame' : 'video.sizeChanged', uid: value[0], sourceType: value[1], width: value[2], height: value[3] };
  }
  if (videoAudited && [20028, 20066].includes(command) && value.length === 1 && int(value[0])) {
    return { type: command === 20028 ? 'video.subscribeResult' : 'video.unsubscribeResult', nativeResult: value[0] };
  }
  if (command === 20008 && value.length === 7 && uid(value[0]) && int(value[1])) {
    return { type: 'participant.join', participant: { uid: value[0], accountType: value[1],
      ...([0, 1].includes(value[2]) ? { isRoomCreator: value[2] === 1 } : {}),
      ...(int(value[4]) && value[4] >= 0 && value[4] <= 65535 ? { terminalType: value[4] } : {}) } };
  }
  if (command === 20009 && value.length === 9 && int(value[0]) && uid(value[1]) && int(value[2])) {
    return { type: 'participant.leave', uid: value[1], reason: value[0] };
  }
  if (command === 20010 && value.length === 2 && value[1] === 0 && typeof value[0] === 'string' && value[0]) {
    let room;
    try { room = JSON.parse(value[0]); } catch { return null; }
    if (!room || !int(room.scene_id) || !uid(room.relation_id) || !int(room.user_num) || room.user_num < 0 ||
        !Array.isArray(room.user_list) || room.user_list.length > 2000 ||
        !room.user_list.every(p => p && uid(p.uid) && int(p.account_type))) return null;
    const participants = room.user_list.map(p => ({ uid: p.uid, accountType: p.account_type }));
    if (new Set(participants.map(p => p.uid)).size !== participants.length) return null;
    return { type: 'room.snapshot', nativeRoom: { sceneId: room.scene_id, relationId: room.relation_id },
      participants, complete: room.user_num === participants.length, reportedCount: room.user_num };
  }
  if (command === 20011 && value.length === 3 && int(value[0]) && uid(value[1]) && uid(value[2])) {
    return { type: 'room.destroy', sceneId: value[0], relationId: value[1] };
  }
  if (command === 20018 && value.length === 1 && int(value[0])) return { type: 'peer.reject', reason: value[0] };
  if (command === 20019 && value.length === 0) return { type: 'peer.cancel' };
  if (command === 20022 && value.length === 6 && int(value[0]) && int(value[1]) && [0, 1].includes(value[2])) {
    return { type: 'chat.closed', reason: value[0], errorCode: value[1], userEventExited: value[2] === 1 };
  }
  return null;
}
