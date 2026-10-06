import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const localPython = fileURLToPath(new URL('../runtime/telegram-venv/bin/python', import.meta.url));
const windowsPython = fileURLToPath(new URL('../runtime/telegram-venv/Scripts/python.exe', import.meta.url));

test('Telegram sidecar fake SDK control, lifecycle and media regressions stay offline', () => {
  const python = existsSync(localPython) ? localPython : existsSync(windowsPython) ? windowsPython : 'python3';
  const result = spawnSync(python, ['-B', 'bridge/telegram/test_sidecar.py'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran \d+ tests/);
});
