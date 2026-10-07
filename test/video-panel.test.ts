import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import * as Vue from 'vue';
const require = createRequire(import.meta.url);
const filename = new URL('../client/video-panel.vue', import.meta.url).pathname;
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename });
assert.deepEqual(errors, []);
const compiled = compileScript(descriptor, { id: 'rtc-video-panel-test' });
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'rtc-video-panel-test', compilerOptions: { bindingMetadata: compiled.bindings } });
assert.deepEqual(template.errors, []);
const code = transpileModule(compiled.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
function deferred<T = any>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); await Vue.nextTick(); }
function fixture(owner: string | null = 'console:a', handle?: (action: string, args: any) => any) {
  const calls: { action: string; args: any }[] = [], timers = new Map<number, { run: () => any; delay: number }>(); let timerId = 0;
  const module = { exports: {} as any };
  const sources = [{ id: 'test-pattern', kind: 'camera', sourceType: 'generated', name: '动态测试画面' }, { id: 'camera:selected', kind: 'camera', sourceType: 'device', name: '选择的摄像头' }, { id: 'test-pattern', kind: 'screen', sourceType: 'generated', name: '动态测试画面' }];
  const rpc = async (_type: string, action: string, args: any) => {
    calls.push({ action, args }); const value = handle?.(action, args); if (value !== undefined) return value;
    return action === 'sources' ? sources : { tracks: [], sending: {} };
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name: string) => name === '@koishijs/client' ? { send: rpc } : name === 'vue' ? Vue : require(name),
    setTimeout: (run: () => any, delay: number) => { const id = ++timerId; timers.set(id, { run, delay }); return id; }, clearTimeout: (id: number) => timers.delete(id), URL, Blob, atob,
  }, { filename });
  const component = module.exports.default; component.render = () => null;
  const props = Vue.reactive({ call: { id: 'a', state: 'connected', owner: owner ?? undefined, participants: [], mediaTransition: undefined } as any, capabilities: { receiveVideo: { supported: true }, sendVideo: { supported: true }, shareScreen: { supported: true } }, operator: 'console:a' });
  const renderer = Vue.createRenderer<any, any>({
    patchProp() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, insert() {}, remove() {},
  });
  const app = renderer.createApp({ render: () => Vue.h(component, props) }); app.mount({});
  const panel = (app as any)._instance.subTree.component.setupState;
  const fire = async (delay: number) => { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `no ${delay}ms timer`); timers.delete(entry[0]); await entry[1].run(); await settle(); };
  return { app, panel, props, calls, timers, fire };
}

test('mounted owner automatically reads video state without enumerating or claiming sources', async () => {
  const f = fixture('console:a', action => action === 'state' ? { tracks: [], sending: { camera: { state: 'sending', sourceId: 'test-pattern' } } } : undefined);
  await settle(); assert.deepEqual(f.calls.map(call => call.action), ['state']);
  assert.equal(f.calls[0].args.statusOnly, true); assert.equal(f.panel.state.sending.camera.sourceId, 'test-pattern');
  assert.match(f.panel.sendingText, /测试画面/);
  f.props.call = { ...f.props.call }; await settle();
  assert.equal(f.calls.length, 1, 'unchanged status snapshots do not restart or overlap polling');
  await f.fire(2000); assert.equal(f.calls.length, 2);
  f.app.unmount(); assert.equal(f.timers.size, 0);
});

test('unknown, absent and other owners never cause automatic video RPCs', async () => {
  for (const owner of [null, '', 'console:other']) {
    const f = fixture(owner);
    await settle(); f.panel.togglePanel({ target: { open: true } }); await settle();
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); f.app.unmount();
  }
});

test('source enumeration occurs once on expansion and preserves physical choices without selecting one by default', async () => {
  const f = fixture(); await settle(); f.panel.togglePanel({ target: { open: true } }); await settle();
  assert.equal(f.calls.filter(call => call.action === 'sources').length, 1);
  assert.equal(f.calls.find(call => call.action === 'sources')!.args.statusOnly, true);
  assert.equal(f.panel.source, 'test-pattern'); assert.ok(f.panel.sourceOptions.some((source: any) => source.id === 'camera:selected'));
  f.panel.togglePanel({ target: { open: false } }); f.panel.togglePanel({ target: { open: true } }); await settle();
  assert.equal(f.calls.filter(call => call.action === 'sources').length, 1);
  f.app.unmount();
});

test('stop runs while screen send waits and its newer result cannot be overwritten by the old send', async () => {
  const send = deferred(), f = fixture('console:a', action => action === 'send' ? send.promise : action === 'stop' ? { tracks: [], sending: {} } : undefined);
  await settle(); f.panel.kind = 'screen'; await settle(); f.panel.source = 'test-pattern';
  const starting = f.panel.sending('send'); await settle(); assert.equal(f.panel.sendPending, true);
  await f.panel.sending('stop'); assert.equal(f.calls.filter(call => call.action === 'stop').length, 1);
  assert.equal(f.panel.sendPending, false); assert.match(f.panel.notice, /停止/);
  send.resolve({ tracks: [], sending: { screen: { state: 'sending' } } }); await starting;
  assert.equal(f.panel.state.sending.screen, undefined); assert.match(f.panel.notice, /停止/);
  f.app.unmount();
});

