// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('Xvfb launchers give QQ an X11 environment without changing the parent desktop', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtc-qq-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts'), bin = path.join(root, 'bin'), qq = path.join(root, 'QQ with spaces');
  for (const dir of [scripts, bin, qq, path.join(root, 'runtime'), path.join(root, 'av-host'), path.join(root, 'audio')]) await fs.mkdir(dir, { recursive: true });
  for (const name of ['common.sh', 'run-av-host.sh', 'run-napcat.sh']) await fs.copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  const executable = async (file, content) => { await fs.writeFile(file, `#!/usr/bin/env bash\n${content}\n`); await fs.chmod(file, 0o755); };
  await executable(path.join(scripts, 'audio-control.sh'), 'exit 0');
  await executable(path.join(bin, 'curl'), 'exit 0');
  await executable(path.join(bin, 'xvfb-run'), 'printf "%s|%s" "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY" > "$RTC_FIXTURE_PARENT"\nshift\nexport DISPLAY=:999\nexec "$@"');
  await executable(path.join(qq, 'qq'), 'printf "%s|%s|%s" "$XDG_SESSION_TYPE" "${WAYLAND_DISPLAY-unset}" "$DISPLAY" > "$RTC_FIXTURE_CHILD"');
  for (const name of ['runtime/control.token', 'av-host/host.cjs', 'audio/qq-pulse-guard.so', 'avsdk.so']) await fs.writeFile(path.join(root, name), '');
  for (const name of ['run-av-host.sh', 'run-napcat.sh']) {
    const parent = path.join(root, `${name}.parent`), child = path.join(root, `${name}.child`);
    const result = spawnSync('bash', [path.join(scripts, name)], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-fixture',
        KOISHI_RTC_QQ_BRIDGE_DIR: root, KOISHI_RTC_QQ_QQ_DIR: qq, KOISHI_RTC_QQ_AVSDK_PATH: path.join(root, 'avsdk.so'),
        KOISHI_RTC_QQ_RESTART_AV_HOST: '0', RTC_FIXTURE_PARENT: parent, RTC_FIXTURE_CHILD: child } });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(await fs.readFile(parent, 'utf8'), 'wayland|wayland-fixture');
    assert.equal(await fs.readFile(child, 'utf8'), 'x11|unset|:999');
  }
});
