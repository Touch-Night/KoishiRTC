import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'linux') throw new Error('The PulseAudio no-move shim is Linux-only.');
const directory = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.env.CC || 'cc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra',
  path.join(directory, 'pulse-no-move.c'), '-o', path.join(directory, 'pulse-no-move.so'), '-ldl'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
