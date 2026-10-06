// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, nativeImage } = require('electron');
/** Own render surfaces for supplied frames. These never capture another app or device. */
class FrameOutputs {
  constructor() { this.outputs = new Map(); }
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
  async open(kind, callId, { framing = 'full' } = {}) {
    if (framing !== 'full' && framing !== 'portrait-safe') throw new Error('Unknown video framing');
    // Screen sharing keeps its complete, independently sized window.
    if (kind !== 'camera') framing = 'full';
    await this.close(kind);
    const { width, height } = kind === 'camera' && process.platform === 'linux' ? require('./camera-size.cjs').cameraRenderSize(require('./camera-size.cjs').linuxPageSize()) : { width: 640, height: 360 };
    const window = new BrowserWindow({ width, height, useContentSize: true, show: false, title: `Koishi RTC · ${kind} frames`, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const output = { window, callId, kind, width, height, framing, rawSequence: 0 }; this.outputs.set(kind, output);
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      await window.loadFile(path.join(__dirname, 'frame-output.html'));
      await window.webContents.executeJavaScript(`window.rtcSize(${width},${height},${JSON.stringify(framing)})`);
      if (kind === 'screen') window.showInactive();
      else {
        const config = this.config(); if (!config) throw new Error('Configure an explicit virtual camera in runtime/video.json');
        const module = [path.join(config.bridgeDir, 'video', 'virtual-camera.mjs'), path.resolve(__dirname, '../../video/virtual-camera.mjs')].find(file => fs.existsSync(file));
        if (!module) throw new Error('Virtual camera module is missing from this installation');
        const { VirtualCameraSink } = await import(pathToFileURL(module).href);
        const format = { width, height, fps: 15, pixelFormat: 'rgba' };
        output.sink = new VirtualCameraSink({ ...config, ...format }); output.format = format; output.device = config.device;
        output.sink.on('error', error => { output.error = error; });
        await output.sink.start({ callId, sourceId: 'external-frames' });
        output.nativeDeviceId = output.sink.nativeDeviceId || config.qqDeviceId;
        if (!output.nativeDeviceId) throw new Error('The virtual camera has no verified QQ device identifier');
        const black = Buffer.alloc(width * height * 4); for (let i = 3; i < black.length; i += 4) black[i] = 255;
        const ready = await output.sink.write({ ...format, callId, sourceId: 'external-frames', kind: 'generated', sequence: output.rawSequence++, timestamp: Date.now(), data: black });
        if (ready.state !== 'dispatched') throw new Error(ready.error || 'The virtual camera did not accept its first frame');
      }
      return { handle: require('./desktop-video.cjs').ownedWindowHandle(window), nativeDeviceId: output.nativeDeviceId };
    } catch (error) { await this.close(kind); throw error; }
  }
  async write(frame) {
    const output = this.outputs.get(frame.kind);
    if (!output || output.callId !== frame.callId || output.window.isDestroyed()) throw new Error('The selected frame output has stopped');
    if (output.error) throw output.error;
    const bytes = Buffer.from(frame.data, 'base64'), decoded = nativeImage.createFromBuffer(bytes), size = decoded.getSize();
    if (decoded.isEmpty() || size.width !== frame.width || size.height !== frame.height) throw new Error('JPEG dimensions do not match the submitted frame');
    await output.window.webContents.executeJavaScript(`window.rtcFrame(${JSON.stringify('data:image/jpeg;base64,' + frame.data)})`);
    if (this.outputs.get(frame.kind) !== output) throw new Error('Frame output changed while rendering');
    if (output.sink) {
      const image = await output.window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const bgra = image.resize({ width: output.width, height: output.height, quality: 'good' }).toBitmap(); if (bgra.length !== output.width * output.height * 4) throw new Error('Unexpected virtual-camera render surface size');
      for (let i = 0; i < bgra.length; i += 4) { const b = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = b; }
      const receipt = await output.sink.write({ ...output.format, callId: frame.callId, sourceId: 'external-frames', kind: 'generated', sequence: output.rawSequence++, timestamp: Date.now(), data: bgra });
      if (receipt.state !== 'dispatched') throw new Error(receipt.error || 'Virtual-camera frame was not submitted');
      return { state: 'submitted', evidence: 'pyvirtualcam-send' };
    }
    return { state: 'rendered', evidence: 'owned-window-image-decoded' };
  }
  async close(kind) {
    const output = this.outputs.get(kind); if (!output) return;
    this.outputs.delete(kind);
    try { await output.sink?.stop(); } finally { if (!output.window.isDestroyed()) output.window.destroy(); }
  }
  async closeAll() { await Promise.allSettled([...this.outputs.keys()].map(kind => this.close(kind))); }
}
module.exports = { FrameOutputs };
