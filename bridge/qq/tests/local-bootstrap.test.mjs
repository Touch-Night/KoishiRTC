// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
const require = createRequire(import.meta.url);
const register = require('../scripts/local-plugin-bootstrap.cjs');
const key = Symbol.for('koishi-rtc.qq.local-plugin-bootstrap.v1');
const id = 'napcat-plugin-koishi-rtc-qq';
test('explicit local bootstrap preserves own identity and normal plugin enabled/lifecycle behavior', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtc-local-bootstrap-'));
  t.after(async () => { delete globalThis[key]; await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: id, main: 'index.mjs', version: 'fixture' }));
  register(root);
  let enabled = false, loads = 0;
  const manager = { plugins: new Map(), getPluginConfig: () => ({ [id]: enabled }), getPluginInfo(name) { return this.plugins.get(name); },
    async loadPlugin(entry) { loads++; entry.loaded = true; return true; } };
  await globalThis[key](manager); assert.equal(loads, 0);
  enabled = true;
  await globalThis[key](manager); await globalThis[key](manager);
  assert.equal(loads, 1);
  const entry = manager.plugins.get(id);
  assert.equal(entry.id, id); assert.equal(entry.localBootstrap, true);
  assert.equal(entry.entryPath, path.join(root, 'index.mjs'));
});
test('bootstrap patch is exact, idempotent and byte-for-byte reversible without changing allowlist', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtc-local-patch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugins', id); await fs.mkdir(plugin, { recursive: true });
  await fs.writeFile(path.join(plugin, 'index.mjs'), 'export function plugin_init() {}');
  const original = 'const whitelist = new Set(["napcat-plugin-builtin"]);\n// not in official plugin whitelist\nfunction scan() {\n    const n = this.getLoadedPlugins().length;\n}\n';
  const loader = path.join(root, 'loader.cjs');
  await fs.writeFile(path.join(root, 'napcat.mjs'), original); await fs.writeFile(loader, '"use strict";\n// original loader\n');
  const script = fileURLToPath(new URL('../scripts/enable-local-plugin.py', import.meta.url));
  const run = (...extra) => spawnSync('python3', [script, '--napcat-dir', root, '--loader', loader, ...extra], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  const patched = await fs.readFile(path.join(root, 'napcat.mjs'), 'utf8');
  assert.ok(patched.startsWith(original.split('\n')[0]));
  assert.ok(patched.includes('KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1'));
  assert.equal(run('--restore').status, 0);
  assert.equal(await fs.readFile(path.join(root, 'napcat.mjs'), 'utf8'), original);
  assert.equal(await fs.readFile(loader, 'utf8'), '"use strict";\n// original loader\n');
});

test('fresh worker importing napcat.mjs directly initializes its local bootstrap without the Electron parent loader', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtc-local-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugins', id); await fs.mkdir(plugin, { recursive: true });
  await fs.writeFile(path.join(plugin, 'index.mjs'), 'export function plugin_init() {}');
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: id, main: 'index.mjs' }));
  const source = `// not in official plugin whitelist
class Manager {
  plugins = new Map();
  getPluginConfig() { return { 'napcat-plugin-koishi-rtc-qq': true }; }
  getPluginInfo(id) { return this.plugins.get(id); }
  getLoadedPlugins() { return [...this.plugins.values()].filter(p => p.loaded); }
  async loadPlugin(entry) { entry.loaded = true; return true; }
  async scan() {
    const n = this.getLoadedPlugins().length;
    return n;
  }
}
console.log('WORKER_LOADED', await new Manager().scan());
`;
  await fs.writeFile(path.join(root, 'napcat.mjs'), source);
  const loader = path.join(root, 'parent.cjs'); await fs.writeFile(loader, '// parent is never executed in this test\n');
  const script = fileURLToPath(new URL('../scripts/enable-local-plugin.py', import.meta.url));
  const patch = spawnSync('python3', [script, '--napcat-dir', root, '--loader', loader], { encoding: 'utf8' });
  assert.equal(patch.status, 0, patch.stderr);
  const worker = spawnSync(process.execPath, [path.join(root, 'napcat.mjs')], { encoding: 'utf8' });
  assert.equal(worker.status, 0, worker.stderr);
  // Inherited FORCE_COLOR can decorate the numeric console.log argument.
  assert.match(stripVTControlCharacters(worker.stdout), /^WORKER_LOADED 1$/m);
});
