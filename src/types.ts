import type { EventEmitter } from 'node:events';

export type CallKind = 'direct' | 'group';
export type CallState = 'ringing' | 'dialing' | 'connecting' | 'connected' | 'ending' | 'ended' | 'failed';
export type Capability = 'dial' | 'dialScreen' | 'accept' | 'reject' | 'hangup' | 'joinGroup' | 'startGroup' | 'leaveGroup' | 'receiveAudio' | 'sendAudio' | 'receiveVideo' | 'sendVideo' | 'shareScreen' | 'participants' | 'speakerIdentity' | 'mute';
export interface CapabilityStatus { supported: boolean; reason?: string }
export type Capabilities = Record<Capability, CapabilityStatus>;
export interface Account { platform: string; selfId: string }
export interface Participant { id: string | null; name?: string; speaking?: boolean; identity: 'platform' | 'unknown' }
export interface MediaTransition {
  kind: 'screen'; status: 'preparing' | 'closing' | 'negotiating' | 'connecting' | 'restoring' | 'completed' | 'failed' | 'cancelled';
  startedAt: number; interruption: true; requestId?: string; finishedAt?: number; error?: string; errorCode?: string;
  /** Explicit native evidence that voice survived a failed/cancelled handover. Never inferred merely from connected. */
  audioReady?: boolean;
}
export interface CallSnapshot {
  id: string; providerId: string; account: Account; kind: CallKind; targetId: string;
  direction: 'incoming' | 'outgoing'; state: CallState; createdAt: number; updatedAt: number;
  participants: Participant[]; muted: boolean; owner?: string; error?: string; mediaTransition?: MediaTransition;
}
export interface AudioFormat { sampleRate: number; channels: 1 | 2; encoding: 'pcm_s16le' }
export interface AudioFrame extends AudioFormat { callId: string; sequence: number; timestamp: number; data: Uint8Array; speakerId?: string }
export type VideoKind = 'camera' | 'screen';
export type VideoFraming = 'full' | 'portrait-safe';
export interface VideoFrame {
  callId: string; trackId: string; participantId: string; kind: VideoKind;
  encoding: 'jpeg'; width: number; height: number; sequence: number; timestamp: number;
  evidence: 'native-first-frame-and-render-capture' | 'native-decoded-size-change-and-render-capture' | 'ntgcalls-decoded-frame-and-jpeg-encode' | 'livekit-decoded-frame-and-jpeg-encode'; data: Uint8Array;
}
export interface VideoTrack {
  trackId: string; participantId: string; kind: VideoKind; available: boolean | null;
  subscribed: boolean; hasFrame: boolean; width?: number; height?: number; firstFrameAt?: number | null; decodedFrameAt?: number | null;
}
export interface VideoSource { id: string; name: string; kind: VideoKind; sourceType?: 'device' | 'window' | 'display' | 'frames' | 'generated'; channels?: VideoKind[] }
export interface VideoWriteFrame { callId: string; kind: VideoKind; encoding: 'jpeg'; width: number; height: number; sequence: number; timestamp: number; data: Uint8Array }
export interface VideoWriteReceipt { callId: string; kind: VideoKind; sequence: number; state: 'accepted' | 'rendered' | 'submitted' | 'dropped' | 'failed'; evidence: string; acceptedBytes?: number; error?: string }
export interface VideoSending { sourceId: string; state: 'starting' | 'sending' | 'stopping' | 'failed'; framing?: VideoFraming; error?: string; evidence?: string }
export interface VideoState { callId: string | null; supported: boolean; tracks: VideoTrack[]; sending: Partial<Record<VideoKind, VideoSending>>; lastError?: string }
export interface VideoSubscribeRequest { participantId: string; kind: VideoKind }
export interface VideoSendRequest { kind: VideoKind; sourceId: string; framing?: VideoFraming }
export interface VideoSendFailure {
  requestId: string; callId: string; kind: VideoKind; sourceId: string; outcome: 'unchanged' | 'stopped';
}
/** Copy only evidence for this exact send. Transports must additionally supply the wire requestId. */
export function readVideoSendFailure(value: unknown, expected: { requestId?: string; callId: string; kind: VideoKind; sourceId: string }): VideoSendFailure | undefined {
  const proof = value as Partial<VideoSendFailure> | undefined;
  if (!proof || typeof proof.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(proof.requestId) ||
    expected.requestId !== undefined && proof.requestId !== expected.requestId || typeof proof.callId !== 'string' || !proof.callId || proof.callId.length > 1024 || proof.callId !== expected.callId ||
    !['camera', 'screen'].includes(proof.kind ?? '') || proof.kind !== expected.kind || typeof proof.sourceId !== 'string' || !proof.sourceId || proof.sourceId.length > 2048 || proof.sourceId !== expected.sourceId ||
    !['unchanged', 'stopped'].includes(proof.outcome ?? '')) return;
  return { requestId: proof.requestId, callId: proof.callId, kind: proof.kind, sourceId: proof.sourceId, outcome: proof.outcome as VideoSendFailure['outcome'] };
}
export interface PlaybackReceipt { id: string; callId: string; acceptedBytes: number; playedBytes: number; state: 'queued' | 'playing' | 'played' | 'dispatched' | 'cancelled' | 'failed'; error?: string; dispatchedBytes?: number; evidence?: string }
export interface CallRequest {
  kind: CallKind; targetId: string; media?: 'audio' | 'video' | 'screen'; guildId?: string; groupMode?: 'join' | 'create'; inviteeIds?: string[];
  /** Explicit one-shot sources started by RtcManager after connection, while this controller still owns the call. No default device selection. */
  initialVideo?: VideoSendRequest[];
}
export interface ProviderEvent { type: 'call' | 'audio' | 'video' | 'playback' | 'availability' | 'error'; call?: CallSnapshot; audio?: AudioFrame; video?: VideoFrame; playback?: PlaybackReceipt; error?: string }
export interface CallProvider {
  readonly id: string; readonly account: Account; readonly events: EventEmitter;
  readonly audioFormat?: AudioFormat;
  capabilities(): Capabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  calls(): CallSnapshot[];
  dial(request: CallRequest, signal?: AbortSignal): Promise<CallSnapshot>;
  accept(callId: string, signal?: AbortSignal): Promise<void>;
  reject(callId: string, signal?: AbortSignal): Promise<void>;
  hangup(callId: string, signal?: AbortSignal): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  writeAudio(frame: AudioFrame, playbackId: string): Promise<PlaybackReceipt>;
  clearAudio(callId: string): Promise<void>;
  /** Read-only pre-call source discovery; must not open a device or capture a frame. */
  availableVideoSources?(): Promise<VideoSource[]>;
  /** Cancel only an unfinished media handover. Must be idempotent and bypass a pending sendVideo operation. */
  cancelVideoTransition?(callId: string): Promise<void>;
  videoState?(callId: string): Promise<VideoState>;
  videoSources?(callId: string): Promise<VideoSource[]>;
  subscribeVideo?(callId: string, request: VideoSubscribeRequest): Promise<VideoTrack>;
  unsubscribeVideo?(callId: string, trackId: string): Promise<void>;
  sendVideo?(callId: string, request: VideoSendRequest): Promise<VideoState>;
  stopVideo?(callId: string, kind: VideoKind): Promise<VideoState>;
  clearVideo?(callId: string): Promise<void>;
  writeVideo?(frame: VideoWriteFrame): Promise<VideoWriteReceipt>;
  diagnostics(): Promise<Diagnostic[]>;
}
export interface Diagnostic { id: string; level: 'ok' | 'warning' | 'error'; message: string; detail?: string }
export interface DeviceInfo { id: string; name: string; direction: 'input' | 'output'; channels?: number; sampleRate?: number; backend?: string }
export const terminalStates = new Set<CallState>(['ended', 'failed']);
export function mediaTransitionBlocksAudio(call?: Pick<CallSnapshot, 'state' | 'mediaTransition'>): boolean {
  const transition = call?.mediaTransition;
  return !!transition && transition.status !== 'completed' && !(call?.state === 'connected' && ['failed', 'cancelled'].includes(transition.status) && transition.audioReady === true);
}
export function unavailableCapabilities(reason = '后端未提供此能力'): Capabilities {
  return Object.fromEntries(['dial', 'dialScreen', 'accept', 'reject', 'hangup', 'joinGroup', 'startGroup', 'leaveGroup', 'receiveAudio', 'sendAudio', 'receiveVideo', 'sendVideo', 'shareScreen', 'participants', 'speakerIdentity', 'mute'].map(key => [key, { supported: false, reason }])) as Capabilities;
}