test('an old rejected send does not overwrite a newer cancellation notice', async () => {
  const send = deferred(), f = fixture('console:a', action => action === 'send' ? send.promise : undefined);
  await settle(); f.panel.source = 'test-pattern'; const starting = f.panel.sending('send'); await settle();
  await f.panel.sending('stop'); send.reject(new Error('old upgrade timed out')); await starting;
  assert.equal(f.panel.error, ''); assert.match(f.panel.notice, /停止/); f.app.unmount();
});

test('ownership release and unmount reject late state replies and stop scheduling', async () => {
  for (const unmount of [false, true]) {
    const state = deferred(), f = fixture('console:a', action => action === 'state' ? state.promise : undefined);
    await settle(); if (unmount) f.app.unmount(); else { f.props.call.owner = undefined; await settle(); }
    state.resolve({ tracks: [], sending: { camera: { state: 'sending' } } }); await settle();
    assert.equal(f.panel.state.sending.camera, undefined); assert.equal(f.timers.size, 0);
    if (!unmount) f.app.unmount();
  }
});

test('automatic status failures have a finite retry budget and transition states remain explicit', async () => {
  const f = fixture('console:a', action => action === 'state' ? Promise.reject(new Error('backend unavailable')) : undefined);
  await settle(); await f.fire(2000); await f.fire(2000);
  assert.equal(f.calls.length, 3); assert.equal(f.timers.size, 0); assert.match(f.panel.statusError, /已暂停/);
  f.props.call.mediaTransition = { status: 'negotiating' }; await settle(); assert.equal(f.panel.transitionActive, true); assert.match(f.panel.transitionText, /协商/);
  f.props.call.mediaTransition = { status: 'failed', error: 'peer declined' }; await settle(); assert.equal(f.panel.transitionActive, false); assert.match(f.panel.transitionText, /失败/);
  f.app.unmount();
});

function consoleFixture(handle?: (type: string, args: any[]) => any) {
  const file = new URL('../client/console.vue', import.meta.url).pathname;
  const parsed = parse(fs.readFileSync(file, 'utf8'), { filename: file }); assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: 'rtc-console-test' });
  const render = compileTemplate({ source: parsed.descriptor.template!.content, filename: file, id: 'rtc-console-test', compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(render.errors, []);
  const compiled = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const calls: { type: string; args: any[] }[] = [], timers = new Map<number, any>(); let timerId = 0;
  const sources = [{ id: 'physical', kind: 'camera', name: 'Physical', sourceType: 'device' }, { id: 'test-pattern', kind: 'camera', name: 'Generated camera', sourceType: 'generated' }, { id: 'test-pattern', kind: 'screen', name: 'Generated screen', sourceType: 'generated' }, { id: 'external-frames', kind: 'camera', name: 'External', sourceType: 'frames' }];
  const module = { exports: {} as any };
  const rpc = async (type: string, ...args: any[]) => {
    calls.push({ type, args }); const result = handle?.(type, args); if (result !== undefined) return result;
    if (type === 'rtc/status') return { providers: [{ id: 'p', capabilities: { dial: { supported: true }, sendVideo: { supported: true }, shareScreen: { supported: true } } }], calls: [], levels: {}, activity: [], startup: [] };
    if (type === 'rtc/video-sources') return sources;
    if (type === 'rtc/channels') return [];
    return {};
  };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name: string) => name === '@koishijs/client' ? { send: rpc } : name === './video-panel.vue' ? {} : name === 'vue' ? Vue : require(name), setTimeout: (run: () => any) => { const id = ++timerId; timers.set(id, run); return id; }, clearTimeout: (id: number) => timers.delete(id) }, { filename: file });
  const component = module.exports.default; component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({ patchProp() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, insert() {}, remove() {} });
  const app = renderer.createApp(component); app.mount({});
  return { app, panel: (app as any)._instance.setupState, calls, timers };
}

