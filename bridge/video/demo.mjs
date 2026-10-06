import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createVideoSource, createVirtualCameraSink } from './index.mjs';

/** Explicit local output example. Does not start QQ, join a call or select a QQ camera. */
export async function sendGeneratedVideo(config, { signal } = {}) {
  const seconds = config.seconds ?? 10;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('Demo duration must be greater than zero and at most 60 seconds.');
  const scope = { callId: config.callId ?? 'local-virtual-camera-test', sourceId: 'generated:color-bars' };
  const source = createVideoSource({ ...config, backend: 'generated', sourceId: scope.sourceId });
  const sink = createVirtualCameraSink(config);
  const receipts = { dispatched: 0, dropped: 0, cancelled: 0, failed: 0 };
  const pending = new Set();
  let rejectRun, timer, endRun;
  const complete = new Promise((resolve, reject) => { endRun = resolve; rejectRun = reject; });
  complete.catch(() => {});
  const aborted = () => rejectRun(new Error('Virtual-camera demonstration aborted.'));
  source.on('error', rejectRun); sink.on('error', rejectRun);
  source.on('frame', frame => {
    try {
      const result = sink.write(frame);
      pending.add(result);
      result.then(receipt => { receipts[receipt.state]++; pending.delete(result); }, error => { pending.delete(result); rejectRun(error); });
    } catch (error) { rejectRun(error); }
  });
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    if (signal?.aborted) throw new Error('Virtual-camera demonstration aborted.');
    await sink.start({ ...scope, signal });
    await source.start({ callId: scope.callId, signal });
    timer = setTimeout(endRun, seconds * 1000);
    await complete;
    await source.stop(); await Promise.all(pending);
    return { ...receipts, evidence: 'pyvirtualcam-send', remoteDeliveryConfirmed: false };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', aborted);
    await source.stop(); await sink.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { run: { type: 'boolean' }, backend: { type: 'string' }, device: { type: 'string' }, python: { type: 'string' }, seconds: { type: 'string', default: '10' }, width: { type: 'string', default: '640' }, height: { type: 'string', default: '360' }, fps: { type: 'string', default: '15' }, 'pixel-format': { type: 'string', default: 'i420' } } });
    if (!values.run || !values.backend || !values.device) throw new Error('Explicit output required: node bridge/video/demo.mjs --run --backend <backend> --device <virtual-camera-device> [--seconds 10].');
    const abort = new AbortController(); process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    const result = await sendGeneratedVideo({ backend: values.backend, device: values.device, python: values.python, seconds: Number(values.seconds), width: Number(values.width), height: Number(values.height), fps: Number(values.fps), pixelFormat: values['pixel-format'] }, { signal: abort.signal });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
