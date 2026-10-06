#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Dependency-free source + prebuilt distribution ZIP; never traverses runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.npmignore', '.gitignore'];
const trees = ['src', 'client', 'dist', 'docs', 'scripts', 'test', 'examples', 'bridge/audio', 'bridge/video', 'bridge/telegram', 'bridge/desktop',
  'bridge/qq/av-host', 'bridge/qq/macos', 'bridge/qq/napcat-plugin', 'bridge/qq/scripts', 'bridge/qq/tests', 'bridge/qq/windows'];
const bridgeFiles = ['bridge/.npmignore', 'bridge/daemon.mjs', 'bridge/qq/desktop-video-evidence.json', 'bridge/qq/README.md', 'bridge/qq/ATTRIBUTION.md', 'bridge/qq/native-evidence.json', 'bridge/qq/gui-enum-evidence.json', 'bridge/qq/linux-x64-evidence.json', 'bridge/qq/video-native-evidence.json', 'bridge/qq/video-linux-x64-evidence.json'];
// This checked-in example compiler config is source, not a user configuration.
const sourceConfigurations = new Set(['examples/tsconfig.json', 'examples/tsconfig.check.json', 'bridge/qq/desktop-video-evidence.json']);
for (const app of ['wechat', 'feishu', 'tencent-meeting']) for (const os of ['linux', 'win32', 'darwin']) sourceConfigurations.add(`bridge/desktop/profiles/${app}-${os}.json`);
const requiredFiles = [
  '.npmignore', '.gitignore', 'bridge/.npmignore',
  'dist/index.cjs', 'dist/index.js', 'dist/client/index.js', 'scripts/run-local-console.cjs',
  'bridge/audio/qq-pulse-guard.c', 'bridge/audio/build-qq-pulse-guard.mjs',
  'bridge/audio/pulse-no-move.c', 'bridge/audio/build-pulse-shim.mjs',
  'bridge/audio/portaudio_worker.py', 'bridge/audio/requirements.txt',
  'bridge/qq/av-host/host.cjs', 'bridge/qq/av-host/host.html', 'bridge/qq/av-host/profiles.cjs',
  'bridge/qq/linux-x64-evidence.json', 'bridge/qq/video-native-evidence.json', 'bridge/qq/video-linux-x64-evidence.json',
  'bridge/qq/av-host/jpeg.cjs', 'bridge/qq/av-host/camera-size.cjs',
  'bridge/qq/av-host/frame-layout.cjs', 'bridge/qq/av-host/frame-output-renderer.cjs',
  'examples/tsconfig.check.json',
  'bridge/qq/av-host/desktop-video.cjs', 'bridge/qq/av-host/capture-output.html', 'bridge/qq/av-host/capture-output.cjs', 'bridge/qq/scripts/configure-video.mjs',
  'bridge/telegram/sidecar.py', 'bridge/telegram/setup.py', 'bridge/telegram/login.py', 'bridge/telegram/requirements.txt',
  'bridge/desktop/control.mjs', 'bridge/desktop/accessibility_worker.py', 'bridge/desktop/setup.mjs', 'bridge/desktop/requirements.txt',
  'bridge/qq/scripts/install.py', 'bridge/qq/scripts/doctor.sh', 'bridge/qq/scripts/run-av-host.sh',
  'bridge/qq/scripts/enable-local-plugin.py', 'bridge/qq/scripts/local-plugin-bootstrap.cjs',
  'bridge/qq/windows/rtc-qq.ps1', 'bridge/qq/windows/manage.mjs', 'bridge/qq/windows/configure-media.mjs',
  'bridge/qq/windows/fetch-qq.mjs', 'bridge/qq/windows/route-guard.cjs', 'bridge/qq/windows/profile.json',
  'bridge/qq/windows/native-evidence.json', 'bridge/qq/macos/audio-route.cjs', 'bridge/qq/macos/audio-check.py',
  'bridge/qq/macos/entry.cjs', 'bridge/qq/macos/host.cjs', 'bridge/qq/macos/install.py',
  'bridge/qq/macos/run.py', 'bridge/qq/macos/probe.py', 'bridge/qq/macos/native-evidence.json',
  'examples/README.md', 'examples/pcm-consumer.ts', 'examples/tsconfig.json',
  'docs/windows-quickstart.md', 'docs/qq-windows.md', 'docs/audio-setup.md',
];
const extensions = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.vue', '.json', '.map', '.css', '.html', '.md', '.txt', '.py', '.c', '.h', '.sh', '.ps1', '.yaml', '.yml']);
// Only these reviewed documentation images may accompany source files.
const documentationImages = new Set(['docs/images/webui-overview.png', 'docs/images/webui-video.png', 'docs/images/webui-mobile.png']);
const blockedParts = /^(?:runtime|node_modules|\.git|\.venv(?:[-_].*)?|venv|__pycache__|logs?|cache|data|qqnt|nt_qq|artifacts|releases|downloads?)$/i;
const blockedNames = /(?:^\.env(?:\.|$)|(?:^|[._-])(?:token|secret|password|credentials|cookies?|session)(?:[._-]|$)|(?:^|[._-])(?:local|user)[._-]config(?:\.|$)|\.db(?:-|$)|\.sqlite(?:3)?(?:-|$)|\.(?:so(?:\.\d+)*|dll|dylib|exe|node|pyc|pyo|zip|tgz|tar|gz|7z|asar|pem|key|log)$)/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function collectFiles(base = root) {
  const entries = [], excluded = new Map();
  const skip = reason => excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
  function add(relative, required = false) {
    const filename = path.join(base, relative);
    if (!fs.existsSync(filename)) { if (required) throw new Error(`Required distribution file is missing: ${relative}`); return; }
    const info = fs.lstatSync(filename);
    if (info.isSymbolicLink()) throw new Error(`Distribution source must not contain links: ${relative}`);
    if (!info.isFile()) throw new Error(`Expected an ordinary distribution file: ${relative}`);
    if (info.size > 32 * 1024 * 1024) throw new Error(`Unexpected large source file: ${relative}`);
    const data = fs.readFileSync(filename);
    entries.push({ path: relative.replaceAll(path.sep, '/'), data, size: data.length, sha256: digest(data), mode: /\.(?:sh|py)$/.test(relative) ? 0o100755 : 0o100644 });
  }
  function walk(relative) {
    const filename = path.join(base, relative);
    if (!fs.existsSync(filename)) return;
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`Distribution source must not contain links: ${relative}`);
    for (const item of fs.readdirSync(filename, { withFileTypes: true })) {
      if (blockedParts.test(item.name) || blockedNames.test(item.name)) { skip('runtime, credential, cache, database or native binary'); continue; }
      const child = path.join(relative, item.name);
      if (item.isSymbolicLink()) throw new Error(`Distribution source must not contain links: ${child}`);
      if (item.isDirectory()) walk(child);
      else if (item.isFile() && (extensions.has(path.extname(item.name).toLowerCase()) || documentationImages.has(child.replaceAll(path.sep, '/')))) {
        // A later developer-created config next to source must not become a secret leak.
        if (/\.(?:json|ya?ml)$/i.test(item.name) && !sourceConfigurations.has(child.replaceAll(path.sep, '/')) && !['package.json', 'profile.json', 'native-evidence.json', 'gui-enum-evidence.json'].includes(item.name) && !/\.(?:example|sample|schema)\.(?:json|ya?ml)$/i.test(item.name)) { skip('non-template configuration'); continue; }
        add(child);
      }
      else skip('file extension outside source allowlist');
    }
  }
  for (const relative of topFiles) add(relative, ['package.json', 'package-lock.json', 'LICENSE'].includes(relative));
  for (const relative of bridgeFiles) add(relative, relative === 'bridge/daemon.mjs');
  for (const relative of trees) walk(relative);
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(entries.map(e => e.path.toLowerCase())).size !== entries.length) throw new Error('Case-insensitive path collision would break extraction on Windows');
  for (const required of requiredFiles) {
    if (!entries.some(e => e.path === required)) throw new Error(`Missing required distribution file ${required}; ${required.startsWith('dist/') ? 'run npm run build before packaging' : 'restore the complete project sources before packaging'}`);
  }
  return { entries, excluded: Object.fromEntries(excluded) };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : n >>> 1;
  return n >>> 0;
});
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }

