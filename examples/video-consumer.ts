import type { Context } from 'koishi';
import type {} from 'koishi-plugin-rtc-bridge';
import type {
  CallSnapshot, VideoFrame, VideoKind, VideoSubscribeRequest, VideoWriteReceipt,
} from 'koishi-plugin-rtc-bridge/core';

export const inject = ['rtc'];

/** Each source owns its pacing and must interrupt pending next() when aborted. */
export type JpegSource = (signal: AbortSignal) => AsyncIterable<{
  data: Uint8Array; width: number; height: number;
}>;

export interface VideoSelection {
  callId: string;
  expected: {
    providerId: string; platform: string; selfId: string;
    kind: 'direct' | 'group'; targetId: string;
  };
  receive: VideoSubscribeRequest[]; // Explicit participantId + camera/screen pairs.
  /** Independent inputs; neither channel implicitly copies the other. */
  outputs?: Partial<Record<VideoKind, JpegSource>>;
  onFrame?: (frame: VideoFrame, signal: AbortSignal) => void | Promise<void>;
  onReceipt?: (receipt: VideoWriteReceipt, signal: AbortSignal) => void | Promise<void>;
  signal: AbortSignal;
}

/** Call once from the consuming plugin's apply(). Nothing opens until run(). */
export function createVideoConsumer(ctx: Context, owner: string) {
  // This helper owns disposal so it can abort its sources before releasing leases.
  const control = ctx.rtc.manager.controller(owner);
  const jobs = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let disposed = false;

  async function runSelected(selection: VideoSelection, abort: AbortController) {
    const { callId, expected, receive, outputs = {} } = selection;
    const signal = AbortSignal.any([selection.signal, abort.signal]);
    signal.throwIfAborted();
    const call = ctx.rtc.manager.getCall(callId);
    if (call.state !== 'connected' || call.providerId !== expected.providerId
      || call.account.platform !== expected.platform || call.account.selfId !== expected.selfId
      || call.kind !== expected.kind || call.targetId !== expected.targetId) {
      throw new Error('Select an already connected call matching the configured account and target');
    }
    if (!receive.length && !Object.keys(outputs).length) throw new Error('Select at least one input or output');
    if (receive.length && !selection.onFrame) throw new Error('Provide onFrame for selected subscriptions');
    const selected = new Set<string>();
    for (const request of receive) {
      const key = `${request.participantId}\0${request.kind}`;
      if (!['camera', 'screen'].includes(request.kind) || !request.participantId || selected.has(key)
        || !call.participants.some(p => p.id === request.participantId && p.identity === 'platform')) {
        throw new Error('Select unique camera/screen tracks from identified call participants');
      }
      selected.add(key);
    }
    const kinds = Object.keys(outputs) as VideoKind[];
    if (kinds.some(kind => !['camera', 'screen'].includes(kind) || typeof outputs[kind] !== 'function')) {
      throw new Error('Outputs must explicitly select camera and/or screen JPEG sources');
    }

    control.claim(callId); // No takeover, dial, accept, join, or device selection.
    const tracks: { trackId: string }[] = [], opened = new Set<VideoKind>();
    const tasks: Promise<void>[] = [], failures: unknown[] = [];
    let terminalObserved = false, leaseLost = false;
    const changed = (snapshot: CallSnapshot) => {
      if (snapshot.id !== callId) return;
      terminalObserved ||= snapshot.state === 'ended' || snapshot.state === 'failed';
      leaseLost ||= snapshot.owner !== owner;
      if (snapshot.state !== 'connected' || leaseLost) abort.abort();
    };
    ctx.rtc.manager.on('call', changed);
    const cleanup = async (work: () => Promise<unknown>): Promise<boolean> => {
      try { await work(); return true; }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // The manager already revokes leases and clears native media on terminal
        // calls. Ignore only its expected gates after observing that transition.
        if (terminalObserved && (code === 'CALL_ENDED' || code === 'CALL_NOT_FOUND')
          || (terminalObserved || leaseLost) && code === 'NOT_CONTROLLER') return true;
        failures.push(error); abort.abort(); return false;
      }
    };
    const guard = async (work: () => Promise<void>) => {
      try { await work(); }
      catch (error) { if (!signal.aborted) { failures.push(error); abort.abort(); } }
    };
    try {
      for (const request of receive) {
        signal.throwIfAborted();
        const track = await control.subscribeVideo(callId, request);
        tracks.push(track); signal.throwIfAborted();
      }
      if (kinds.length) {
        const sources = await control.videoSources(callId); signal.throwIfAborted();
        for (const kind of kinds) {
          if (!sources.some(source => source.id === 'external-frames' && source.sourceType === 'frames'
            && source.kind === kind && (!source.channels || source.channels.includes(kind)))) {
            throw new Error(`The provider has no configured external-frames ${kind} output`);
          }
          opened.add(kind); // Also clean up a partially failed start.
          await control.sendVideo(callId, { kind, sourceId: 'external-frames' });
          signal.throwIfAborted();
        }
      }
      for (const track of tracks) tasks.push(guard(async () => {
        for await (const frame of control.video(callId, track.trackId, { signal })) {
          signal.throwIfAborted();
          await selection.onFrame!(frame, signal); // No persistence or automatic forwarding.
        }
      }));
      for (const kind of kinds) tasks.push(guard(async () => {
        let sequence = 0;
        try {
          // The consumer supplies two separate AsyncIterables for camera and screen.
          // Await each write: one frame in flight per channel, no unbounded queue.
          for await (const jpeg of outputs[kind]!(signal)) {
            signal.throwIfAborted();
            const receipt = await control.writeVideo(callId, {
              kind, encoding: 'jpeg', width: jpeg.width, height: jpeg.height,
              data: jpeg.data, sequence: sequence++, timestamp: Date.now(),
            });
            signal.throwIfAborted();
            if (receipt.state === 'failed') throw new Error(receipt.error || `${kind} frame failed`);
            await selection.onReceipt?.(receipt, signal);
          }
        } finally {
          // stopVideo keeps the virtual-camera worker alive until native capture stops.
          if (await cleanup(() => control.stopVideo(callId, kind))) opened.delete(kind);
        }
      }));
      await Promise.all(tasks);
    } catch (error) {
      if (!signal.aborted) failures.push(error);
    } finally {
      abort.abort();
      await Promise.allSettled(tasks);
      // Source abort ends application writes, not the bridge worker's heartbeat.
      // Only the provider owns the order: native stop -> worker stop.
      for (const kind of opened) {
        await cleanup(() => control.stopVideo(callId, kind));
      }
      for (const track of tracks) {
        await cleanup(() => control.unsubscribeVideo(callId, track.trackId));
      }
      ctx.rtc.manager.off('call', changed);
      try { await control.release(callId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Video task stopped; check cleanup errors');
  }

  async function dispose() {
    disposed = true;
    for (const job of jobs.values()) job.abort.abort();
    const settled = await Promise.allSettled([...jobs.values()].map(job => job.done));
    await control.dispose();
    const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Video consumer cleanup failed');
  }
  ctx.on('dispose', dispose);
  return {
    run(selection: VideoSelection): Promise<void> {
      if (disposed) return Promise.reject(new Error('Video consumer is disposed'));
      if (jobs.has(selection.callId)) return Promise.reject(new Error('This consumer already owns a task for this call'));
      const job = { abort: new AbortController(), done: Promise.resolve() };
      jobs.set(selection.callId, job);
      job.done = runSelected(selection, job.abort).finally(() => jobs.delete(selection.callId));
      return job.done;
    },
    async stop(callId: string) {
      const job = jobs.get(callId); if (!job) return;
      job.abort.abort(); await job.done;
    },
    dispose,
  };
}
