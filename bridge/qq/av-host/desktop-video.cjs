// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fail = (code, message) => Object.assign(new Error(message), { code });
function windowHandle(mediaId) {
  const match = /^window:([1-9]\d*):\d+$/.exec(mediaId ?? '');
  const handle = match && Number(match[1]);
  if (!Number.isSafeInteger(handle) || handle <= 0) throw fail('INVALID_SOURCE', 'Electron did not provide a valid native window ID');
  return handle;
}
function ownedWindowHandle(window) {
  // getNativeWindowHandle() is an NSView pointer on macOS, not a CGWindowID.
  // Electron's desktop capture ID is the platform window identifier on all OSes.
  return windowHandle(window.getMediaSourceId());
}
function permissionStatus(platform, preferences, kind) {
  if (!['darwin', 'win32'].includes(platform)) return 'not-required';
  try { return preferences?.getMediaAccessStatus(kind) ?? 'unknown'; } catch { return 'unknown'; }
}
async function requirePermission(platform, preferences, kind) {
  const status = permissionStatus(platform, preferences, kind);
  if (status === 'not-required' || status === 'granted') return;
  if (kind === 'camera' && platform === 'darwin' && status === 'not-determined' && await preferences.askForMediaAccess('camera')) return;
  // Windows desktop apps have an OS-wide camera permission; Electron may return
  // unknown on older Windows. The exact native open still must acknowledge.
  if (platform === 'win32' && (status === 'unknown' || kind === 'screen')) return;
  if (kind === 'screen' && platform === 'darwin' && status === 'not-determined') return; // Explicit capture below may present the OS prompt.
  throw fail('VIDEO_PERMISSION_DENIED', `${kind === 'screen' ? 'Screen recording' : 'Camera'} permission is ${status}. Enable it for the dedicated QQ AV Host in system privacy settings, then restart that Host.`);
}
class DesktopVideo {
  constructor({ BrowserWindow, desktopCapturer, systemPreferences, platform = process.platform }) {
    Object.assign(this, { BrowserWindow, desktopCapturer, systemPreferences, platform }); this.capture = null;
  }
  status() { return { camera: permissionStatus(this.platform, this.systemPreferences, 'camera'), screen: permissionStatus(this.platform, this.systemPreferences, 'screen') }; }
  async ensure(kind) { await requirePermission(this.platform, this.systemPreferences, kind); }
  async sources() {
    await this.ensure('screen');
    const sources = await this.desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    return sources.filter(source => /^(window|screen):[\d]+:[\d]+$/.test(source.id)).slice(0, 128).map(source => ({ id: source.id, name: source.name.slice(0, 200), sourceType: source.id.startsWith('screen:') ? 'display' : 'window', captureId: source.id }));
  }
  async open(source, onFailure) {
    await this.close(); await this.ensure('screen');
    // Re-enumerate the exact ID. Disappearing sources never fall back to a screen.
    const available = await this.desktopCapturer.getSources({ types: [source.sourceType === 'display' ? 'screen' : 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const selected = available.find(item => item.id === source.captureId);
    if (!selected) throw fail('VIDEO_SOURCE_GONE', 'The selected screen or window is no longer available');
    const window = new this.BrowserWindow({ width: 640, height: 360, useContentSize: true, frame: false, show: false, title: 'Koishi RTC · selected screen source', webPreferences: { partition: `rtc-video-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const current = { window, timer: null }; this.capture = current;
    try {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      // This private in-memory session belongs to only this owned local page.
      window.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === 'display-capture');
      window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window.webContents && permission === 'display-capture'));
      window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
        callback(this.capture === current && request.videoRequested && !request.audioRequested ? { video: selected } : {});
      }, { useSystemPicker: false });
      await window.loadFile(path.join(__dirname, 'capture-output.html'));
      const dimensions = await window.webContents.executeJavaScript('window.rtcCaptureStart()', true);
      if (this.capture !== current) throw fail('STALE_CALL', 'Selected screen capture was cancelled');
      if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) throw fail('VIDEO_SOURCE_EMPTY', 'Selected source produced no decoded frame');
      const scale = Math.min(1280 / dimensions.width, 720 / dimensions.height, 1);
      window.setContentSize(Math.max(2, Math.round(dimensions.width * scale)), Math.max(2, Math.round(dimensions.height * scale)));
      window.showInactive();
      let checking = false;
      current.timer = setInterval(async () => {
        if (checking || this.capture !== current) return; checking = true;
        try {
          const alive = !window.isDestroyed() && await window.webContents.executeJavaScript('window.rtcCaptureAlive()');
          if (!alive && this.capture === current) { await this.close(); onFailure(fail('VIDEO_SOURCE_ENDED', 'The selected screen capture ended')); }
        } catch (error) { if (this.capture === current) { await this.close(); onFailure(error); } }
        finally { checking = false; }
      }, 1000);
      current.timer.unref?.();
      return ownedWindowHandle(window);
    } catch (error) { if (this.capture === current) await this.close(); throw error; }
  }
  async close() {
    const old = this.capture; this.capture = null; if (!old) return;
    clearInterval(old.timer);
    if (!old.window.isDestroyed()) {
      try { await old.window.webContents.executeJavaScript('window.rtcCaptureStop?.()'); } catch { /* Renderer may already have ended. */ }
      old.window.destroy();
    }
  }
}
module.exports = { DesktopVideo, ownedWindowHandle, windowHandle, permissionStatus, requirePermission };
