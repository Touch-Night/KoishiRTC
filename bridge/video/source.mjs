import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { videoFormat, videoFrameBytes, videoIdentifier, validateVideoFrame } from './protocol.mjs';

/** Program-generated color bars, motion and a sequence marker; never reads any device. */
export function generateVideoFrame(format, sequence = 0) {
  const { width, height, pixelFormat } = videoFormat(format);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid generated frame sequence.');
  const data = Buffer.alloc(videoFrameBytes(format));
  const rgba = [[235,235,235],[235,235,16],[16,235,235],[16,235,16],[235,16,235],[235,16,16],[16,16,235],[16,16,16]];
  const yuv = [[218,128,128],[193,32,143],[153,160,32],[128,64,48],[103,192,208],[78,96,224],[38,224,112],[30,128,128]];
  const box = Math.max(2, Math.floor(Math.min(width, height) / 6 / 2) * 2);
  const left = (sequence * 4) % Math.max(2, width - box + 1), top = Math.floor((height - box) / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const moving = x >= left && x < left + box && y >= top && y < top + box;
    const marker = y < Math.max(2, Math.floor(height / 12)) && x < 16 * Math.max(1, Math.floor(width / 16));
    const bit = marker && ((sequence >>> (Math.floor(x / Math.max(1, Math.floor(width / 16))) % 16)) & 1);
    const color = moving ? 0 : marker ? (bit ? 0 : 7) : Math.min(7, Math.floor(x * 8 / width));
    if (pixelFormat === 'rgba') {
      const offset = (y * width + x) * 4; data.set(rgba[color], offset); data[offset + 3] = 255;
    } else {
      data[y * width + x] = yuv[color][0];
      if (!(x % 2) && !(y % 2)) {
        const offset = y / 2 * (width / 2) + x / 2;
        data[width * height + offset] = yuv[color][1];
        data[width * height * 5 / 4 + offset] = yuv[color][2];
      }
    }
  }
  return data;
}

export class VideoSource extends EventEmitter {
  constructor(config = {}, dependencies = {}) {
    super();
    if (!['generated', 'external'].includes(config.backend ?? 'generated')) throw new Error('Video backend must be generated or external; camera and desktop capture are not implicit.');
    this.backend = config.backend ?? 'generated'; this.format = videoFormat(config);
    this.sourceId = videoIdentifier(config.sourceId ?? (this.backend === 'generated' ? 'generated:color-bars' : ''), 'sourceId');
    this.kind = this.backend === 'generated' ? 'generated' : config.kind;
    if (!['generated', 'camera', 'screen'].includes(this.kind)) throw new Error('External video requires an explicit kind.');
    this.now = dependencies.now ?? Date.now; this.monotonic = dependencies.monotonic ?? (() => performance.now());
    this.schedule = dependencies.setTimeout ?? setTimeout; this.unschedule = dependencies.clearTimeout ?? clearTimeout;
    this.state = 'stopped'; this.generation = 0; this.on('error', () => {});
  }
  async listSources() { return [{ id: this.sourceId, kind: this.kind, backend: this.backend, format: this.format, capturesDevices: false }]; }
  async diagnostics() { return [{ id: 'video.source', level: 'ok', message: this.backend === 'generated' ? 'Synthetic frames only; no camera or display access.' : 'External frames only; the caller owns capture permission and source selection.' }]; }
  async start({ callId, signal } = {}) {
    if (this.state !== 'stopped') throw new Error('Video source is already running.');
    this.callId = videoIdentifier(callId, 'callId');
    if (signal?.aborted) throw new Error('Video source start was aborted.');
    this.state = 'running'; this.sequence = 0; this.lastSequence = -1; this.startedAt = this.monotonic(); this.nextDue = this.startedAt;
    const generation = ++this.generation;
    this.signal = signal; this.abort = () => { void this.stop(); }; signal?.addEventListener('abort', this.abort, { once: true });
    this.emit('state', { state: this.state, callId: this.callId, sourceId: this.sourceId });
    if (this.backend === 'generated') {
      const next = () => {
        if (this.state !== 'running' || generation !== this.generation) return;
        try {
          const sequence = this.sequence++;
          this.emit('frame', { ...this.format, kind: this.kind, sourceId: this.sourceId, callId: this.callId, sequence, timestamp: this.now(), data: generateVideoFrame(this.format, sequence) });
        } catch (error) { void this.stop(); this.emit('error', error); return; }
        if (this.state !== 'running' || generation !== this.generation) return;
        const current = this.monotonic(), interval = 1000 / this.format.fps;
        // Skip elapsed slots after a slow listener; never burst to catch up.
        this.nextDue = this.startedAt + (Math.floor((current - this.startedAt) / interval) + 1) * interval;
        this.timer = this.schedule(next, Math.max(1, this.nextDue - current));
      };
      this.timer = this.schedule(next, 0);
    }
  }
  write(frame) {
    if (this.backend !== 'external' || this.state !== 'running') throw new Error('Only a running external video source accepts writes.');
    const valid = validateVideoFrame(frame);
    if (valid.callId !== this.callId || valid.sourceId !== this.sourceId || valid.kind !== this.kind || Object.keys(this.format).some(key => valid[key] !== this.format[key])) throw new Error('External video frame differs from its selected source or session.');
    if (valid.sequence <= this.lastSequence) throw new Error('Video frame sequence must increase within a source session.');
    this.lastSequence = valid.sequence;
    this.emit('frame', { ...valid, data: Buffer.from(valid.data) });
  }
  async stop() {
    if (this.state === 'stopped') return;
    this.state = 'stopped'; ++this.generation; this.unschedule(this.timer); this.timer = null;
    this.signal?.removeEventListener('abort', this.abort); this.signal = null;
    this.emit('state', { state: this.state, callId: this.callId, sourceId: this.sourceId }); this.callId = null;
  }
}

export function createVideoSource(config, dependencies) { return new VideoSource(config, dependencies); }
