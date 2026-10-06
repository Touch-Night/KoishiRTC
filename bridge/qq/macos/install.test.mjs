// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const id = 'napcat-plugin-koishi-rtc-qq';
// The fixture is executable JavaScript written by this test, never QQ/NapCat code.
const worker = `import fs from 'node:fs';
const officialWhitelist = new Set(['napcat-plugin-builtin']);
// not in official plugin whitelist
class Manager {
  plugins = new Map();
  getPluginConfig() { return JSON.parse(fs.readFileSync(new URL('./config/plugins.json', import.meta.url))); }
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
const originalMain = './application.asar/app_launcher/index.js';
const loader = '"use strict";\nmodule.exports = import("./napcat.mjs");\n';
// Emulate only macOS file-copy/signing commands. Any attempt to launch an app,
// execute a third-party binary or run an unexpected program fails this test.
const python = String.raw`
import json, pathlib, shutil, subprocess, sys
sys.path.insert(0, sys.argv[1])
import install as installer
request = json.loads(sys.argv[2])
real_run = subprocess.run
installer.platform.system = lambda: 'Darwin'
installer.shutil.which = lambda command: '/fixture/' + command

def run(command, **kwargs):
    if command[0] == 'ditto':
        shutil.copytree(command[1], command[2], symlinks=True)
        return subprocess.CompletedProcess(command, 0)
    if command[0] == 'codesign':
        if '--force' in command:
            assert '--deep' not in command, 'Do not recursively change native library signatures'
            if request.get('changeSDK'):
                with (pathlib.Path(command[-1]) / 'Contents/Resources/app/avsdk/libAVSDKPlugin.dylib').open('ab') as output: output.write(b'changed signature')
        if request.get('failSign'): raise subprocess.CalledProcessError(1, command)
        return subprocess.CompletedProcess(command, 0)
    if command[0] == 'ps':
        return subprocess.CompletedProcess(command, 0, stdout=request.get('processes', ''))
    if command[0] == sys.executable and pathlib.Path(command[1]).name == 'enable-local-plugin.py':
        return real_run(command, **kwargs)
    raise AssertionError('Unexpected process: ' + repr(command))
