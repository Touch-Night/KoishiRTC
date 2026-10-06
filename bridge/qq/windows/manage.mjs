// SPDX-License-Identifier: GPL-3.0-only
// File preparation never executes QQ, its DLLs, or NapCat. Only `run-*` does.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const qqBridgeSource = path.dirname(here);
export const PROFILE = JSON.parse(fs.readFileSync(path.join(here, 'profile.json'), 'utf8'));
const pluginName = 'napcat-plugin-koishi-rtc-qq';
const json = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const exists = filename => fs.existsSync(filename);
export const MEDIA_RUNTIME_FILES = ['audio/common.mjs', 'video/index.mjs', 'video/source.mjs',
  'video/protocol.mjs', 'video/queue.mjs', 'video/virtual-camera.mjs', 'video/demo.mjs',
  'video/virtual_camera_worker.py', 'video/requirements.txt'];
export function mediaRuntimeFiles(source = qqBridgeSource) {
  const root = exists(path.join(source, 'video/index.mjs')) ? source : path.dirname(source);
  return MEDIA_RUNTIME_FILES.map(relative => {
    const filename = file(path.join(root, relative));
    if (fs.realpathSync(filename) !== filename) throw new Error(`Media runtime source must not use symbolic links: ${filename}`);
    return { relative, filename };
  });
}
export function copyMediaRuntime(source, target) {
  const files = mediaRuntimeFiles(source); // Preflight every file before writing.
  for (const { relative, filename } of files) {
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(filename, destination);
  }
}
function file(filename) {
  if (!exists(filename) || !fs.lstatSync(filename).isFile()) throw new Error(`Required ordinary file missing: ${filename}`);
  return filename;
}
function writeJson(filename, value) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n'); }
function contained(parent, child) { const relative = path.relative(parent, child); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function tcpPort(value, fallback) { const result = Number(value ?? fallback); if (!Number.isInteger(result) || result < 1024 || result > 65535) throw new Error('Choose a port from 1024 to 65535'); return result; }

export function peMachine(filename) {
  const fd = fs.openSync(file(filename), 'r');
  try {
    const header = Buffer.alloc(64); if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid PE header');
    const offset = header.readUInt32LE(60), pe = Buffer.alloc(6);
    if (offset > 16 * 1024 * 1024 || fs.readSync(fd, pe, 0, 6, offset) !== 6 || pe.readUInt32LE(0) !== 0x4550) throw new Error('Invalid PE signature');
    return ({ 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' })[pe.readUInt16LE(4)] ?? 'unknown';
  } finally { fs.closeSync(fd); }
}

export function inspectQQ(source, profile = PROFILE) {
  const root = fs.realpathSync(source);
  const versionConfig = json(file(path.join(root, 'versions', 'config.json')));
  if (typeof versionConfig.curVersion !== 'string' || !/^[0-9][0-9.-]+$/.test(versionConfig.curVersion)) throw new Error('Invalid QQ version directory');
  const versionDir = path.join(root, 'versions', versionConfig.curVersion);
  const packageFile = file(path.join(versionDir, 'resources', 'app', 'package.json'));
  const metadata = json(packageFile);
  const library = file(path.join(versionDir, 'resources', 'app', 'avsdk', 'AVSDKPlugin.dll'));
  const launcherArch = peMachine(path.join(root, 'QQ.exe')), runtimeArch = peMachine(path.join(versionDir, 'QQNT.dll'));
  file(path.join(versionDir, 'resources', 'app', 'major.node'));
  for (const dependency of ['liteav.dll', 'txffmpeg.dll', 'txsoundtouch.dll']) file(path.join(path.dirname(library), dependency));
  const arch = peMachine(library), librarySHA256 = hash(library);
  const matched = metadata.version === profile.qqVersion && versionConfig.curVersion === profile.qqVersion &&
    arch === profile.arch && launcherArch === profile.arch && runtimeArch === profile.arch && librarySHA256 === profile.librarySHA256;
  return { root, versionDir, packageFile, qqVersion: metadata.version, arch, launcherArch, runtimeArch, library, librarySHA256,
    profileId: matched ? profile.id : null, matched, runtimeTested: false };
}

function inspectNapCat(source) {
  const root = fs.realpathSync(source);
  for (const name of ['napcat.mjs', 'NapCatWinBootMain.exe', 'NapCatWinBootHook.dll']) file(path.join(root, name));
  if (peMachine(path.join(root, 'NapCatWinBootHook.dll')) !== 'x64') throw new Error('Use the x64 NapCat Shell loader matching QQ x64');
  return root;
}

export function prepareLocalPlugin(napcatDir) {
  const filename = path.join(napcatDir, 'napcat.mjs'), before = fs.readFileSync(filename);
  const original = before.toString('utf8');
  if (!original.includes('not in official plugin whitelist')) return { required: false, officialWhitelistChanged: false };
  const anchor = '    const n = this.getLoadedPlugins().length;';
  if (original.split(anchor).length !== 2 || original.includes('KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1')) throw new Error('Unknown or already modified NapCat whitelist scanner; explicit local plugin hook cannot be prepared');
  // NapCat can fork a utilityProcess which imports this bundle without the QQ
  // parent loader. The explicit bootstrap must also install inside that worker.
  const hook = `    // KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1\n    {\n      const localKey = Symbol.for("koishi-rtc.qq.local-plugin-bootstrap.v1");\n      if (!globalThis[localKey]) {\n        const { default: installLocalBridge } = await import(new URL("./koishi-rtc-bootstrap.cjs", import.meta.url).href);\n        installLocalBridge(${JSON.stringify(path.join(napcatDir, 'plugins', pluginName))});\n      }\n      await globalThis[localKey](this);\n    }\n`;
  const after = original.replace(anchor, hook + anchor);
  const backup = filename + '.before-koishi-rtc-local-plugin';
  if (exists(backup)) throw new Error('Refusing to replace an existing NapCat local-plugin backup');
  const bootstrap = path.join(napcatDir, 'koishi-rtc-bootstrap.cjs');
  if (exists(bootstrap)) throw new Error('Refusing to replace an existing NapCat local bootstrap');
  fs.copyFileSync(file(path.join(qqBridgeSource, 'scripts', 'local-plugin-bootstrap.cjs')), bootstrap);
  fs.writeFileSync(backup, before, { flag: 'wx' }); fs.writeFileSync(filename, after);
  return { required: true, filename, backup, originalSHA256: createHash('sha256').update(before).digest('hex'), patchedSHA256: hash(filename), officialWhitelistChanged: false };
}

function copyTree(source, target, relative = '') {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links/reparse links are not accepted in source packages: ${source}`);
  if (info.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      // Source packages must be clean. Never carry over profiles or credentials.
      if (/^(?:config|logs?|cache|data|plugins|user.?data|qqnt|nt_qq|crashpad)$/i.test(name) && !relative) continue;
      copyTree(path.join(source, name), path.join(target, name), path.join(relative, name));
    }
  } else if (info.isFile()) { fs.copyFileSync(source, target); }
  else throw new Error(`Unsupported source entry: ${source}`);
}

function copyBridgeSources(source, target) {
  // These are our portable scripts, not the official QQ/NapCat distribution.
  // Do not carry local runtime files or compiled binaries from a developer tree.
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (/^(?:runtime|__pycache__|logs?|cache|node_modules)$/i.test(entry.name)) continue;
    const filename = path.join(source, entry.name), destination = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bridge source must not use symbolic links: ${filename}`);
    if (entry.isDirectory()) copyBridgeSources(filename, destination);
    else if (entry.isFile() && /\.(?:mjs|cjs|json|py|sh|ps1|html|md)$/i.test(entry.name)) {
      fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(filename, destination);
    }
  }
}

export function planInstall({ qqSource, napcatSource, installDir, port, avPort }, profile = PROFILE) {
  if (!qqSource || !napcatSource || !installDir) throw new Error('--qq-source, --napcat-source and --install-dir are required');
  const qq = inspectQQ(qqSource, profile), napcat = inspectNapCat(napcatSource), root = path.resolve(installDir);
  if (!qq.matched) throw new Error(`QQ build/hash is not audited: ${qq.qqVersion} ${qq.arch} ${qq.librarySHA256}`);
  if (exists(root)) throw new Error('Installation target must not already exist; choose a new, dedicated directory');
  if (contained(qq.root, root) || contained(napcat, root) || contained(root, qq.root) || contained(root, napcat)) throw new Error('Source and destination directories must be independent');
  if (contained(qqBridgeSource, root) || contained(root, qqBridgeSource)) throw new Error('Install outside the bridge source tree');
  const controlPort = tcpPort(port, 6110), hostPort = tcpPort(avPort, 6111);
  if (controlPort === hostPort) throw new Error('Bridge and AV Host ports must differ');
  mediaRuntimeFiles();
  return { qq, napcat, root, controlPort, avPort: hostPort, startsProcesses: false, altersSource: false, runtimeTested: false, mediaRuntimeFiles: [...MEDIA_RUNTIME_FILES] };
}

export function install(options, profile = PROFILE) {
  const plan = planInstall(options, profile);
  if (options.check) return plan;
  const root = plan.root, runtime = path.join(root, 'runtime'), qqRoot = path.join(root, 'QQ'), napcatDir = path.join(root, 'NapCat');
  fs.mkdirSync(root); // exclusive: a concurrent installer cannot adopt someone else's directory
  try {
    fs.mkdirSync(path.join(qqRoot, 'versions'), { recursive: true });
    // Preserve the entire matching current runtime; do not mix DLLs across QQ builds.
    for (const name of fs.readdirSync(plan.qq.root)) if (/\.(?:exe|dll)$/i.test(name)) fs.copyFileSync(file(path.join(plan.qq.root, name)), path.join(qqRoot, name));
    copyTree(plan.qq.versionDir, path.join(qqRoot, 'versions', plan.qq.qqVersion));
    writeJson(path.join(qqRoot, 'versions', 'config.json'), { baseVersion: plan.qq.qqVersion, curVersion: plan.qq.qqVersion, prevVersion: '', onErrorVersions: [], buildId: plan.qq.qqVersion.split('-')[1], unzipRetryCount: 0 });
    copyTree(plan.napcat, napcatDir);
    for (const folder of ['windows', 'av-host', 'napcat-plugin', 'scripts']) copyBridgeSources(path.join(qqBridgeSource, folder), path.join(root, folder));
    copyMediaRuntime(qqBridgeSource, root);
    // The host's optional route modules live beside av-host in each platform directory.
    if (exists(path.join(qqBridgeSource, 'macos'))) copyBridgeSources(path.join(qqBridgeSource, 'macos'), path.join(root, 'macos'));
    if (exists(path.join(qqBridgeSource, 'ATTRIBUTION.md'))) fs.copyFileSync(path.join(qqBridgeSource, 'ATTRIBUTION.md'), path.join(root, 'ATTRIBUTION.md'));
    fs.mkdirSync(runtime, { mode: 0o700 });
    const tokenFile = path.join(runtime, 'control.token');
    fs.writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    const versionDir = path.join(qqRoot, 'versions', plan.qq.qqVersion);
    const packagePatch = { ...json(plan.qq.packageFile), main: './loadNapCat.js' };
    delete packagePatch.type;
    writeJson(path.join(runtime, 'qqnt.json'), packagePatch);
    const localPlugin = prepareLocalPlugin(napcatDir);
    const loader = `// KoishiRTC isolated NapCat WinBoot entry. Source installations are unchanged.\n'use strict';\nconst { app } = require('electron');\nconst path = require('node:path');\nconst root = process.env.KOISHI_RTC_QQ_BRIDGE_DIR;\nif (!root) throw new Error('Missing isolated bridge directory');\napp.setPath('userData', path.join(root, 'runtime', process.env.KOISHI_RTC_QQ_AV_HOST === '1' ? 'av-host-profile' : 'qq-electron-profile'));\nif (process.env.KOISHI_RTC_QQ_AV_HOST === '1') {\n  require(path.join(root, 'av-host', 'host.cjs'));\n} else {\n  ${localPlugin.required ? "require(path.join(root, 'scripts', 'local-plugin-bootstrap.cjs'))(path.join(root, 'NapCat', 'plugins', 'napcat-plugin-koishi-rtc-qq'));" : '// This NapCat build has no recognized official-only plugin scanner.'}\n  import(require('node:url').pathToFileURL(path.join(root, 'NapCat', 'napcat.mjs')).href).catch(error => { console.error(error); app.exit(1); });\n}\n`;
    fs.writeFileSync(path.join(runtime, 'loadNapCat.js'), loader);
    const pluginDir = path.join(napcatDir, 'plugins', pluginName);
    copyTree(path.join(qqBridgeSource, 'napcat-plugin'), pluginDir);
    writeJson(path.join(pluginDir, 'bridge-config.json'), { controlHost: '127.0.0.1', controlPort: plan.controlPort,
      avHost: '127.0.0.1', avPort: plan.avPort, mediaEnabled: true, tokenFile });
    writeJson(path.join(napcatDir, 'config', 'plugins.json'), { [pluginName]: true });
    const manifest = { schemaVersion: 1, kind: 'koishi-rtc-qq-windows', installDir: root, qqRoot, qqDir: versionDir, napcatDir,
      tokenFile, controlPort: plan.controlPort, avPort: plan.avPort, profileId: profile.id, createdAt: new Date().toISOString(), runtimeTested: false, localPlugin,
      managed: { [path.relative(root, path.join(pluginDir, 'bridge-config.json'))]: hash(path.join(pluginDir, 'bridge-config.json')),
        [path.join('runtime', 'loadNapCat.js')]: hash(path.join(runtime, 'loadNapCat.js')),
        [path.join('runtime', 'qqnt.json')]: hash(path.join(runtime, 'qqnt.json')) } };
    writeJson(path.join(runtime, 'install-manifest.json'), manifest);
    return { ok: true, installDir: root, profileId: profile.id, tokenFile, startsProcesses: false, altersSource: false, runtimeTested: false };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

export function loadInstall(installDir) {
  const root = fs.realpathSync(installDir), manifest = json(file(path.join(root, 'runtime', 'install-manifest.json')));
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'koishi-rtc-qq-windows' || typeof manifest.installDir !== 'string' || normalized(manifest.installDir) !== normalized(root)) throw new Error('Unknown or moved installation; use the original absolute path');
  for (const key of ['qqRoot', 'qqDir', 'napcatDir', 'tokenFile']) if (typeof manifest[key] !== 'string' || !contained(root, path.resolve(manifest[key]))) throw new Error('Manifest path escapes installation');
  return manifest;
}

export function doctor(options) {
  const m = options.installDir ? loadInstall(options.installDir) : null;
  const qq = inspectQQ(m?.qqRoot ?? options.qqSource);
  const napcatDir = inspectNapCat(m?.napcatDir ?? options.napcatSource);
  return { ok: qq.matched, qq, napcatDir, node: process.versions.node, hostPlatform: process.platform,
    hostArch: process.arch, runtimeTested: false, isolatedEntry: m ? exists(path.join(m.installDir, 'runtime', 'loadNapCat.js')) : null,
    tokenPresent: m ? exists(m.tokenFile) && fs.statSync(m.tokenFile).size >= 32 : false,
    notes: ['Static files only: this does not test PPAPI loading, login, a call, or audio.',
      'Use Windows 10/11 x64, Node 22.19+ x64 and the Microsoft VC++ 2015-2022 x64 runtime.',
      'Configure two explicit virtual audio buses in both AVSDK and the PCM bridge.'] };
}

export function disable(installDir) {
  const m = loadInstall(installDir), config = path.join(m.napcatDir, 'config', 'plugins.json');
  const existing = exists(config) ? json(config) : {};
  existing[pluginName] = false; writeJson(config, existing);
  // Keep QQ/account data and binaries. Disable the generated native host entry too.
  const entry = path.join(m.installDir, 'runtime', 'loadNapCat.js');
  const expected = m.managed[path.join('runtime', 'loadNapCat.js')];
  let entryDisabled = false;
  if (exists(entry) && hash(entry) === expected) { fs.renameSync(entry, entry + '.disabled'); entryDisabled = true; }
  let localPluginRestored = false;
  const hook = m.localPlugin;
  if (hook?.required && contained(m.installDir, path.resolve(hook.filename)) && contained(m.installDir, path.resolve(hook.backup)) &&
      exists(hook.filename) && exists(hook.backup) && hash(hook.filename) === hook.patchedSHA256 && hash(hook.backup) === hook.originalSHA256) {
    fs.copyFileSync(hook.backup, hook.filename); localPluginRestored = true;
  }
  return { ok: true, pluginEnabled: false, entryDisabled, localPluginRestored, retained: 'All program files, token, logs, and account data; no processes stopped' };
}

export function environment(m, role) {
  const runtime = path.join(m.installDir, 'runtime');
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (/^(?:KOISHI_RTC_QQ_|NAPCAT_)/i.test(key) || key.toLowerCase() === 'path') delete inherited[key];
  const env = { ...inherited, KOISHI_RTC_QQ_BRIDGE_DIR: m.installDir, KOISHI_RTC_QQ_QQ_DIR: m.qqDir,
    KOISHI_RTC_QQ_AVSDK_PATH: path.join(m.qqDir, 'resources', 'app', 'avsdk', 'AVSDKPlugin.dll'),
    KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE: m.tokenFile, KOISHI_RTC_QQ_BRIDGE_PORT: String(m.controlPort), KOISHI_RTC_QQ_AV_HOST_PORT: String(m.avPort),
    KOISHI_RTC_QQ_BRIDGE_HOST: '127.0.0.1', KOISHI_RTC_QQ_AV_HOST_HOST: '127.0.0.1', KOISHI_RTC_QQ_MEDIA_ENABLED: 'true',
    KOISHI_RTC_QQ_AV_HOST: role === 'av-host' ? '1' : '0',
    NAPCAT_PATCH_PACKAGE: path.join(runtime, 'qqnt.json'), NAPCAT_LOAD_PATH: path.join(runtime, 'loadNapCat.js'),
    NAPCAT_INJECT_PATH: path.join(m.napcatDir, 'NapCatWinBootHook.dll'), NAPCAT_LAUNCHER_PATH: path.join(m.napcatDir, 'NapCatWinBootMain.exe'),
    NAPCAT_MAIN_PATH: path.join(m.napcatDir, 'napcat.mjs'),
    PATH: [path.join(m.qqDir, 'resources', 'app', 'avsdk'), m.qqDir, process.env.PATH ?? ''].join(path.delimiter) };
  return env;
}

async function vacant(port) { await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error(`Port ${port} is already in use; no process was stopped`))); server.listen(port, '127.0.0.1', () => server.close(resolve)); }); }
async function run(installDir, role) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Launching is available only on Windows x64');
  const m = loadInstall(installDir), inspection = inspectQQ(m.qqRoot);
  if (!inspection.matched) throw new Error('QQ files changed after installation; native profile no longer matches');
  inspectNapCat(m.napcatDir); file(path.join(m.installDir, 'runtime', 'loadNapCat.js'));
  await vacant(role === 'av-host' ? m.avPort : m.controlPort);
  const env = environment(m, role);
  // Never use shell/cmd parsing, global QQ registry discovery, killall, or restart loops.
  const child = spawn(env.NAPCAT_LAUNCHER_PATH, [path.join(m.qqRoot, 'QQ.exe'), env.NAPCAT_INJECT_PATH,
    '--user-data-dir=' + path.join(m.installDir, 'runtime', role === 'av-host' ? 'av-host-profile' : 'qq-electron-profile')],
  { env, cwd: m.napcatDir, stdio: 'inherit', shell: false, windowsHide: false });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { process.exitCode = code ?? 1; resolve(); }); });
  // Some loader versions detach QQ. A launcher exit is never reported as QQ success.
  console.error('NapCat boot process exited. Inspect authenticated status; exit alone does not prove that QQ or AVSDK started.');
}

