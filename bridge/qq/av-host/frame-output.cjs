// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, nativeImage } = require('electron');
const { createVideoOutputWindow } = require('./output-window.cjs');
/** Own render surfaces for supplied or explicitly generated frames. Never captures another app or device. */
class FrameOutputs {
  constructor() { this.outputs = new Map(); this.openings = new Map(); }
  config() {
    const bridgeDir = process.env.KOISHI_RTC_QQ_BRIDGE_DIR || path.resolve(__dirname, '..');
    const runtimeDir = process.env.KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE ? path.dirname(path.resolve(process.env.KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE)) : path.join(bridgeDir, 'runtime');
    const file = path.join(runtimeDir, 'video.json');
    if (!fs.existsSync(file)) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value.virtualCamera !== 'object') return null;
    return { ...value.virtualCamera, bridgeDir };
  }
  cameraAvailable() {
    try { const config = this.config(); return !!config?.device && (process.platform === 'linux' ? fs.existsSync(config.device) : !!config.qqDeviceId); }
    catch { return false; }
  }
  async createSink(config, format) {
    const module = [path.join(config.bridgeDir, 'video', 'virtual-camera.mjs'), path.resolve(__dirname, '../../video/virtual-camera.mjs')].find(file => fs.existsSync(file));
    if (!module) throw new Error('Virtual camera module is missing from this installation');
    const { VirtualCameraSink } = await import(pathToFileURL(module).href);
    return new VirtualCameraSink({ ...config, ...format });
  }
  check(output) {
    if (output.error) throw output.error;
    if (this.outputs.get(output.kind) !== output || output.closed || output.window.isDestroyed()) throw new Error('The selected frame output has stopped');
  }
  async rendering(output, work) {
    this.check(output);
    let timer, abort;
    try {
      const result = await Promise.race([work, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Video frame rendering timed out')), 3000);
        abort = () => reject(new Error('The selected frame output has stopped'));
        output.abort.signal.addEventListener('abort', abort, { once: true });
      })]);
      this.check(output); return result;
    } finally { clearTimeout(timer); output.abort.signal.removeEventListener('abort', abort); }
  }
  async open(kind, callId, { framing = 'full', generated = false, onError } = {}) {
    if (!['camera', 'screen'].includes(kind)) throw new Error('Unknown video output kind');
    if (typeof generated !== 'boolean') throw new Error('Invalid generated video option');
    if (framing !== 'full' && framing !== 'portrait-safe') throw new Error('Unknown video framing');
    if (kind !== 'camera') framing = 'full';
    // Reserve before awaiting old cleanup: an older open must never replace a newer output.
    const generation = Symbol(kind); this.openings.set(kind, generation);
    const previous = this.outputs.get(kind); this.outputs.delete(kind);
    await this.dispose(previous);
    if (this.openings.get(kind) !== generation) throw new Error('The selected frame output has stopped');
    const { width, height } = kind === 'camera' && process.platform === 'linux' ? require('./camera-size.cjs').cameraRenderSize(require('./camera-size.cjs').linuxPageSize()) : { width: 640, height: 360 };
    const window = createVideoOutputWindow(BrowserWindow, { width, height, title: `Koishi RTC · ${generated ? 'TEST PATTERN' : kind + ' frames'}` });
    const output = { window, callId, kind, width, height, framing, generated, onError, sourceId: generated ? 'test-pattern' : 'external-frames', rawSequence: 0, startedAt: Date.now(), abort: new AbortController() }; this.outputs.set(kind, output);
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      await this.rendering(output, window.loadFile(path.join(__dirname, 'frame-output.html')));
      await this.rendering(output, window.webContents.executeJavaScript(`window.rtcSize(${width},${height},${JSON.stringify(framing)})`));
      if (kind === 'screen') window.showInactive();
      else {
        const config = this.config(); if (!config) throw new Error('Configure an explicit virtual camera in runtime/video.json');
        const format = { width, height, fps: 15, pixelFormat: 'rgba' };
        const sink = await this.createSink(config, format); this.check(output);
        output.sink = sink; output.format = format; output.device = config.device;
        sink.on('error', error => this.failed(output, error));
        await sink.start({ callId, sourceId: output.sourceId, signal: output.abort.signal }); this.check(output);
        output.nativeDeviceId = sink.nativeDeviceId || config.qqDeviceId;
        if (!output.nativeDeviceId) throw new Error('The virtual camera has no verified QQ device identifier');
        if (!generated) {
          const black = Buffer.alloc(width * height * 4); for (let i = 3; i < black.length; i += 4) black[i] = 255;
          await this.submit(output, black);
        }
      }
      if (generated) await this.generatedFrame(output);
      this.check(output); output.ready = true;
      if (generated) this.schedule(output);
      return { handle: require('./desktop-video.cjs').ownedWindowHandle(window), nativeDeviceId: output.nativeDeviceId };
    } catch (error) {
      if (this.outputs.get(kind) === output) this.outputs.delete(kind);
      await this.dispose(output); throw error;
    }
  }
  async submit(output, data) {
    this.check(output);
    const receipt = await output.sink.write({ ...output.format, callId: output.callId, sourceId: output.sourceId, kind: 'generated', sequence: output.rawSequence++, timestamp: Date.now(), data });
    this.check(output);
    if (receipt.state !== 'dispatched') throw new Error(receipt.error || 'Virtual-camera frame was not submitted');
  }
  async capture(output) {
    const image = await this.rendering(output, output.window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }));
    const bgra = image.resize({ width: output.width, height: output.height, quality: 'good' }).toBitmap();
    if (bgra.length !== output.width * output.height * 4) throw new Error('Unexpected virtual-camera render surface size');
    for (let i = 0; i < bgra.length; i += 4) { const b = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = b; }
    await this.submit(output, bgra);
  }
  async generatedFrame(output) {
    await this.rendering(output, output.window.webContents.executeJavaScript(`window.rtcTestPattern(${Math.max(0, Date.now() - output.startedAt)})`));
    if (output.sink) await this.capture(output);
  }
  schedule(output) {
    if (output.closed || output.error || this.outputs.get(output.kind) !== output) return;
    // One frame at a time, at most 15 fps. Slow rendering never builds a backlog.
    output.timer = setTimeout(async () => {
      output.timer = null;
      try { this.check(output); await this.generatedFrame(output); this.schedule(output); }
      catch (error) { this.failed(output, error); }
    }, Math.ceil(1000 / 15));
    output.timer.unref?.();
  }
  failed(output, error) {
    if (output.closed || this.outputs.get(output.kind) !== output || output.error) return;
    output.error = error; clearTimeout(output.timer); output.timer = null;
    // Initial failures propagate through open(); only subsequent failures need notification.
    if (output.ready) {
      try { output.onError?.(error); } finally { void this.dispose(output).catch(() => {}); }
    }
  }
  async write(frame) {
    const output = this.outputs.get(frame.kind);
    if (!output || output.callId !== frame.callId) throw new Error('The selected frame output has stopped');
    this.check(output);
    if (output.generated) throw new Error('Generated video does not accept external frames');
    const bytes = Buffer.from(frame.data, 'base64'), decoded = nativeImage.createFromBuffer(bytes), size = decoded.getSize();
    if (decoded.isEmpty() || size.width !== frame.width || size.height !== frame.height) throw new Error('JPEG dimensions do not match the submitted frame');
    await this.rendering(output, output.window.webContents.executeJavaScript(`window.rtcFrame(${JSON.stringify('data:image/jpeg;base64,' + frame.data)})`));
    if (output.sink) {
      await this.capture(output);
      return { state: 'submitted', evidence: 'pyvirtualcam-send' };
    }
    return { state: 'rendered', evidence: 'owned-window-image-decoded' };
  }
  async dispose(output) {
    if (!output) return;
    if (output.disposal) return output.disposal;
    output.closed = true; clearTimeout(output.timer); output.timer = null; output.abort.abort();
    output.disposal = (async () => { try { await output.sink?.stop(); } finally { if (!output.window.isDestroyed()) output.window.destroy(); } })();
    return output.disposal;
  }
  async close(kind) {
    this.openings.delete(kind);
    const output = this.outputs.get(kind); this.outputs.delete(kind);
    await this.dispose(output);
  }
  async closeAll() { await Promise.allSettled([...new Set([...this.openings.keys(), ...this.outputs.keys()])].map(kind => this.close(kind))); }
}
module.exports = { FrameOutputs };