installer.subprocess.run = run
sys.argv = ['install.py', *request['args']]
sys.exit(installer.main())
`;
function invoke(args, options = {}) {
  return spawnSync('python3', ['-B', '-c', python, here, JSON.stringify({ args, ...options })], { encoding: 'utf8' });
}
function macho(exports = false) {
  const names = ['_PPP_GetInterface', '_PPP_InitializeModule', '_PPP_ShutdownModule'];
  const strings = Buffer.from('\0' + names.join('\0') + '\0');
  const data = Buffer.alloc(exports ? 32 + 24 + names.length * 16 + strings.length : 32);
  [0xfeedfacf, 0x0100000c, 0, exports ? 6 : 2, exports ? 1 : 0, exports ? 24 : 0, 0, 0].forEach((value, i) => data.writeUInt32LE(value, i * 4));
  if (exports) {
    [2, 24, 56, names.length, 104, strings.length].forEach((value, i) => data.writeUInt32LE(value, 32 + i * 4));
    let index = 1;
    names.forEach((name, i) => { data.writeUInt32LE(index, 56 + i * 16); data.writeBigUInt64LE(BigInt(i + 1), 64 + i * 16); index += name.length + 1; });
    strings.copy(data, 104);
  }
  return data;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtc-mac-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'source/QQ.app'), napcat = path.join(root, 'source/NapCat'), dest = path.join(root, 'owned');
  const write = async (relative, bytes) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  await write('source/QQ.app/Contents/Info.plist', '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>QQ</string><key>CFBundleIdentifier</key><string>com.tencent.qq</string></dict></plist>');
  await write('source/QQ.app/Contents/Resources/app/package.json', JSON.stringify({ main: originalMain, version: '7.0.2-53644' }));
  await write('source/QQ.app/Contents/MacOS/QQ', macho());
  await write('source/QQ.app/Contents/Resources/app/avsdk/libAVSDKPlugin.dylib', macho(true));
  for (const name of ['TXFFmpeg', 'TXSoundTouch']) await write(`source/QQ.app/Contents/Resources/app/avsdk/${name}.framework/Versions/A/${name}`, 'fixture dependency, never loaded');
  await write('source/NapCat/napcat.mjs', worker);
  const install = (...extra) => invoke(['install', '--qq-app', app, '--napcat-dir', napcat, '--install-dir', dest, '--adhoc-sign', ...extra]);
  const restore = (...extra) => invoke(['restore-bootstrap', '--install-dir', dest, ...extra]);
  const readJSON = async relative => JSON.parse(await fs.readFile(path.join(dest, relative), 'utf8'));
  return { root, app, napcat, dest, install, restore, readJSON };
}

test('Mac installer dry-run is read-only and the copied worker registers independently of parent globals', async t => {
  const f = await fixture(t);
  const checked = f.install('--check'); assert.equal(checked.status, 0, checked.stderr);
  await assert.rejects(fs.access(f.dest)); assert.match(checked.stdout, /"workerSelfRegisters": true/);
  const installed = f.install(); assert.equal(installed.status, 0, installed.stderr);
  assert.equal(await fs.readFile(path.join(f.napcat, 'napcat.mjs'), 'utf8'), worker);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.app, 'Contents/Resources/app/package.json'))).main, originalMain);
  assert.equal((await f.readJSON('napcat/config/plugins.json'))[id], true);
  const config = await f.readJSON('QQ-RTC.app/Contents/Resources/app/koishi-rtc-bootstrap.json'); assert.equal(config.napcatLoader, path.join(f.dest, 'napcat/koishi-rtc-loader.cjs'));
  const manifest = await f.readJSON('macos-install.json'); assert.equal(manifest.localBootstrap.workerSelfRegisters, true); assert.equal(manifest.localBootstrap.officialWhitelistChanged, false); assert.equal(manifest.runtimeTested, false);
  assert.equal((await fs.stat(path.join(f.dest, 'runtime/control.token'))).mode & 0o777, 0o600);
  for (const file of ['bridge/qq/av-host/profiles.cjs', 'bridge/qq/macos/audio-route.cjs']) await fs.access(path.join(f.dest, file));
  for (const file of ['bridge/audio/common.mjs', 'bridge/video/virtual_camera_worker.py', 'bridge/video/requirements.txt', 'bridge/video/demo.mjs']) await fs.access(path.join(f.dest, file));
  assert.deepEqual(await fs.readdir(path.join(f.dest, 'bridge/audio')), ['common.mjs']);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(f.dest, 'bridge/video/index.mjs')).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  const child = spawnSync(process.execPath, [path.join(f.dest, 'napcat/napcat.mjs')], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /WORKER_LOADED 1/);
  const parent = spawnSync(process.execPath, [config.napcatLoader], { encoding: 'utf8' }); assert.equal(parent.status, 0, parent.stderr); assert.match(parent.stdout, /WORKER_LOADED 1/);
  const bundle = await fs.readFile(path.join(f.dest, 'napcat/napcat.mjs'), 'utf8'); assert.ok(bundle.includes("const officialWhitelist = new Set(['napcat-plugin-builtin']);"));
  const repeat = f.install(); assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /already exists/); assert.equal(await fs.readFile(path.join(f.dest, 'napcat/napcat.mjs'), 'utf8'), bundle);
});

test('Mac bridge source copy excludes nested runtime, credentials and native builds', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtc-mac-source-filter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'copy');
  for (const relative of ['av-host/host.cjs', 'macos/run.py', 'runtime/private.json', 'macos/runtime/video.json', 'av-host/control.token', 'av-host/cache/login.db', 'macos/__pycache__/run.pyc', 'macos/guard.so', 'macos/driver.ko']) {
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fs.writeFile(path.join(source, relative), 'fixture only');
  }
  const code = 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import install; install.copy_bridge_sources(Path(sys.argv[2]),Path(sys.argv[3]))';
  const result = spawnSync('python3', ['-B', '-c', code, here, source, target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const copied = [];
  for (const relative of await fs.readdir(target, { recursive: true })) if ((await fs.stat(path.join(target, relative))).isFile()) copied.push(relative.split(path.sep).join('/'));
  assert.deepEqual(copied.sort(), ['av-host/host.cjs', 'macos/run.py']);
});

test('Mac bootstrap restore preserves unrelated settings and restores the exact owned files', async t => {
  const f = await fixture(t); assert.equal(f.install().status, 0);
  const configFile = path.join(f.dest, 'napcat/config/plugins.json'); await fs.writeFile(configFile, JSON.stringify({ [id]: true, unrelated: true }));
  const before = await fs.readFile(path.join(f.dest, 'napcat/napcat.mjs'));
  const checked = f.restore('--check'); assert.equal(checked.status, 0, checked.stderr); assert.deepEqual(await fs.readFile(path.join(f.dest, 'napcat/napcat.mjs')), before);
  const restored = f.restore(); assert.equal(restored.status, 0, restored.stderr);
  assert.equal(await fs.readFile(path.join(f.dest, 'napcat/napcat.mjs'), 'utf8'), worker);
  assert.equal(await fs.readFile(path.join(f.dest, 'napcat/koishi-rtc-loader.cjs'), 'utf8'), loader);
  assert.deepEqual(await f.readJSON('napcat/config/plugins.json'), { [id]: false, unrelated: true });
  await fs.access(path.join(f.dest, 'napcat/koishi-rtc-local-bootstrap.restored.json'));
  const launch = spawnSync('python3', ['-B', path.join(here, 'run.py'), '--install-dir', f.dest, 'napcat'], { encoding: 'utf8' });
  assert.notEqual(launch.status, 0); assert.match(launch.stderr, /missing or restored/);
  const uninstalled = invoke(['uninstall', '--install-dir', f.dest]); assert.equal(uninstalled.status, 0, uninstalled.stderr); await assert.rejects(fs.access(f.dest)); await fs.access(f.app); await fs.access(f.napcat);
});

test('Mac restoration rejects changed worker/backup files and live owned processes before writing', async t => {
  const f = await fixture(t); assert.equal(f.install().status, 0);
  const busy = invoke(['restore-bootstrap', '--install-dir', f.dest], { processes: path.join(f.dest, 'napcat/worker.mjs') }); assert.notEqual(busy.status, 0); assert.match(busy.stderr, /Close this installation/);
  const manifest = await f.readJSON('napcat/koishi-rtc-local-bootstrap.json');
  const backup = manifest.files[0].backup; const original = await fs.readFile(backup); await fs.appendFile(backup, '\nchanged');
  const badBackup = f.restore(); assert.notEqual(badBackup.status, 0); assert.match(badBackup.stderr, /files or backups changed/);
  await fs.writeFile(backup, original); const bundle = path.join(f.dest, 'napcat/napcat.mjs'); await fs.appendFile(bundle, '\nchanged');
  const badWorker = f.restore(); assert.notEqual(badWorker.status, 0); assert.match(badWorker.stderr, /files or backups changed/);
  assert.equal((await f.readJSON('napcat/config/plugins.json'))[id], true);
  assert.ok((await fs.readFile(bundle, 'utf8')).endsWith('\nchanged'));
});

test('Mac installer refuses unknown/symlinked NapCat bundles and removes only its failed new copy', async t => {
  const f = await fixture(t), bundle = path.join(f.napcat, 'napcat.mjs');
  await fs.writeFile(bundle, '// unrecognized distribution'); const unknown = f.install('--check'); assert.notEqual(unknown.status, 0); assert.match(unknown.stdout, /Unrecognized/); await assert.rejects(fs.access(f.dest));
  await fs.writeFile(bundle, worker); const external = path.join(f.root, 'outside.mjs'); await fs.writeFile(external, worker); await fs.rm(bundle); await fs.symlink(external, bundle);
  const symlink = f.install(); assert.notEqual(symlink.status, 0); assert.match(symlink.stdout, /symbolic links/); assert.equal(await fs.readFile(external, 'utf8'), worker);
  await fs.rm(bundle); await fs.writeFile(bundle, worker);
  const signFailure = invoke(['install', '--qq-app', f.app, '--napcat-dir', f.napcat, '--install-dir', f.dest, '--adhoc-sign'], { failSign: true });
  assert.notEqual(signFailure.status, 0); await assert.rejects(fs.access(f.dest)); assert.equal(await fs.readFile(bundle, 'utf8'), worker); await fs.access(f.app);
  const changedSDK = invoke(['install', '--qq-app', f.app, '--napcat-dir', f.napcat, '--install-dir', f.dest, '--adhoc-sign'], { changeSDK: true });
  assert.notEqual(changedSDK.status, 0); assert.match(changedSDK.stderr, /Signing changed the AVSDK/); await assert.rejects(fs.access(f.dest));
  assert.deepEqual(await fs.readFile(path.join(f.app, 'Contents/Resources/app/avsdk/libAVSDKPlugin.dylib')), macho(true));
});
