// SPDX-License-Identifier: GPL-3.0-only
// Writes only an explicitly chosen virtual-camera configuration; opens no camera.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
export function validateVideoConfig(options, platform = process.platform) {
  const supported = { linux: ['v4l2loopback'], win32: ['obs', 'unitycapture'], darwin: ['obs'] };
  if (!supported[platform]?.includes(options.backend)) throw new Error('Choose a supported explicit virtual camera backend for this OS');
  if (typeof options.device !== 'string' || !options.device.trim() || options.device.length > 256 || /^(default|auto)$/i.test(options.device)) throw new Error('Specify the exact virtual camera device name');
  if (options.backend === 'obs' && options.device !== 'OBS Virtual Camera') throw new Error('OBS device name must be OBS Virtual Camera');
  if (options.backend === 'v4l2loopback' && !/^\/dev\/video\d+$/.test(options.device)) throw new Error('Select a /dev/videoN loopback device');
  if (typeof options.python !== 'string' || !path.isAbsolute(options.python)) throw new Error('--python must be an absolute interpreter path');
  if (platform !== 'linux' && (typeof options.qqDeviceId !== 'string' || !options.qqDeviceId.trim() || options.qqDeviceId.length > 256 || /^(default|auto)$/i.test(options.qqDeviceId))) throw new Error('Specify --qq-device-id from the actual QQ camera enumeration, not a guessed friendly name');
  return { virtualCamera: { backend: options.backend, device: options.device, python: options.python, ...(options.qqDeviceId ? { qqDeviceId: options.qqDeviceId } : {}) } };
}
export function configureVideo(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform, run = dependencies.spawnSync ?? spawnSync;
  const config = validateVideoConfig(options, platform);
  const directory = path.resolve(options.bridgeDir ?? '');
  if (!options.bridgeDir || !fs.existsSync(path.join(directory, 'runtime', 'control.token'))) throw new Error('--bridge-dir must be the bridge root containing runtime/control.token');
  for (let part = directory; ; part = path.dirname(part)) { if (fs.lstatSync(part).isSymbolicLink()) throw new Error('Bridge path must not be symbolic'); if (part === path.dirname(part)) break; }
  const runtime = path.join(directory, 'runtime');
  if (fs.lstatSync(runtime).isSymbolicLink()) throw new Error('Runtime must not be symbolic');
  if (!fs.statSync(options.python).isFile()) throw new Error('Python interpreter not found');
  const candidates = [path.join(directory, 'video/virtual_camera_worker.py'), path.join(here, '../../video/virtual_camera_worker.py')];
  const worker = candidates.find(file => fs.existsSync(file)); if (!worker) throw new Error('Virtual-camera worker is missing');
  const diagnostics = run(options.python, ['-u', worker, '--diagnostics'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8192, windowsHide: true });
  if (diagnostics.error || diagnostics.status !== 0) throw new Error('Unable to run virtual-camera dependency diagnostics');
  const result = JSON.parse(diagnostics.stdout);
  if (!result.available || result.opensDevices !== false || result.platform !== platform) throw new Error('Install video/requirements.txt using the selected Python interpreter on the target OS');
  const file = path.join(runtime, 'video.json');
  if (fs.existsSync(file) && !options.replace) throw new Error('video.json already exists; use --replace to update this configuration');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Video configuration must not be symbolic');
  if (!options.check) {
    const temporary = file + `.new-${process.pid}`;
    try { fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { ok: true, file, checkedOnly: !!options.check, processesStarted: false, opensDevices: false, driverVerified: false, note: 'The installed virtual camera and QQ device identity are verified on explicit start. Stop the active camera channel before applying a different configuration.' };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = {}, argv = process.argv.slice(2), names = { 'bridge-dir': 'bridgeDir', backend: 'backend', device: 'device', python: 'python', 'qq-device-id': 'qqDeviceId' };
    while (argv.length) { const name = argv.shift(); if (name === '--replace' || name === '--check') options[name.slice(2)] = true; else if (names[name?.slice(2)] && argv.length) options[names[name.slice(2)]] = argv.shift(); else throw new Error('Use --bridge-dir DIR --backend obs|unitycapture|v4l2loopback --device NAME --python PATH --qq-device-id ID [--check] [--replace]'); }
    console.log(JSON.stringify(configureVideo(options), null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
