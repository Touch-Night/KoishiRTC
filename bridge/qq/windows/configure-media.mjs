// SPDX-License-Identifier: GPL-3.0-only
// Prepare new config files only: never starts QQ, audio, or Koishi.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadInstall } from './manage.mjs';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function privateDirectory(directory) {
  for (let parent = path.resolve(directory); ; parent = path.dirname(parent)) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Configuration paths must not use symbolic links');
    if (path.dirname(parent) === parent) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    // Obtain the current SID without local-language parsing of account names.
    const sid = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Could not identify the current Windows user for private ACLs');
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/Q'], { stdio: 'pipe', windowsHide: true });
  }
}

export function configureMedia(options) {
  const m = loadInstall(options.installDir);
  if (!/^[1-9]\d{4,15}$/.test(options.selfId ?? '')) throw new Error('--self-id must be the actual logged-in QQ number');
  if (!options.python || !path.isAbsolute(options.python) || !fs.existsSync(options.python) || !fs.statSync(options.python).isFile()) throw new Error('--python must name the installed virtual environment interpreter by absolute path');
  if (!options.consoleDir && !fs.existsSync(path.join(projectRoot, 'scripts', 'run-local-console.cjs'))) throw new Error('Run this helper from the portable project tree, or provide --console-dir explicitly');
  const consoleDir = path.resolve(options.consoleDir ?? path.join(projectRoot, 'runtime', 'console'));
  const mediaPort = Number(options.mediaPort ?? 6120), consolePort = Number(options.consolePort ?? 6129);
  if (![mediaPort, consolePort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || new Set([mediaPort, consolePort, m.controlPort, m.avPort]).size !== 4) throw new Error('Choose four different valid bridge/Host/media/console ports');
  const runtime = path.join(m.installDir, 'runtime'), tokenFile = path.join(runtime, 'media.token'), mediaFile = path.join(runtime, 'bridge.json'), consoleFile = path.join(consoleDir, 'config.json');
  const targets = [tokenFile, mediaFile, consoleFile];
  if (targets.some(f => fs.existsSync(f))) throw new Error('A media token/config or console config already exists; no existing configuration will be overwritten');
  const inputDevice = options.inputDevice ?? '', outputDevice = options.outputDevice ?? '';
  if ((inputDevice && !inputDevice.startsWith('pa:')) || (outputDevice && !outputDevice.startsWith('pa:')) || (inputDevice && inputDevice === outputDevice)) throw new Error('Use different explicit pa: input/output IDs, or leave both unconfigured for selection in the console');
  privateDirectory(runtime); privateDirectory(consoleDir);
  const token = randomBytes(32).toString('hex');
  const media = { host: '127.0.0.1', port: mediaPort, tokenFile, account: { platform: 'onebot', selfId: options.selfId },
    qq: { url: `http://127.0.0.1:${m.controlPort}`, tokenFile: m.tokenFile },
    audio: { backend: 'portaudio', python: options.python, inputDevice, outputDevice, sampleRate: 48000, channels: 1, frameMs: 20, maxQueueMs: 2000 } };
  const consoleConfig = { username: 'rtc-admin', password: randomBytes(18).toString('base64url'), port: consolePort,
    plugin: { bridges: [{ id: 'qq-windows', url: `ws://127.0.0.1:${mediaPort}/v1/stream`, token, platform: 'onebot', selfId: options.selfId }], discord: [], historyLimit: 100 } };
  const contents = [token + '\n', JSON.stringify(media, null, 2) + '\n', JSON.stringify(consoleConfig, null, 2) + '\n'], created = [];
  try {
    for (let i = 0; i < targets.length; i++) { fs.writeFileSync(targets[i], contents[i], { flag: 'wx', mode: 0o600 }); created.push(targets[i]); }
  } catch (error) { for (const file of created) fs.unlinkSync(file); throw error; }
  return { ok: true, files: { mediaConfig: mediaFile, mediaToken: tokenFile, consoleConfig: consoleFile },
    consoleURL: `http://127.0.0.1:${consolePort}/console/rtc`, credentialsPrinted: false, processesStarted: false,
    audioConfigured: Boolean(inputDevice && outputDevice), note: 'Select RX input and TX output in the authenticated console before making a call. Native AVSDK routes must be confirmed separately.' };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const names = { 'install-dir': 'installDir', 'self-id': 'selfId', python: 'python', 'console-dir': 'consoleDir', 'media-port': 'mediaPort', 'console-port': 'consolePort', 'input-device': 'inputDevice', 'output-device': 'outputDevice' };
    const argv = process.argv.slice(2), options = {};
    while (argv.length) { const key = argv.shift(); if (!key?.startsWith('--') || !names[key.slice(2)] || !argv.length) throw new Error('Usage: node configure-media.mjs --install-dir DIR --self-id QQ_NUMBER --python ABSOLUTE_PYTHON_PATH [--console-dir DIR]'); options[names[key.slice(2)]] = argv.shift(); }
    console.log(JSON.stringify(configureMedia(options), null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; }
}
