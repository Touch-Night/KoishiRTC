import { randomUUID } from 'node:crypto';
import { RtcError, type RtcController, type RtcManager } from './core.js';
import type { CallProvider, CallSnapshot, PlaybackReceipt } from './types.js';

/** Observe this test's receipts, including events arriving before write returns. */
export async function playTestTone(manager: RtcManager, controller: RtcController, callId: string,
  format: NonNullable<CallProvider['audioFormat']>, checkSession: () => void, timeoutMs = 12000, signal?: AbortSignal) {
  const durationMs = 400, samples = Math.round(format.sampleRate * durationMs / 1000), id = randomUUID();
  let done = false, timer: ReturnType<typeof setTimeout> | undefined;
  let interruption: RtcError | undefined;
  let finish!: (state: 'played' | 'dispatched' | 'unconfirmed' | Error) => void;
  const result = new Promise<'played' | 'dispatched' | 'unconfirmed' | Error>(resolve => {
    finish = value => { if (!done) { done = true; resolve(value); } };
  });
  const onReceipt = (receipt: PlaybackReceipt) => {
    if (receipt.callId !== callId || receipt.id !== id || done) return;
    if (receipt.state === 'failed' || receipt.state === 'cancelled') {
      finish(new RtcError('PLAYBACK_FAILED', receipt.error || (receipt.state === 'cancelled' ? '测试音被停止或静音。' : '测试音输出失败。'))); return;
    }
    // A delayed queued reply must not replace a newer completion event.
    if (receipt.state === 'played' || receipt.state === 'dispatched') finish(receipt.state);
  };
  const interrupt = (error: RtcError) => { interruption ??= error; finish(interruption); };
  const onCall = (call: CallSnapshot) => {
    if (call.id === callId && (call.state !== 'connected' || call.owner !== controller.owner)) interrupt(new RtcError('PLAYBACK_CANCELLED', '通话已结束或控制权已释放，测试音已中止。'));
  };
  const onAbort = () => interrupt(new RtcError('PLAYBACK_CANCELLED', '测试音已停止。'));
  const checkActive = () => {
    if (signal?.aborted) onAbort();
    if (interruption) throw interruption;
    checkSession(); controller.assertControl(callId); onCall(manager.getCall(callId));
    if (interruption) throw interruption;
  };
  manager.on('playback', onReceipt); manager.on('call', onCall);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    checkActive();
    const data = Buffer.alloc(samples * format.channels * 2);
    for (let i = 0; i < samples; i++) {
      const envelope = Math.min(1, i / (format.sampleRate * .015), (samples - i) / (format.sampleRate * .015));
      const value = Math.round(Math.sin(i * 2 * Math.PI * 440 / format.sampleRate) * 2500 * envelope);
      for (let channel = 0; channel < format.channels; channel++) data.writeInt16LE(value, (i * format.channels + channel) * 2);
    }
    // Submit the whole cue once: serial RPC delays between 20ms pieces can make
    // the device drain mid-tone. Providers frame this buffer for their transport.
    const receipt = await controller.writeAudio(callId, { ...format, data, sequence: 0, timestamp: Date.now() }, id);
    // A played event can arrive before write returns; a later stop/release must
    // still win while this operation is awaiting that return.
    checkActive(); onReceipt(receipt);
    if (!done) timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
    const state = await result; checkActive();
    if (state instanceof Error) throw state;
    return { state, queuedMs: durationMs, message: state === 'played' ? '测试音已在本机音频设备播放完成；请以对端实际听到为准。'
      : state === 'dispatched' ? '测试音已发送到平台音频通道；平台不提供对端播放确认。'
      : '测试音已提交，但尚未收到播放完成确认。请查看音频诊断和输出路由。' };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); manager.off('playback', onReceipt); manager.off('call', onCall); }
}
