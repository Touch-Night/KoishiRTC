import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RtcError, validateAudio, validateVideoWrite } from '../core.js';
import { terminalStates, unavailableCapabilities } from '../types.js';
import type { AudioFrame, CallProvider, CallRequest, CallSnapshot, Diagnostic, PlaybackReceipt, ProviderEvent, VideoKind, VideoSendRequest, VideoState, VideoSubscribeRequest, VideoTrack, VideoWriteFrame, VideoWriteReceipt } from '../types.js';
import type * as LK from '@livekit/rtc-node';
type SDK = typeof LK;
export interface LiveKitConfig { id: string; url: string; apiKey: string; apiSecret: string; selfId: string; roomNames: string[]; maxQueueMs?: number }
export interface LiveKitDependencies { sdk?: () => Promise<SDK>; token?: (room: string) => Promise<string> }
interface VideoIn { publication: LK.RemoteTrackPublication; participant: LK.RemoteParticipant; state: VideoTrack; reader?: ReadableStreamDefaultReader<LK.VideoFrameEvent>; sequence: number; task?: Promise<void> }
interface VideoOut { source: LK.VideoSource; track: LK.LocalVideoTrack; publication: LK.LocalTrackPublication; width: number; height: number; framing: 'full' | 'portrait-safe'; sequence: number; closed: boolean; error?: string }
interface PendingAudio { frame: AudioFrame; receipt: PlaybackReceipt; epoch: number }
interface Active {
  snapshot: CallSnapshot; room: LK.Room; ready: boolean; closed: boolean; abort: AbortController; closeTask?: Promise<void>;
  source?: LK.AudioSource; track?: LK.LocalAudioTrack; audioIn: Map<string, ReadableStreamDefaultReader<LK.AudioFrame>>; audioSequences: Map<string, number>;
  audioQueue: PendingAudio[]; queuedBytes: number; audioEpoch: number; pumping?: Promise<void>; playbackIds: Set<string>;
  videoIn: Map<string, VideoIn>; videoOut: Map<VideoKind, VideoOut>; videoPending: Set<VideoKind>; lastError?: string;
}
const clone = <T>(x: T): T => structuredClone(x);
/** Native LiveKit room transport. No microphone, camera or desktop is implicitly captured. */
export class LiveKitProvider implements CallProvider {
  readonly events = new EventEmitter(); readonly id: string; readonly account: { platform: string; selfId: string };
  readonly audioFormat = { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le' } as const;
  private sdk?: SDK; private available = false; private lifecycle = new AbortController(); private active?: Active; private joining?: Promise<CallSnapshot>;
  private snapshots = new Map<string, CallSnapshot>(); private maxQueue: number; private rooms: Set<string>; private lastError?: string;
  constructor(private config: LiveKitConfig, private deps: LiveKitDependencies = {}) {
    const url = new URL(config.url);
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new RtcError('INVALID_CONFIG', 'LiveKit 使用 WSS；仅本机允许 WS');
    if (!/^[\w.-]{1,80}$/.test(config.id) || !config.selfId || config.selfId.length > 160 || !config.apiKey || !config.apiSecret || !Array.isArray(config.roomNames) || config.roomNames.some(n => !n || n.length > 256)) throw new RtcError('INVALID_CONFIG', 'LiveKit 需要 API 凭据、参与者身份和房间白名单');
    const ms = config.maxQueueMs ?? 2000; if (!Number.isFinite(ms) || ms < 20 || ms > 10000) throw new RtcError('INVALID_CONFIG', '音频队列须为 20–10000 毫秒');
    this.id = config.id; this.account = { platform: 'livekit', selfId: config.selfId }; this.maxQueue = Math.floor(ms * 192); this.rooms = new Set(config.roomNames);
  }
  private emit(e: ProviderEvent) { this.events.emit('event', e); }
  private safe(e: unknown) { return String(e instanceof Error ? e.message : e).replaceAll(this.config.apiSecret, '[redacted]').replaceAll(this.config.apiKey, '[redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]').slice(0, 500); }
  private notice(e: unknown) { this.lastError = this.safe(e); this.emit({ type: 'error', error: this.lastError }); }
  capabilities() {
    const caps = unavailableCapabilities('LiveKit 使用房间，不提供聊天平台私聊电话邀请');
    for (const key of ['joinGroup', 'leaveGroup', 'hangup', 'receiveAudio', 'sendAudio', 'receiveVideo', 'sendVideo', 'shareScreen', 'participants', 'speakerIdentity', 'mute'] as const) caps[key] = this.available && this.rooms.size ? { supported: true } : { supported: false, reason: 'LiveKit SDK 未就绪或未配置房间白名单' };
    return caps;
  }
  async start() {
    if (this.available) return; this.lifecycle = new AbortController();
    try {
      this.sdk = await (this.deps.sdk ?? (() => import('@livekit/rtc-node')))(); this.lifecycle.signal.throwIfAborted();
      const probe = new this.sdk.AudioSource(48000, 2, 40); await probe.close();
      await import('sharp'); this.lifecycle.signal.throwIfAborted(); this.available = true; this.emit({ type: 'availability' });
    } catch (e) { this.notice(e); throw new RtcError('LIVEKIT_DEPENDENCY', this.safe(e)); }
  }
  async stop() { this.available = false; this.lifecycle.abort(); if (this.active) await this.finish(this.active, 'ended'); await this.joining?.catch(() => {}); this.emit({ type: 'availability' }); }
  calls() { return [...this.snapshots.values()].map(clone); }
  async channels() { return [...this.rooms].map(id => ({ id, name: id, kind: 'group', guildName: 'LiveKit 房间' })); }
  private publish(a: Active) {
    a.snapshot.updatedAt = Date.now(); this.snapshots.set(a.snapshot.id, clone(a.snapshot)); this.emit({ type: 'call', call: clone(a.snapshot) });
    for (const old of [...this.snapshots.values()].filter(c => terminalStates.has(c.state)).slice(0, -100)) this.snapshots.delete(old.id);
  }
  private current(id: string, ready = true) { const a = this.active; if (!a || a.snapshot.id !== id || a.closed) throw new RtcError('CALL_ENDED', 'LiveKit 房间已断开'); if (ready && !a.ready) throw new RtcError('NOT_CONNECTED', 'LiveKit 尚未连接'); return a; }
  async dial(request: CallRequest, signal?: AbortSignal) {
    if (!this.available || !this.sdk) throw new RtcError('LIVEKIT_OFFLINE', 'LiveKit SDK 未就绪'); signal?.throwIfAborted();
    if (request.kind !== 'group' || request.groupMode === 'create') throw new RtcError('UNSUPPORTED', '请选择加入 LiveKit 房间');
    if (!this.rooms.has(request.targetId)) throw new RtcError('ROOM_NOT_ALLOWED', 'LiveKit 房间不在白名单');
    if (this.active || this.joining) throw new RtcError('ACCOUNT_BUSY', 'LiveKit 已在房间中');
    this.joining = this.join(request.targetId, AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20000)]));
    try { return await this.joining; } finally { this.joining = undefined; }
  }
  private async join(roomName: string, signal: AbortSignal) {
    const sdk = this.sdk!, now = Date.now(), a: Active = {
      snapshot: { id: `${this.id}:${randomUUID()}`, providerId: this.id, account: this.account, kind: 'group', targetId: roomName, direction: 'outgoing', state: 'connecting', createdAt: now, updatedAt: now, participants: [], muted: false },
      room: new sdk.Room(), ready: false, closed: false, abort: new AbortController(), audioIn: new Map(), audioSequences: new Map(), audioQueue: [], queuedBytes: 0, audioEpoch: 0, playbackIds: new Set(), videoIn: new Map(), videoOut: new Map(), videoPending: new Set(),
    };
    this.active = a; this.publish(a);
    const cancel = () => { void this.finish(a, 'failed', 'LiveKit 加入已取消').catch(e => this.notice(e)); }; signal.addEventListener('abort', cancel, { once: true });
    a.room.on(sdk.RoomEvent.Disconnected, () => { void this.finish(a, 'ended').catch(e => this.notice(e)); });
    // A reconnection invalidates media identity/subscription state; require a fresh explicit join.
    a.room.on(sdk.RoomEvent.Reconnecting, () => { void this.finish(a, 'failed', 'LiveKit 连接中断，请重新加入').catch(e => this.notice(e)); });
    a.room.on(sdk.RoomEvent.TrackPublished, (pub, person) => this.discover(a, pub, person));
    a.room.on(sdk.RoomEvent.TrackSubscribed, (track, pub, person) => this.subscribed(a, track, pub, person));
    a.room.on(sdk.RoomEvent.TrackUnsubscribed, (_track, pub) => this.removeTrack(a, pub.sid ?? ''));
    a.room.on(sdk.RoomEvent.TrackUnpublished, pub => { this.removeTrack(a, pub.sid ?? ''); a.videoIn.delete(pub.sid ?? ''); });
    a.room.on(sdk.RoomEvent.ParticipantConnected, () => this.participants(a));
    a.room.on(sdk.RoomEvent.ParticipantDisconnected, person => { for (const [id, entry] of a.videoIn) if (entry.participant.identity === person.identity) { this.removeTrack(a, id); a.videoIn.delete(id); } this.participants(a); });
    a.room.on(sdk.RoomEvent.ActiveSpeakersChanged, people => { const ids = new Set(people.map(p => p.identity)); for (const p of a.snapshot.participants) p.speaking = p.id !== null && ids.has(p.id); if (!a.closed) this.publish(a); });
    try {
      let token: string;
      if (this.deps.token) token = await this.deps.token(roomName);
      else { const { AccessToken } = await import('livekit-server-sdk'); const auth = new AccessToken(this.config.apiKey, this.config.apiSecret, { identity: this.account.selfId, ttl: '10m' }); auth.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: false }); token = await auth.toJwt(); }
      signal.throwIfAborted(); a.abort.signal.throwIfAborted();
      await a.room.connect(this.config.url, token, { autoSubscribe: false, dynacast: true });
      signal.throwIfAborted(); a.abort.signal.throwIfAborted();
      if (a.room.localParticipant?.identity !== this.account.selfId || a.room.name !== roomName) throw new RtcError('IDENTITY_MISMATCH', 'LiveKit 实际身份或房间与请求不一致');
      a.source = new sdk.AudioSource(48000, 2, 100); a.track = sdk.LocalAudioTrack.createAudioTrack('rtc-audio', a.source);
      const opts = new sdk.TrackPublishOptions(); opts.source = sdk.TrackSource.SOURCE_MICROPHONE;
      await a.room.localParticipant.publishTrack(a.track, opts); signal.throwIfAborted(); a.abort.signal.throwIfAborted();
      a.ready = true; a.snapshot.state = 'connected'; this.participants(a);
      for (const person of a.room.remoteParticipants.values()) for (const pub of person.trackPublications.values()) this.discover(a, pub, person);
      return clone(a.snapshot);
    } catch (e) { await this.finish(a, 'failed', this.safe(e)); await a.room.disconnect().catch(() => {}); throw new RtcError('LIVEKIT_JOIN_FAILED', this.safe(e)); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  private participants(a: Active) { if (a.closed) return; a.snapshot.participants = [...a.room.remoteParticipants.values()].map(p => ({ id: p.identity, name: p.name, identity: 'platform' as const })); this.publish(a); }
  private discover(a: Active, pub: LK.RemoteTrackPublication, person: LK.RemoteParticipant) {
    if (a.closed || !a.ready || !pub.sid || person.identity === this.account.selfId) return;
    if (pub.kind === this.sdk!.TrackKind.KIND_AUDIO) { pub.setSubscribed(true); if (pub.track) this.subscribed(a, pub.track as LK.RemoteTrack, pub, person); return; }
    const kind = pub.source === this.sdk!.TrackSource.SOURCE_CAMERA ? 'camera' : pub.source === this.sdk!.TrackSource.SOURCE_SCREENSHARE ? 'screen' : undefined;
    if (!kind || a.videoIn.has(pub.sid) || a.videoIn.size >= 64) return;
    a.videoIn.set(pub.sid, { publication: pub, participant: person, state: { trackId: pub.sid, participantId: person.identity, kind, available: true, subscribed: false, hasFrame: false }, sequence: -1 });
  }
  private subscribed(a: Active, track: LK.RemoteTrack, pub: LK.RemoteTrackPublication, person: LK.RemoteParticipant) {
    if (a.closed || !a.ready || !pub.sid) return;
    if (pub.kind === this.sdk!.TrackKind.KIND_AUDIO) {
      if (a.audioIn.has(pub.sid) || a.audioIn.size >= 64) return;
      const reader = new this.sdk!.AudioStream(track, { sampleRate: 48000, numChannels: 2, frameSizeMs: 20 }).getReader(); a.audioIn.set(pub.sid, reader);
      void (async () => {
        try { for (;;) { const next = await reader.read(); if (next.done || a.closed || a.audioIn.get(pub.sid!) !== reader) break; const sequence = (a.audioSequences.get(person.identity) ?? -1) + 1; a.audioSequences.set(person.identity, sequence); const f = next.value;
          this.emit({ type: 'audio', audio: { callId: a.snapshot.id, speakerId: person.identity, ...this.audioFormat, sequence, timestamp: Date.now(), data: Buffer.from(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength)) } });
        } } catch (e) { if (!a.closed) this.notice(e); } finally { if (a.audioIn.get(pub.sid!) === reader) a.audioIn.delete(pub.sid!); await reader.cancel().catch(() => {}); }
      })();
    } else {
      const input = a.videoIn.get(pub.sid); if (!input?.state.subscribed || input.reader) return;
      input.reader = new this.sdk!.VideoStream(track).getReader(); const reader = input.reader;
      input.task = (async () => {
        const { default: sharp } = await import('sharp');
        // Drain the SDK reader promptly. Conversion owns at most one frame and
        // one replaceable pending frame, so a slow JPEG encoder cannot retain
        // an unbounded queue of remote video buffers.
        let pending: LK.VideoFrameEvent | undefined, converting: Promise<void> | undefined;
        const valid = () => !a.closed && input.reader === reader && input.state.subscribed;
        const drain = async () => {
          try {
            while (valid() && pending) {
              const event = pending; pending = undefined;
              if (event.frame.width * event.frame.height > 16777216) throw new RtcError('INVALID_VIDEO', '远端视频尺寸过大');
              const rgba = event.frame.convert(this.sdk!.VideoBufferType.RGBA), angle = liveKitRotationDegrees(Number(event.rotation));
              const image = await sharp(Buffer.from(rgba.data), { raw: { width: rgba.width, height: rgba.height, channels: 4 }, limitInputPixels: 16777216 }).rotate(angle).resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 65 }).toBuffer({ resolveWithObject: true });
              if (!valid() || image.data.length > 256 * 1024) continue;
              const at = Date.now(); input.state.hasFrame = true; input.state.width = image.info.width; input.state.height = image.info.height; input.state.firstFrameAt ??= at; input.state.decodedFrameAt = at;
              this.emit({ type: 'video', video: { callId: a.snapshot.id, trackId: pub.sid!, participantId: person.identity, kind: input.state.kind, encoding: 'jpeg', width: image.info.width, height: image.info.height, sequence: ++input.sequence, timestamp: at, evidence: 'livekit-decoded-frame-and-jpeg-encode', data: image.data } });
            }
          } catch (e) { if (valid()) { a.lastError = this.safe(e); this.notice(e); } }
        };
        const kick = () => {
          if (!converting && pending && valid()) converting = drain().finally(() => { converting = undefined; if (pending && valid()) kick(); });
        };
        try {
          for (;;) {
            const next = await reader.read(); if (next.done || !valid()) break;
            pending = next.value; kick();
          }
        } catch (e) { if (!a.closed) { a.lastError = this.safe(e); this.notice(e); } }
        finally { pending = undefined; if (input.reader === reader) input.reader = undefined; await reader.cancel().catch(() => {}); await converting; }
      })();
    }
  }
  private removeTrack(a: Active, id: string) { const audio = a.audioIn.get(id); a.audioIn.delete(id); void audio?.cancel().catch(() => {}); const video = a.videoIn.get(id); if (video) { video.state.subscribed = false; video.state.hasFrame = false; const reader = video.reader; video.reader = undefined; void reader?.cancel().catch(() => {}); } }
  async accept(_id: string) { throw new RtcError('UNSUPPORTED', 'LiveKit 使用加入房间'); }
  async reject(_id: string) { throw new RtcError('UNSUPPORTED', 'LiveKit 没有私聊来电'); }
  async hangup(id: string) { await this.finish(this.current(id, false), 'ended'); }
  async setMuted(id: string, muted: boolean) { const a = this.current(id); a.snapshot.muted = muted; if (muted) await this.clearAudio(id); this.publish(a); }
  async writeAudio(frame: AudioFrame, playbackId: string): Promise<PlaybackReceipt> {
    validateAudio(frame); const a = this.current(frame.callId);
    if (frame.sampleRate !== 48000 || frame.channels !== 2) throw new RtcError('AUDIO_FORMAT', 'LiveKit 需要 48 kHz 双声道 PCM');
    if (a.snapshot.muted) throw new RtcError('MUTED', '发送已静音');
    if (a.playbackIds.has(playbackId)) throw new RtcError('DUPLICATE_PLAYBACK', '播放 ID 已使用');
    if (a.queuedBytes + frame.data.length > this.maxQueue) throw new RtcError('QUEUE_FULL', 'LiveKit 音频队列已满');
    const receipt: PlaybackReceipt = { id: playbackId, callId: frame.callId, acceptedBytes: frame.data.length, playedBytes: 0, dispatchedBytes: 0, state: 'queued', evidence: 'livekit-audio-source-submit' };
    a.playbackIds.add(playbackId); if (a.playbackIds.size > 4096) a.playbackIds.delete(a.playbackIds.values().next().value!);
    a.audioQueue.push({ frame: { ...frame, data: Buffer.from(frame.data) }, receipt, epoch: a.audioEpoch }); a.queuedBytes += frame.data.length;
    if (!a.pumping) a.pumping = this.pump(a).finally(() => { a.pumping = undefined; }); return clone(receipt);
  }
  private async pump(a: Active) {
    while (!a.closed && a.audioQueue.length) {
      const entry = a.audioQueue[0]!;
      try {
        for (let offset = 0; offset < entry.frame.data.length; offset += 3840) {
          if (a.closed || entry.epoch !== a.audioEpoch) break;
          const bytes = entry.frame.data.subarray(offset, offset + 3840), data = new Int16Array(bytes.length / 2), buffer = Buffer.from(bytes);
          for (let i = 0; i < data.length; i++) data[i] = buffer.readInt16LE(i * 2);
          await a.source!.captureFrame(new this.sdk!.AudioFrame(data, 48000, 2, data.length / 2));
          if (a.closed || entry.epoch !== a.audioEpoch) break;
          entry.receipt.dispatchedBytes! += bytes.length; a.queuedBytes -= bytes.length;
        }
        if (!a.closed && entry.epoch === a.audioEpoch) { a.audioQueue.shift(); entry.receipt.state = 'dispatched'; this.emit({ type: 'playback', playback: clone(entry.receipt) }); }
      } catch (e) { if (!a.closed && entry.epoch === a.audioEpoch) { this.notice(e); await this.finish(a, 'failed', this.safe(e)); } }
    }
  }
  async clearAudio(id: string) { if (this.snapshots.has(id) && terminalStates.has(this.snapshots.get(id)!.state)) return; const a = this.current(id, false); a.audioEpoch++; a.source?.clearQueue(); for (const e of a.audioQueue.splice(0)) { e.receipt.state = 'cancelled'; this.emit({ type: 'playback', playback: clone(e.receipt) }); } a.queuedBytes = 0; }
  async videoState(id: string): Promise<VideoState> { const a = this.current(id); return { callId: id, supported: true, tracks: [...a.videoIn.values()].map(v => clone(v.state)), sending: Object.fromEntries([...a.videoOut].map(([kind, v]) => [kind, { sourceId: 'external-frames', state: v.closed ? 'failed' : 'sending', error: v.error, framing: v.framing, evidence: 'livekit-track-published' }])), lastError: a.lastError }; }
  async videoSources(id: string) { this.current(id); return (['camera', 'screen'] as const).map(kind => ({ id: 'external-frames', name: '消费插件提供的视频帧', kind, sourceType: 'frames' as const, channels: ['camera', 'screen'] as VideoKind[] })); }
  async subscribeVideo(id: string, request: VideoSubscribeRequest) {
    const a = this.current(id), input = [...a.videoIn.values()].find(v => v.participant.identity === request.participantId && v.state.kind === request.kind);
    if (!input || !input.state.available) throw new RtcError('VIDEO_UNAVAILABLE', '该成员尚未发布此视频渠道');
    input.state.subscribed = true; input.publication.setSubscribed(true);
    if (input.publication.track) this.subscribed(a, input.publication.track as LK.RemoteTrack, input.publication, input.participant);
    return clone(input.state);
  }
  async unsubscribeVideo(id: string, trackId: string) { const a = this.current(id, false), input = a.videoIn.get(trackId); if (!input) return; input.publication.setSubscribed(false); this.removeTrack(a, trackId); }
  async sendVideo(id: string, request: VideoSendRequest) {
    const a = this.current(id), sdk = this.sdk!;
    if (!['camera', 'screen'].includes(request.kind) || request.sourceId !== 'external-frames' || request.framing && (!['full', 'portrait-safe'].includes(request.framing) || request.kind !== 'camera')) throw new RtcError('INVALID_SOURCE', 'LiveKit 只接受插件提供的帧；竖屏画幅仅适用于摄像头');
    const old = a.videoOut.get(request.kind), framing = request.framing ?? 'full'; if (old?.framing === framing && !old.closed) return this.videoState(id);
    if (a.videoPending.has(request.kind)) throw new RtcError('VIDEO_BUSY', '此视频渠道正在切换');
    a.videoPending.add(request.kind); let source: LK.VideoSource | undefined, track: LK.LocalVideoTrack | undefined, publication: LK.LocalTrackPublication | undefined;
    try {
      await this.stopVideo(id, request.kind); a.abort.signal.throwIfAborted(); const width = framing === 'portrait-safe' ? 360 : 640, height = framing === 'portrait-safe' ? 640 : 360;
      source = new sdk.VideoSource(width, height); track = sdk.LocalVideoTrack.createVideoTrack(`rtc-${request.kind}`, source);
      const options = new sdk.TrackPublishOptions(); options.source = request.kind === 'camera' ? sdk.TrackSource.SOURCE_CAMERA : sdk.TrackSource.SOURCE_SCREENSHARE;
      publication = await a.room.localParticipant!.publishTrack(track, options); a.abort.signal.throwIfAborted();
      a.videoOut.set(request.kind, { source, track, publication, width, height, framing, sequence: -1, closed: false }); return this.videoState(id);
    } catch (e) { if (publication?.sid && !a.closed) await a.room.localParticipant?.unpublishTrack(publication.sid).catch(() => {}); await track?.close().catch(() => {}); await source?.close().catch(() => {}); throw e; }
    finally { a.videoPending.delete(request.kind); }
  }
  async stopVideo(id: string, kind: VideoKind) {
    const a = this.current(id, false), out = a.videoOut.get(kind);
    if (out) {
      out.closed = true; let failure: unknown;
      try { if (out.publication.sid) await a.room.localParticipant?.unpublishTrack(out.publication.sid); } catch (e) { failure = e; }
      // Local producers always stop, even when remote unpublish is uncertain.
      // Preserve a failed entry so a later stop retries the server operation.
      const results = await Promise.allSettled([out.track.close(), out.source.close()]);
      const failed = results.find(r => r.status === 'rejected'); if (failed?.status === 'rejected') failure ??= failed.reason;
      if (failure) { out.error = this.safe(failure); throw new RtcError('VIDEO_STOP_UNKNOWN', out.error); }
      if (a.videoOut.get(kind) === out) a.videoOut.delete(kind);
    }
    return this.videoState(id);
  }
  async clearVideo(id: string) {
    if (this.snapshots.has(id) && terminalStates.has(this.snapshots.get(id)!.state)) return;
    const a = this.current(id, false);
    const results = await Promise.allSettled([
      ...[...a.videoIn.keys()].map(trackId => this.unsubscribeVideo(id, trackId)),
      ...[...a.videoOut.keys()].map(kind => this.stopVideo(id, kind)),
    ]);
    const failed = results.find(r => r.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  }
  async writeVideo(frame: VideoWriteFrame): Promise<VideoWriteReceipt> {
    validateVideoWrite(frame); const a = this.current(frame.callId), out = a.videoOut.get(frame.kind);
    if (!out || out.closed) throw new RtcError('VIDEO_NOT_SENDING', '视频渠道未开启');
    if (frame.sequence <= out.sequence) throw new RtcError('STALE_FRAME', '视频序号必须递增'); out.sequence = frame.sequence;
    const { default: sharp } = await import('sharp');
    const input = sharp(frame.data, { limitInputPixels: 2073600 }), meta = await input.metadata();
    if (meta.width !== frame.width || meta.height !== frame.height) throw new RtcError('INVALID_VIDEO', 'JPEG 实际尺寸与帧元数据不一致');
    const data = await input.resize(out.width, out.height, { fit: 'contain', background: '#000' }).ensureAlpha().raw().toBuffer();
    if (a.closed || out.closed || a.videoOut.get(frame.kind) !== out) throw new RtcError('CALL_ENDED', '视频渠道已经关闭');
    out.source.captureFrame(new this.sdk!.VideoFrame(data, out.width, out.height, this.sdk!.VideoBufferType.RGBA));
    return { callId: frame.callId, kind: frame.kind, sequence: frame.sequence, state: 'submitted', evidence: 'livekit-video-source-submit', acceptedBytes: frame.data.length };
  }
  private finish(a: Active, state: 'ended' | 'failed', error?: string): Promise<void> {
    if (a.closed) return a.closeTask ?? Promise.resolve();
    a.closed = true; a.ready = false; a.abort.abort(); a.audioEpoch++;
    for (const e of a.audioQueue.splice(0)) { e.receipt.state = 'cancelled'; this.emit({ type: 'playback', playback: clone(e.receipt) }); } a.queuedBytes = 0;
    a.source?.clearQueue();
    a.closeTask = (async () => {
      const pending: Promise<unknown>[] = [];
      for (const reader of a.audioIn.values()) pending.push(reader.cancel()); a.audioIn.clear();
      for (const entry of a.videoIn.values()) { entry.state.subscribed = false; if (entry.reader) pending.push(entry.reader.cancel()); entry.reader = undefined; }
      for (const out of a.videoOut.values()) { out.closed = true; pending.push(out.track.close(), out.source.close()); } a.videoOut.clear();
      pending.push(a.room.disconnect()); if (a.track) pending.push(a.track.close()); if (a.source) pending.push(a.source.close());
      const results = await Promise.allSettled(pending); const failed = results.find(r => r.status === 'rejected');
      a.snapshot.state = failed ? 'failed' : state; a.snapshot.error = error ?? (failed?.status === 'rejected' ? this.safe(failed.reason) : undefined);
      if (this.active === a) this.active = undefined; this.publish(a);
    })(); return a.closeTask;
  }
  async diagnostics(): Promise<Diagnostic[]> { return [
    { id: 'sdk', level: this.available ? 'ok' : 'error', message: this.available ? 'LiveKit 原生媒体 SDK 已加载；服务端凭据在入会时校验' : 'LiveKit SDK 未就绪' },
    { id: 'rooms', level: this.rooms.size ? 'ok' : 'warning', message: `允许加入 ${this.rooms.size} 个房间；不会自动入会` },
    { id: 'receipt', level: 'warning', message: '音视频回执表示已提交本地媒体源，不表示远端已收听或观看' },
    ...(this.lastError ? [{ id: 'last-error', level: 'error' as const, message: this.lastError }] : []),
  ]; }
}

/** LiveKit's protobuf rotation is an ordinal, not a degree value. */
export function liveKitRotationDegrees(rotation: number): number { return [0, 90, 180, 270][rotation] ?? 0; }