export function makeZip(entries, prefix = 'KoishiRTC/') {
  if (entries.length > 65535) throw new Error('Too many ZIP entries');
  const locals = [], directory = []; let offset = 0;
  for (const entry of entries) {
    if (entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some(p => p === '..' || !p)) throw new Error('Unsafe archive path');
    const name = Buffer.from(prefix + entry.path, 'utf8'), data = entry.data, compressed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    if (name.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP64 is not supported');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01; stable build metadata, no source filesystem timestamps.
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(directory), end = Buffer.alloc(22);
  if (offset + centralBytes.length > 0xffffffff) throw new Error('ZIP64 is not supported');
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

export function packagePortable({ output, check = false, force = false, base = root } = {}) {
  const { entries, excluded } = collectFiles(base), metadata = JSON.parse(entries.find(e => e.path === 'package.json').data.toString('utf8'));
  if (!/^[0-9A-Za-z._-]+$/.test(metadata.version)) throw new Error('Unsafe package version');
  const destination = path.resolve(output ?? path.join(base, 'artifacts', `KoishiRTC-${metadata.version}-portable.zip`));
  const portableManifest = { format: 1, name: metadata.name, version: metadata.version, node: metadata.engines?.node,
    archiveRoot: 'KoishiRTC/', prebuilt: true, dependenciesIncluded: false, officialQQIncluded: false, runtimeIncluded: false,
    files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
  const report = { output: destination, sourceFiles: entries.length, uncompressedBytes: entries.reduce((sum, e) => sum + e.size, 0),
    excluded, roots: [...new Set(entries.map(e => e.path.split('/')[0]))], hasRuntime: false, hasNodeModules: false, hasNativeBinaries: false };
  if (check) return { ...report, files: portableManifest.files.map(f => f.path) };
  const targets = [destination, destination + '.manifest.json', destination + '.sha256'];
  if (!force && targets.some(file => fs.existsSync(file))) throw new Error('Output already exists; choose --output or use --force for an intentional rebuild');
  const manifestBytes = Buffer.from(JSON.stringify(portableManifest, null, 2) + '\n');
  const archive = makeZip([...entries, { path: 'portable-manifest.json', data: manifestBytes }]);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Do not overwrite a partial archive on failure. --force only targets named outputs.
  const tmp = destination + `.tmp-${process.pid}`;
  let ownsTmp = false;
  try {
    fs.writeFileSync(tmp, archive, { flag: 'wx' }); ownsTmp = true;
    if (force) fs.renameSync(tmp, destination);
    else { fs.copyFileSync(tmp, destination, fs.constants.COPYFILE_EXCL); fs.unlinkSync(tmp); }
  } finally { if (ownsTmp) fs.rmSync(tmp, { force: true }); }
  fs.writeFileSync(targets[1], manifestBytes); const sha256 = digest(archive);
  fs.writeFileSync(targets[2], `${sha256}  ${path.basename(destination)}\n`);
  return { ...report, zipEntries: entries.length + 1, archiveBytes: archive.length, sha256, manifest: targets[1] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = {};
    while (args.length) { const arg = args.shift(); if (arg === '--output' && args.length) options.output = args.shift(); else if (arg === '--check') options.check = true; else if (arg === '--force') options.force = true; else throw new Error('Usage: node scripts/package-portable.mjs [--output file.zip] [--check] [--force]'); }
    console.log(JSON.stringify(packagePortable(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
