import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { DesktopVideo, ownedWindowHandle, windowHandle, requirePermission } = require('../av-host/desktop-video.cjs');
test('native window IDs use media source IDs instead of macOS NSView pointers', () => {
  assert.equal(ownedWindowHandle({ getMediaSourceId: () => 'window:9876:0', getNativeWindowHandle: () => { throw Error('NSView must not be used'); } }), 9876);
  for (const value of ['screen:12:0', 'window:0:0', 'window:9007199254740993:0', 'window:-1:0', 'window:123:0garbage']) assert.throws(() => windowHandle(value), /valid native/);
});
test('macOS permissions fail explicitly and camera prompt occurs only for explicit start', async () => {
  let asked = 0;
  await assert.rejects(requirePermission('darwin', { getMediaAccessStatus: () => 'denied' }, 'screen'), /Screen recording permission is denied/);
  await requirePermission('darwin', { getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => (++asked, true) }, 'camera');
  assert.equal(asked, 1);
  await assert.rejects(requirePermission('darwin', { getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => false }, 'camera'), /permission/);
  await requirePermission('win32', { getMediaAccessStatus: () => 'unknown' }, 'camera');
  await assert.rejects(requirePermission('win32', { getMediaAccessStatus: () => 'denied' }, 'camera'), /permission/);
});
function fixture() {
  const calls = [], state = { sources: [{ id: 'window:100:0', name: 'App' }, { id: 'screen:1:0', name: 'Display' }], windows: [] };
  class Window {
    constructor(options) {
      this.options = options; state.windows.push(this); this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler: handler => this.popup = handler, session: { setPermissionCheckHandler: handler => this.check = handler, setPermissionRequestHandler: handler => this.permit = handler, setDisplayMediaRequestHandler: handler => this.select = handler }, executeJavaScript: async (code, gesture) => { calls.push([code, gesture]); return code.includes('Start') ? { width: 1920, height: 1080 } : true; } });
    }
    async loadFile(file) { this.file = file; }
    setMenu(menu) { this.menu = menu; }
    setMenuBarVisibility(visible) { this.menuBarVisible = visible; }
    setContentSize(w,h) { this.size = [w,h]; }
    showInactive() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    getMediaSourceId() { return 'window:222:0'; }
  }
  const host = new DesktopVideo({ BrowserWindow: Window, desktopCapturer: { getSources: async options => { calls.push(options); return state.sources; } }, platform: 'darwin', systemPreferences: { getMediaAccessStatus: () => 'granted' } });
  return { host, calls, state };
}
test('enumeration has no thumbnails or capture; display and windows retain exact opaque IDs', async () => {
  const f=fixture(); const sources=await f.host.sources();
  assert.deepEqual(sources.map(s=>[s.id,s.sourceType]),[['window:100:0','window'],['screen:1:0','display']]);
  assert.equal(f.state.windows.length,0); assert.deepEqual(f.calls[0].thumbnailSize,{width:0,height:0});
});
test('selected screen is captured via its own session, no audio, and original geometry is preserved', async () => {
  const f=fixture(), source=(await f.host.sources())[1];
  assert.equal(await f.host.open(source,()=>{}),222);
  const win=f.state.windows[0]; assert.deepEqual(win.size,[1280,720]); assert.equal(win.options.webPreferences.nodeIntegration,false);
  assert.equal(win.options.frame,false); assert.equal(win.options.useContentSize,true); assert.equal(win.options.hasShadow,false);
  assert.equal(win.menu,null); assert.equal(win.menuBarVisible,false);
  let granted;
  win.select({videoRequested:true,audioRequested:false},v=>granted=v);
  assert.equal(granted.video.id,'screen:1:0'); assert.equal(granted.audio,undefined);
  win.select({videoRequested:true,audioRequested:true},v=>granted=v);assert.deepEqual(granted,{});
  await f.host.close();assert.equal(win.destroyed,true);
  win.select({videoRequested:true,audioRequested:false},v=>granted=v);assert.deepEqual(granted,{});
});
test('gone window is not replaced by an available full desktop', async () => {
  const f=fixture(), source=(await f.host.sources())[0]; f.state.sources=f.state.sources.slice(1);
  await assert.rejects(f.host.open(source,()=>{}),/no longer available/); assert.equal(f.state.windows.length,0);
});
