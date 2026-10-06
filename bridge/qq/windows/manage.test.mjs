// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inspectQQ, peMachine, install, loadInstall, disable, environment, PROFILE, MEDIA_RUNTIME_FILES, copyMediaRuntime } from './manage.mjs';
import { configureMedia } from './configure-media.mjs';
const write = (filename, data) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, data); };
function pe(machine = 0x8664) { const b = Buffer.alloc(100); b.write('MZ'); b.writeUInt32LE(64, 60); b.writeUInt32LE(0x4550, 64); b.writeUInt16LE(machine, 68); return b; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-win-offline-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const qq = path.join(root, 'QQ source 中文'), napcat = path.join(root, 'NapCat source'), target = path.join(root, 'Isolated new copy');
  const version = path.join(qq, 'versions', PROFILE.qqVersion), dll = pe();
  write(path.join(qq, 'QQ.exe'), pe()); write(path.join(qq, 'versions/config.json'), JSON.stringify({ curVersion: PROFILE.qqVersion }));
  write(path.join(version, 'QQNT.dll'), pe()); write(path.join(version, 'resources/app/package.json'), JSON.stringify({ version: PROFILE.qqVersion, main: './application.asar/app_launcher/index.js' }));
  write(path.join(version, 'resources/app/major.node'), 'fixture-not-executable');
  for (const name of ['AVSDKPlugin.dll', 'liteav.dll', 'txffmpeg.dll', 'txsoundtouch.dll']) write(path.join(version, 'resources/app/avsdk', name), dll);
  write(path.join(napcat, 'napcat.mjs'), '// offline fixture; never imported');
  write(path.join(napcat, 'NapCatWinBootMain.exe'), pe()); write(path.join(napcat, 'NapCatWinBootHook.dll'), pe());
  write(path.join(napcat, 'config/private-account.json'), 'do not copy'); write(path.join(napcat, 'logs/private.log'), 'do not copy');
  return { root, qq, napcat, target, profile: { ...PROFILE, librarySHA256: createHash('sha256').update(dll).digest('hex') }, options: { qqSource: qq, napcatSource: napcat, installDir: target } };
}
test('read-only inspection pins PE architecture, exact QQ version, and DLL digest', t => {
  const f = fixture(t); assert.equal(inspectQQ(f.qq, f.profile).matched, true); assert.equal(inspectQQ(f.qq).matched, false);
  assert.equal(peMachine(path.join(f.napcat, 'NapCatWinBootHook.dll')), 'x64');
  const invalid = path.join(f.root, 'bad.dll'); write(invalid, 'not a PE'); assert.throws(() => peMachine(invalid), /Invalid PE/);
});
test('check and install never modify sources or copy account configurations', t => {
  const f = fixture(t); const sourcePackage = path.join(f.qq, 'versions', PROFILE.qqVersion, 'resources/app/package.json');
  const before = fs.readFileSync(sourcePackage, 'utf8'); const plan = install({ ...f.options, check: true }, f.profile);
  assert.equal(plan.startsProcesses, false); assert.equal(fs.existsSync(f.target), false);
  const result = install(f.options, f.profile); assert.equal(result.altersSource, false); assert.equal(result.runtimeTested, false);
  assert.equal(fs.readFileSync(sourcePackage, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.target, 'NapCat/config/private-account.json')), false);
  assert.equal(fs.existsSync(path.join(f.target, 'NapCat/logs/private.log')), false);
  for (const relative of MEDIA_RUNTIME_FILES) assert.equal(fs.existsSync(path.join(f.target, relative)), true, relative);
  assert.equal(fs.existsSync(path.join(f.target, 'windows/rtc-qq.ps1')), true);
  for (const folder of ['windows', 'macos', 'av-host', 'scripts']) assert.equal(fs.readdirSync(path.join(f.target, folder), { recursive: true }).some(name => /(?:^|[\\/])(?:runtime|__pycache__)(?:[\\/]|$)|\.(?:so|dll|ko|token|pyc)$/.test(name)), false, folder);
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(f.target, 'video/index.mjs')).href)})`]);
  const m = loadInstall(f.target), token = fs.readFileSync(m.tokenFile, 'utf8').trim(); assert.equal(token.length, 64);
  assert.equal(JSON.stringify(result).includes(token), false);
  const patch = JSON.parse(fs.readFileSync(path.join(f.target, 'runtime/qqnt.json'), 'utf8'));
  assert.equal(patch.main, './loadNapCat.js'); assert.equal(patch.version, PROFILE.qqVersion);
  const env = environment(m, 'av-host'); assert.equal(env.KOISHI_RTC_QQ_AV_HOST, '1');
  assert.equal(env.KOISHI_RTC_QQ_QQ_DIR, path.join(f.target, 'QQ/versions', PROFILE.qqVersion));
  assert.equal(env.NAPCAT_LOAD_PATH, path.join(f.target, 'runtime/loadNapCat.js'));
  assert.throws(() => install(f.options, f.profile), /must not already exist/);
});
test('media runtime copying excludes credentials, caches and host native binaries', t => {
  const f = fixture(t), source = path.join(f.root, 'media-source'), target = path.join(f.root, 'media-target');
  for (const relative of MEDIA_RUNTIME_FILES) write(path.join(source, relative), '// test fixture');
  for (const relative of ['video/runtime/control.token', 'video/cache/login.db', 'video/__pycache__/worker.pyc', 'video/driver.ko', 'audio/pulse-no-move.so', 'audio/foreign.dll', 'audio/runtime/.env']) write(path.join(source, relative), 'never-copy-canary');
  copyMediaRuntime(source, target);
  const actual = fs.readdirSync(target, { recursive: true }).filter(relative => fs.statSync(path.join(target, relative)).isFile()).map(relative => relative.split(path.sep).join('/')).sort();
  assert.deepEqual(actual, [...MEDIA_RUNTIME_FILES].sort());
  fs.unlinkSync(path.join(source, 'video/requirements.txt'));
  assert.throws(() => copyMediaRuntime(source, path.join(f.root, 'incomplete-target')), /missing/);
  assert.equal(fs.existsSync(path.join(f.root, 'incomplete-target')), false);
});
test('unknown native library, duplicate ports, and wrong loader architecture fail before writes', t => {
  const f = fixture(t); assert.throws(() => install(f.options), /not audited/);
  assert.throws(() => install({ ...f.options, port: 6110, avPort: 6110 }, f.profile), /differ/);
  write(path.join(f.napcat, 'NapCatWinBootHook.dll'), pe(0x14c));
  assert.throws(() => install(f.options, f.profile), /x64/); assert.equal(fs.existsSync(f.target), false);
});
test('disable only disables own entry and plugin; retains accounts and changed user files', t => {
  const f = fixture(t); install(f.options, f.profile); const m = loadInstall(f.target);
  write(path.join(f.target, 'runtime/qq-electron-profile/account'), 'retained');
  const result = disable(f.target); assert.equal(result.entryDisabled, true);
  assert.equal(fs.existsSync(path.join(f.target, 'runtime/loadNapCat.js.disabled')), true);
  assert.equal(fs.readFileSync(path.join(f.target, 'runtime/qq-electron-profile/account'), 'utf8'), 'retained');
  assert.equal(fs.existsSync(m.tokenFile), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.napcatDir, 'config/plugins.json'), 'utf8'))['napcat-plugin-koishi-rtc-qq'], false);
});
test('disable leaves a modified loader for manual review', t => {
  const f = fixture(t); install(f.options, f.profile);
  const loader = path.join(f.target, 'runtime/loadNapCat.js'); fs.appendFileSync(loader, '// user edit');
  assert.equal(disable(f.target).entryDisabled, false); assert.equal(fs.existsSync(loader), true);
});
test('official-only NapCat builds use an explicit local hook and restore the matching original', t => {
  const f = fixture(t), bundle = path.join(f.napcat, 'napcat.mjs');
  const original = '// not in official plugin whitelist\n    const n = this.getLoadedPlugins().length;\n'; write(bundle, original);
  install(f.options, f.profile); const m = loadInstall(f.target);
  assert.equal(m.localPlugin.required, true); assert.equal(m.localPlugin.officialWhitelistChanged, false);
  assert.equal(fs.readFileSync(bundle, 'utf8'), original);
  assert.match(fs.readFileSync(m.localPlugin.filename, 'utf8'), /koishi-rtc.qq.local-plugin-bootstrap.v1/);
  assert.match(fs.readFileSync(path.join(f.target, 'runtime/loadNapCat.js'), 'utf8'), /local-plugin-bootstrap.cjs/);
  assert.equal(disable(f.target).localPluginRestored, true);
  assert.equal(fs.readFileSync(m.localPlugin.filename, 'utf8'), original);
});
test('unrecognized NapCat whitelist scanner leaves no partial installation', t => {
  const f = fixture(t); write(path.join(f.napcat, 'napcat.mjs'), '// not in official plugin whitelist; unknown scanner');
  assert.throws(() => install(f.options, f.profile), /Unknown/); assert.equal(fs.existsSync(f.target), false);
});
test('explicit local bootstrap also runs when a fresh worker directly imports the copied bundle', t => {
  const f = fixture(t), bundle = path.join(f.napcat, 'napcat.mjs');
  write(bundle, `// not in official plugin whitelist\nexport class Manager {\n  constructor() { this.plugins = new Map(); }\n  getPluginConfig() { return { 'napcat-plugin-koishi-rtc-qq': true }; }\n  getPluginInfo(id) { return this.plugins.get(id); }\n  getLoadedPlugins() { return [...this.plugins.values()].filter(p => p.loaded); }\n  async loadPlugin(entry) { entry.loaded = true; return true; }\n  async scanAndLoadPlugins() {\n    const n = this.getLoadedPlugins().length;\n    return n;\n  }\n}\n`);
  install(f.options, f.profile); const m = loadInstall(f.target);
  const childScript = `import(${JSON.stringify(pathToFileURL(path.join(m.napcatDir, 'napcat.mjs')).href)}).then(async ({Manager})=>{const m=new Manager();if(await m.scanAndLoadPlugins()!==1)throw Error('worker missed local plugin');console.log('worker bootstrap ok');}).catch(e=>{console.error(e);process.exitCode=1})`;
  assert.match(execFileSync(process.execPath, ['-e', childScript], { encoding: 'utf8' }), /worker bootstrap ok/);
});
test('media helper writes only new private configs with matching identity/token and inactive devices', t => {
  const f = fixture(t); install(f.options, f.profile);
  const python = path.join(f.root, 'venv/Scripts/python.exe'); write(python, 'not-executed');
  const options = { installDir: f.target, selfId: '123456789', python, consoleDir: path.join(f.root, 'new-console') };
  const result = configureMedia(options), media = JSON.parse(fs.readFileSync(result.files.mediaConfig, 'utf8'));
  const config = JSON.parse(fs.readFileSync(result.files.consoleConfig, 'utf8')), token = fs.readFileSync(result.files.mediaToken, 'utf8').trim();
  assert.equal(media.account.selfId, options.selfId); assert.equal(media.audio.inputDevice, ''); assert.equal(media.audio.outputDevice, '');
  assert.equal(config.plugin.bridges[0].token, token); assert.equal(config.plugin.bridges[0].selfId, options.selfId);
  assert.equal(JSON.stringify(result).includes(token), false); assert.equal(JSON.stringify(result).includes(config.password), false);
  assert.equal(result.processesStarted, false); assert.equal(result.audioConfigured, false);
  const before = fs.readFileSync(result.files.consoleConfig, 'utf8');
  assert.throws(() => configureMedia(options), /already exists/); assert.equal(fs.readFileSync(result.files.consoleConfig, 'utf8'), before);
});
