import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createVideoOutputWindow } = createRequire(import.meta.url)('../av-host/output-window.cjs');

test('native capture surfaces remove the menu before fixing their content size', () => {
  const calls = [];
  class Window {
    constructor(options) { this.options = options; calls.push('create'); }
    setMenu(menu) { calls.push(['menu', menu]); }
    setMenuBarVisibility(visible) { calls.push(['menu-visible', visible]); }
    setContentSize(width, height) { calls.push(['content', width, height]); }
  }
  const window = createVideoOutputWindow(Window, { width: 1024, height: 576, title: 'Supplied frame', webPreferences: { partition: 'private-capture' } });
  assert.deepEqual(calls, ['create', ['menu', null], ['menu-visible', false], ['content', 1024, 576]]);
  for (const option of ['frame', 'show', 'hasShadow', 'resizable', 'minimizable', 'maximizable', 'fullscreenable']) assert.equal(window.options[option], false, option);
  assert.equal(window.options.useContentSize, true); assert.equal(window.options.autoHideMenuBar, true);
  assert.equal(window.options.webPreferences.partition, 'private-capture');
  assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
});
