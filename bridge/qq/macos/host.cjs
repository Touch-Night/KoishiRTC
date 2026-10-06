// SPDX-License-Identifier: GPL-3.0-only
// macOS bootstrap for the shared GPL AV host. QQ supplies its own Electron/PPAPI runtime.
'use strict';
const path = require('node:path');
const { app } = require('electron');
if (process.platform !== 'darwin') throw new Error('This bootstrap requires macOS QQ Electron');
if (!process.env.KOISHI_RTC_QQ_AVSDK_PATH) throw new Error('The launcher must select the QQ.app AVSDK path');
app.commandLine.appendSwitch('allow-command-line-plugins');
// DYLD paths are deliberately not overridden: the audited library uses @loader_path
// for its bundled TXFFmpeg/TXSoundTouch frameworks.
require(path.join(__dirname, '..', 'av-host', 'host.cjs'));
