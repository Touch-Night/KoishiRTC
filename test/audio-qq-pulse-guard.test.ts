import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

// A fake libpulse verifies actual ELF interposition without touching an audio
// server, microphone, QQ process, or user configuration.
const linux = process.platform === 'linux';
let directory: string;
const source = fileURLToPath(new URL('../bridge/audio/qq-pulse-guard.c', import.meta.url));
const header = `#include <stdint.h>
#include <stddef.h>
typedef struct { int format; uint32_t rate; uint8_t channels; } sample_spec;
typedef struct { uint32_t maxlength, tlength, prebuf, minreq, fragsize; } buffer_attr;
extern sample_spec spec;
extern buffer_attr actual;
extern int original_calls, actual_flags;
extern const char *actual_device;
int pa_context_connect(void *, const char *, int, const void *);
int pa_stream_connect_record(void *, const char *, const buffer_attr *, int);
int pa_stream_connect_playback(void *, const char *, const buffer_attr *, int, const void *, void *);
`;
function command(command: string, args: string[], options: Record<string, unknown> = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
before(() => {
  if (!linux) return;
  directory = mkdtempSync(path.join(os.tmpdir(), 'rtc-qq-pulse-shim-'));
  writeFileSync(path.join(directory, 'fake.h'), header);
  writeFileSync(path.join(directory, 'fake.c'), `#include "fake.h"
sample_spec spec = {3, 44100, 2};
buffer_attr actual;
int original_calls = 0, actual_flags = 0;
const char *actual_device = "";
const sample_spec *pa_stream_get_sample_spec(const void *s) { (void)s; return &spec; }
size_t pa_frame_size(const sample_spec *s) { return s->channels * 2; }
int pa_context_connect(void *s, const char *d, int f, const void *a) {
  (void)s; (void)a; original_calls++; actual_device=d; actual_flags=f; return 44;
}
int pa_stream_connect_record(void *s, const char *d, const buffer_attr *a, int f) {
  (void)s; original_calls++; actual=*a; actual_device=d; actual_flags=f; return 42;
}
int pa_stream_connect_playback(void *s, const char *d, const buffer_attr *a, int f, const void *v, void *sync) {
  (void)v; (void)sync; pa_stream_connect_record(s,d,a,f); return 43;
}
`);
  // The fake playback must not call its interposed record symbol; use -Bsymbolic.
  writeFileSync(path.join(directory, 'driver.c'), `#include "fake.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const char *mode=argv[1]; int result;
  buffer_attr custom={4096,2048,0,512,1024}, before=custom;
  if (!strcmp(mode,"invalid-spec")) spec.rate=0;
  if (!strcmp(mode,"48000-mono")) { spec.rate=48000; spec.channels=1; }
  if (!strncmp(mode,"context",7))
    result=pa_context_connect(NULL,!strcmp(mode,"context-wrong")?"unix:/real/default":NULL,2,NULL);
  else if (!strncmp(mode,"playback",8))
    result=pa_stream_connect_playback(NULL,"rtc_speaker",strstr(mode,"custom")?&custom:NULL,0xa,(void*)1,(void*)2);
  else result=pa_stream_connect_record(NULL,!strcmp(mode,"default")?NULL:!strcmp(mode,"wrong")?"real_mic":"rtc_mic_source",
    strstr(mode,"custom")?&custom:NULL,!strcmp(mode,"early")?0x4000:0xa);
  printf("{\\"result\\":%d,\\"calls\\":%d,\\"flags\\":%d,\\"device\\":\\"%s\\",\\"maxlength\\":%u,\\"tlength\\":%u,\\"prebuf\\":%u,\\"minreq\\":%u,\\"fragsize\\":%u,\\"unchanged\\":%s}\\n",
    result,original_calls,actual_flags,actual_device,actual.maxlength,actual.tlength,actual.prebuf,actual.minreq,actual.fragsize,memcmp(&custom,&before,sizeof custom)?"false":"true");
  return 0;
}
`);
  const cc = process.env.CC || 'cc';
  command(cc, ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', path.join(directory, 'guard.so'), '-ldl']);
  command(cc, ['-shared', '-fPIC', '-Wl,-Bsymbolic', path.join(directory, 'fake.c'), '-o', path.join(directory, 'libfake.so')]);
  command(cc, [path.join(directory, 'driver.c'), '-L', directory, '-lfake', `-Wl,-rpath,${directory}`, '-o', path.join(directory, 'driver')]);
  // Match Chromium: the AV plugin is dlopen(RTLD_LOCAL), so its libpulse
  // dependency is invisible to the preloaded shim's RTLD_NEXT lookup.
  command(cc, ['-shared', '-fPIC', '-Wl,-Bsymbolic', '-Wl,-soname,libpulse.so.0', path.join(directory, 'fake.c'), '-o', path.join(directory, 'libpulse.so.0')]);
  command(cc, ['-shared', '-fPIC', '-Dmain=plugin_main', path.join(directory, 'driver.c'), '-L', directory, '-l:libpulse.so.0', `-Wl,-rpath,${directory}`, '-o', path.join(directory, 'plugin.so')]);
  writeFileSync(path.join(directory, 'local-driver.c'), `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  void *handle=dlopen("${directory}/plugin.so",RTLD_NOW|RTLD_LOCAL);
  if (!handle) { fprintf(stderr,"%s",dlerror()); return 3; }
  int (*entry)(int,char**)=dlsym(handle,"plugin_main");
  if (!entry) return 4;
  return entry(argc,argv);
}
`);
  command(cc, [path.join(directory, 'local-driver.c'), '-ldl', '-o', path.join(directory, 'local-driver')]);
});
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function run(mode: string, override: Record<string, string | undefined> = {}, local = false) {
  const env = { ...process.env, LD_PRELOAD: path.join(directory, 'guard.so'), PULSE_SERVER: 'unix:/isolated/native',
    KOISHI_RTC_QQ_PULSE_SOURCE: 'rtc_mic_source', KOISHI_RTC_QQ_PULSE_SINK: 'rtc_speaker',
    PULSE_LATENCY_MSEC: undefined, ...override };
  return JSON.parse(command(path.join(directory, local ? 'local-driver' : 'driver'), [mode], { env }).stdout);
}

test('QQ NULL capture attrs become a bounded 20 ms fragment at the actual native sample rate', { skip: !linux }, () => {
  const native = run('record');
  assert.equal(native.result, 42); assert.equal(native.calls, 1);
  assert.equal(native.fragsize, 3528); // 44100 Hz, stereo, s16le, 20 ms.
  assert.equal(native.maxlength, 42336); assert.equal(native.flags, 0x220a);
  assert.equal(native.device, 'rtc_mic_source');
  assert.equal(run('48000-mono').fragsize, 1920);
});
test('QQ playback requests 60 ms total latency and 20 ms requests, preserving smaller explicit attrs', { skip: !linux }, () => {
  const output = run('playback');
  assert.equal(output.result, 43); assert.equal(output.calls, 1);
  assert.equal(output.tlength, 10584); assert.equal(output.prebuf, 3528); assert.equal(output.minreq, 3528);
  assert.equal(output.flags, 0x220a);
  const custom = run('playback-custom');
  assert.equal(custom.tlength, 2048); assert.equal(custom.minreq, 512); assert.equal(custom.prebuf, 0);
  assert.equal(custom.maxlength, 4096); assert.equal(custom.unchanged, true);
  assert.equal(run('record-custom').fragsize, 1024);
});
test('QQ context is pinned to its isolated Unix server and cannot autospawn a default daemon', { skip: !linux }, () => {
  const context = run('context');
  assert.equal(context.result, 44); assert.equal(context.device, 'unix:/isolated/native');
  assert.equal(context.flags, 3);
  assert.equal(run('context-wrong').calls, 0);
});
test('Chromium PPAPI local plugin scope resolves the existing Pulse dependency without loading another library', { skip: !linux }, () => {
  const context = run('context', {}, true);
  assert.equal(context.result, 44); assert.equal(context.flags, 3);
  const capture = run('record', {}, true);
  assert.equal(capture.result, 42); assert.equal(capture.calls, 1);
  assert.equal(capture.fragsize, 3528); assert.equal(capture.flags, 0x220a);
  const playback = run('playback', {}, true);
  assert.equal(playback.result, 43); assert.equal(playback.tlength, 10584);
  assert.equal(run('wrong', {}, true).calls, 0);
});
test('QQ guard rejects defaults, other microphones, invalid configuration and conflicting latency overrides', { skip: !linux }, () => {
  for (const mode of ['default', 'wrong', 'early', 'invalid-spec']) {
    const result = run(mode); assert.equal(result.result, -1, mode); assert.equal(result.calls, 0, mode);
  }
  for (const override of [
    { KOISHI_RTC_QQ_PULSE_SOURCE: undefined }, { KOISHI_RTC_QQ_PULSE_SOURCE: '@DEFAULT_SOURCE@' },
    { KOISHI_RTC_QQ_PULSE_SOURCE: 'rtc_speaker' }, { PULSE_SERVER: 'tcp:localhost' },
    { PULSE_SERVER: 'unix:relative' }, { PULSE_LATENCY_MSEC: '60' },
  ]) assert.equal(run('record', override).calls, 0);
});