export async function control(options) {
  const m = loadInstall(options.installDir), action = options.action ?? 'status';
  const hostRoutes = { devices: ['/v1/audio/devices', 'GET'], route: ['/v1/audio/route', 'POST'], 'host-status': ['/v1/status', 'GET'] };
  const bridgeRoutes = { status: ['/v1/status', 'GET'], capabilities: ['/v1/capabilities', 'GET'], current: ['/v1/calls/current', 'GET'], groups: ['/v1/groups/current', 'GET'], events: ['/v1/events', 'GET'],
    accept: ['/v1/calls/accept', 'POST'], reject: ['/v1/calls/reject', 'POST'], dial: ['/v1/calls/dial', 'POST'], hangup: ['/v1/calls/hangup', 'POST'], 'group-join': ['/v1/groups/join', 'POST'], 'group-leave': ['/v1/groups/leave', 'POST'] };
  const route = hostRoutes[action] ?? bridgeRoutes[action]; if (!route) throw new Error('Unknown explicit control action');
  const [url, method] = route, body = method === 'POST' ? json(file(options.bodyFile)) : undefined;
  if (method === 'POST' && action !== 'route' && (typeof body.requestId !== 'string' || !body.requestId)) throw new Error('Body requires a stable requestId; never generate a different ID to retry an unknown outcome');
  const response = await fetch(`http://127.0.0.1:${hostRoutes[action] ? m.avPort : m.controlPort}${url}`, { method,
    headers: { Authorization: `Bearer ${fs.readFileSync(m.tokenFile, 'utf8').trim()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const result = await response.json(); if (!response.ok) { const error = new Error(result?.error?.message ?? result.message ?? `HTTP ${response.status}`); error.result = result; throw error; }
  return result;
}

function args(argv) {
  const result = { operation: argv.shift() };
  const names = { 'qq-source': 'qqSource', 'napcat-source': 'napcatSource', 'install-dir': 'installDir', 'av-port': 'avPort', 'body-file': 'bodyFile', action: 'action', port: 'port' };
  while (argv.length) { const key = argv.shift(); if (key === '--check') result.check = true;
    else if (names[key?.replace(/^--/, '')] && argv.length) result[names[key.slice(2)]] = argv.shift(); else throw new Error(`Unknown or incomplete argument: ${key}`); }
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = args(process.argv.slice(2)); let result;
    if (options.operation === 'install') result = install(options);
    else if (options.operation === 'doctor') result = doctor(options);
    else if (options.operation === 'disable') result = disable(options.installDir);
    else if (options.operation === 'control') result = await control(options);
    else if (options.operation === 'run-av-host' || options.operation === 'run-napcat') await run(options.installDir, options.operation.slice(4));
    else throw new Error('Use install, doctor, run-av-host, run-napcat, control, or disable');
    if (result) console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, ...(error.result ? { result: error.result } : {}) }, null, 2)); process.exitCode = 1; }
}
