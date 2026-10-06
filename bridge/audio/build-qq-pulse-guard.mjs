import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'linux') throw new Error('The QQ PulseAudio guard is Linux-only; compile it on the target Linux architecture.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output' || !path.isAbsolute(args[1])))
  throw new Error('Usage: node bridge/audio/build-qq-pulse-guard.mjs [--output /absolute/path/qq-pulse-guard.so]');
const directory = path.dirname(fileURLToPath(import.meta.url));
const output = args[1] ?? path.join(directory, 'qq-pulse-guard.so');
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try {
  const result = spawnSync(process.env.CC || 'cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
    '-Wl,-z,relro,-z,now', path.join(directory, 'qq-pulse-guard.c'), '-o', temporary, '-ldl'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`QQ PulseAudio guard compilation failed (${result.status ?? result.signal}).`);
  renameSync(temporary, output);
  console.log(`Built ${output} for ${process.platform}/${process.arch}; no process was launched or reconfigured.`);
} finally { rmSync(temporary, { force: true }); }
