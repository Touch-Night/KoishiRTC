// SPDX-License-Identifier: GPL-3.0-only
// Explicit local extension for independently prepared NapCat installations.
// This does not change the official plugin allowlist or claim an official ID.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const KEY = Symbol.for('koishi-rtc.qq.local-plugin-bootstrap.v1');
const ID = 'napcat-plugin-koishi-rtc-qq';
module.exports = function installLocalPluginBootstrap(pluginDirectory) {
  const pluginPath = path.resolve(pluginDirectory);
  if (globalThis[KEY]) throw new Error('Koishi RTC local bootstrap is already registered');
  globalThis[KEY] = async manager => {
    // Honor the normal plugin enabled switch. Use NapCat's own context/lifecycle
    // machinery after the explicit local loader has selected this single entry.
    if (manager?.getPluginConfig?.()[ID] !== true || manager.getPluginInfo?.(ID)?.loaded) return;
    if (typeof manager?.loadPlugin !== 'function' || !(manager.plugins instanceof Map)) throw new Error('Unknown NapCat local plugin lifecycle');
    const packageJson = JSON.parse(fs.readFileSync(path.join(pluginPath, 'package.json'), 'utf8'));
    if (packageJson.name !== ID || packageJson.main !== 'index.mjs') throw new Error('Unexpected local Koishi RTC plugin package');
    const entry = { id: ID, fileId: ID, name: ID, version: packageJson.version,
      description: packageJson.description, author: packageJson.author,
      pluginPath, entryPath: path.join(pluginPath, 'index.mjs'), packageJson,
      enable: true, loaded: false, localBootstrap: true, runtime: { status: 'unloaded' } };
    manager.plugins.set(ID, entry);
    const loaded = await manager.loadPlugin(entry);
    if (!loaded) throw new Error('Explicit local Koishi RTC plugin initialization failed');
    manager.logger?.log?.('[KoishiRTC] Explicit local plugin loaded; official plugin allowlist unchanged.');
  };
};
