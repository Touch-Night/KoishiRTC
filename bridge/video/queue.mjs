import { EventEmitter } from 'node:events';
import { validateVideoFrame, videoIdentifier } from './protocol.mjs';

/** At most one frame in flight and one replaceable pending frame. One instance per source session. */
export class LatestVideoFrameQueue extends EventEmitter {
  constructor(dispatch, { callId, sourceId, maxAgeMs = 1000, timeoutMs = 3000, now = Date.now } = {}) {
    super();
    if (typeof dispatch !== 'function') throw new Error('Video dispatch function is required.');
    this.dispatch = dispatch; this.callId = videoIdentifier(callId, 'callId'); this.sourceId = videoIdentifier(sourceId, 'sourceId');
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid video queue time limits.');
    this.maxAgeMs = maxAgeMs; this.timeoutMs = timeoutMs; this.now = now; this.lastSequence = -1; this.closed = false;
  }
  submit(frame) {
    const valid = validateVideoFrame(frame);
    if (this.closed) throw new Error('Video queue is closed.');
    if (valid.callId !== this.callId || valid.sourceId !== this.sourceId) throw new Error('Video frame belongs to another call or source.');
    if (valid.sequence <= this.lastSequence) throw new Error('Video sequence must increase.');
    if (valid.timestamp > this.now() + 5000) throw new Error('Video timestamp is too far in the future.');
    this.lastSequence = valid.sequence;
    let resolve; const promise = new Promise(done => { resolve = done; });
    const item = { frame: { ...valid, data: Buffer.from(valid.data) }, resolve, settled: false };
    if (this.pending) this.finish(this.pending, 'dropped', 'Replaced by a newer frame.');
    this.pending = item; void this.pump(); return promise;
  }
  finish(item, state, error, evidence) {
    if (item.settled) return; item.settled = true;
    const receipt = { callId: item.frame.callId, sourceId: item.frame.sourceId, sequence: item.frame.sequence,
      acceptedBytes: item.frame.data.length, dispatchedBytes: state === 'dispatched' ? item.frame.data.length : 0,
      state, ...(error ? { error } : {}), ...(evidence ? { evidence } : {}) };
    item.resolve(receipt); this.emit('receipt', receipt);
  }
  async pump() {
    if (this.inflight || this.closed) return;
    while (this.pending && !this.closed) {
      const item = this.pending; this.pending = null;
      if (this.now() - item.frame.timestamp > this.maxAgeMs) { this.finish(item, 'dropped', 'Frame expired before dispatch.'); continue; }
      this.inflight = item; item.abort = new AbortController();
      let timeout, onAbort;
      try {
        const cancelled = new Promise((_, reject) => { onAbort = () => reject(new Error('Video dispatch cancelled.')); item.abort.signal.addEventListener('abort', onAbort, { once: true }); });
        const timedOut = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Video dispatch timed out.')), this.timeoutMs); });
        const result = await Promise.race([Promise.resolve().then(() => {
          if (item.abort.signal.aborted) throw new Error('Video dispatch cancelled.');
          return this.dispatch(item.frame, { signal: item.abort.signal });
        }), timedOut, cancelled]);
        if (!result || typeof result.evidence !== 'string' || !result.evidence) throw new Error('Video transport did not supply dispatch evidence.');
        this.finish(item, 'dispatched', undefined, result.evidence);
      } catch (error) {
        this.finish(item, this.closed ? 'cancelled' : 'failed', error.message);
        // Continuing behind an unresponsive transport could write stale frames after ownership changes.
        this.close(error.message);
      } finally {
        clearTimeout(timeout); item.abort.signal.removeEventListener('abort', onAbort); item.abort.abort(); this.inflight = null;
      }
    }
  }
  close(reason = 'Video source stopped.') {
    this.closed = true;
    if (this.pending) { this.finish(this.pending, 'cancelled', reason); this.pending = null; }
    if (this.inflight) { this.finish(this.inflight, 'cancelled', reason); this.inflight.abort.abort(); }
  }
}