test('console reads idle sources only for a selected video mode and sends the safe default with the invitation', async () => {
  const f = consoleFixture(); await settle(); assert.equal(f.calls.filter(call => call.type === 'rtc/video-sources').length, 0);
  f.panel.target = 'peer'; f.panel.media = 'video'; await settle();
  assert.deepEqual(f.calls.find(call => call.type === 'rtc/video-sources')!.args, ['p']);
  assert.equal(f.panel.initialSource, 'test-pattern'); assert.equal(f.panel.initialReady, true);
  assert.ok(f.panel.initialOptions.some((source: any) => source.id === 'physical'), 'explicit physical choices remain available');
  await f.panel.dial(); let sent = f.calls.filter(call => call.type === 'rtc/control').at(-1)!;
  assert.equal(sent.args[0], 'dial'); assert.equal(sent.args[1].media, 'video');
  assert.equal(sent.args[1].initialVideo[0].kind, 'camera'); assert.equal(sent.args[1].initialVideo[0].sourceId, 'test-pattern');
  f.panel.media = 'screen'; await settle(); await f.panel.dial(); sent = f.calls.filter(call => call.type === 'rtc/control').at(-1)!;
  assert.equal(sent.args[1].initialVideo[0].kind, 'screen');
  f.panel.media = 'audio'; await settle(); await f.panel.dial(); sent = f.calls.filter(call => call.type === 'rtc/control').at(-1)!;
  assert.equal(sent.args[1].initialVideo, undefined); f.app.unmount(); assert.equal(f.timers.size, 0);
});

test('console preserves an explicit physical or external-frame selection in initialVideo', async () => {
  const f = consoleFixture(); await settle(); f.panel.media = 'video'; f.panel.target = 'peer'; await settle();
  for (const sourceId of ['physical', 'external-frames']) {
    f.panel.initialSource = sourceId; await f.panel.dial();
    assert.equal(f.calls.filter(call => call.type === 'rtc/control').at(-1)!.args[1].initialVideo[0].sourceId, sourceId);
  }
  f.app.unmount();
});

test('console never chooses a physical fallback or a misleading test-pattern identifier automatically', async () => {
  for (const id of ['physical', 'test-pattern']) {
    const f = consoleFixture(type => type === 'rtc/video-sources' ? [{ id, kind: 'camera', sourceType: 'device', name: 'Physical camera' }] : undefined);
    await settle(); f.panel.media = 'video'; await settle();
    assert.equal(f.panel.initialSource, ''); assert.equal(f.panel.initialReady, false); f.app.unmount();
  }
});

test('console ignores initial-source replies after switching back to audio or unmounting', async () => {
  for (const unmount of [false, true]) {
    const response = deferred(), f = consoleFixture(type => type === 'rtc/video-sources' ? response.promise : undefined);
    await settle(); f.panel.media = 'video'; await settle(); assert.equal(f.panel.sourceBusy, true);
    if (unmount) f.app.unmount(); else { f.panel.media = 'audio'; await settle(); }
    response.resolve([{ id: 'test-pattern', kind: 'camera', sourceType: 'generated' }]); await settle();
    assert.equal(f.panel.initialSource, ''); assert.equal(f.panel.initialSources.length, 0);
    if (!unmount) f.app.unmount();
  }
});

test('compact and expanded dual-channel sources appear once and select the requested invitation channel', async () => {
  for (const expanded of [false, true]) {
    const shared = { id: 'test-pattern', name: 'Dynamic test pattern', kind: 'screen', sourceType: 'generated', channels: ['camera', 'screen'] };
    const sources = expanded ? [shared, { ...shared, kind: 'camera' }] : [shared];
    const f = consoleFixture(type => type === 'rtc/video-sources' ? sources : undefined);
    try {
      await settle(); f.panel.target = 'peer';
      for (const [media, kind] of [['video', 'camera'], ['screen', 'screen']]) {
        f.panel.media = media; await settle();
        assert.equal(f.panel.initialOptions.length, 1, `${media}: each source ID must appear once`);
        assert.equal(f.panel.initialSource, 'test-pattern'); assert.equal(f.panel.initialReady, true);
        await f.panel.dial(); const request = f.calls.filter(call => call.type === 'rtc/control').at(-1)!.args[1];
        assert.equal(request.initialVideo[0].kind, kind); assert.equal(request.initialVideo[0].sourceId, 'test-pattern');
      }
    } finally { f.app.unmount(); }
  }
});

test('in-call source choices support compact channels and deduplicate expanded rows without hiding physical choices', async () => {
  for (const expanded of [false, true]) {
    const shared = { id: 'test-pattern', name: 'Dynamic test pattern', kind: 'screen', sourceType: 'generated', channels: ['camera', 'screen'] };
    const sources = [shared, ...(expanded ? [{ ...shared, kind: 'camera' }] : []), { id: 'physical', kind: 'camera', name: 'Selected camera', sourceType: 'device' }];
    const f = fixture('console:a', action => action === 'sources' ? sources : undefined);
    try {
      await settle(); f.panel.togglePanel({ target: { open: true } }); await settle();
      for (const kind of ['camera', 'screen']) {
        f.panel.kind = kind; await settle();
        assert.equal(f.panel.sourceOptions.filter((source: any) => source.id === 'test-pattern').length, 1);
        assert.equal(f.panel.sourceOptions.some((source: any) => source.id === 'physical'), kind === 'camera');
        assert.equal(f.panel.source, 'test-pattern');
        await f.panel.sending('send'); const request = f.calls.filter(call => call.action === 'send').at(-1)!.args;
        assert.equal(request.kind, kind); assert.equal(request.sourceId, 'test-pattern');
      }
    } finally { f.app.unmount(); }
  }
});
