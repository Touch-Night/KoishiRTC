// SPDX-License-Identifier: GPL-3.0-only
'use strict';
/** QQ captures these native windows, including any Electron menu or window chrome. */
function createVideoOutputWindow(BrowserWindow, { width = 640, height = 360, title, webPreferences = {} } = {}) {
  const window = new BrowserWindow({
    width, height, useContentSize: true, show: false, title,
    frame: false, autoHideMenuBar: true, hasShadow: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, ...webPreferences },
  });
  // autoHideMenuBar alone lets Alt reveal the default File/Edit/View menu.
  // Remove it before loading/showing, then restore the exact content dimensions.
  window.setMenu?.(null);
  window.setMenuBarVisibility?.(false);
  window.setContentSize(width, height);
  return window;
}
module.exports = { createVideoOutputWindow };
