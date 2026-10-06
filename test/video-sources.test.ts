import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createVideoSource, generateVideoFrame, encodeVideoFrame, decodeVideoFrame, LatestVideoFrameQueue, createVirtualCameraSink, virtualCameraConfig } from '../bridge/video/index.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const format = { width: 16, height: 8, fps: 15, pixelFormat: 'i420' };
const frame = (sequence = 0, changes: Record<string, unknown> = {}) => ({ ...format, callId: 'call', sourceId: 'test-source', kind: 'generated', sequence, timestamp: Date.now(), data: generateVideoFrame(format, sequence), ...changes });

test('raw protocol roundtrips exact planes and rejects invalid shape, framing and excessive metadata', () => {
  for (const pixelFormat of ['i420', 'rgba']) {
    const original = frame(4, { pixelFormat, data: generateVideoFrame({ ...format, pixelFormat }, 4) });
    assert.deepEqual(decodeVideoFrame(encodeVideoFrame(original)), original);
    assert.equal(original.data.length, 16 * 8 * (pixelFormat === 'i420' ? 1.5 : 4));
  }
  assert.throws(() => encodeVideoFrame(frame(0, { width: 15 })), /even/);
  assert.throws(() => encodeVideoFrame(frame(0, { data: Buffer.alloc(1) })), /length/);
  assert.throws(() => encodeVideoFrame(frame(0, { fps: undefined })), /missing/);
  assert.throws(() => encodeVideoFrame(frame(0, { sourceId: 'x'.repeat(257) })), /identifier/);
  assert.throws(() => decodeVideoFrame(Buffer.concat([encodeVideoFrame(frame()), Buffer.from([0])])), /lengths/);
  const huge = encodeVideoFrame(frame()); huge.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => decodeVideoFrame(huge), /lengths/);
  const truncated = encodeVideoFrame(frame()).subarray(0, 20);
  assert.throws(() => decodeVideoFrame(truncated), /lengths/);
  assert.notDeepEqual(generateVideoFrame(format, 0), generateVideoFrame(format, 1));
});

test('generated source is paced without catch-up bursts and abort removes future frames', async () => {
  let clock = 100, id = 0;
  const tasks = new Map<number, { callback: () => void; due: number }>();
  const source = createVideoSource({ ...format, backend: 'generated' }, { now: () => 1000 + clock, monotonic: () => clock,
    setTimeout: (callback: () => void, delay: number) => { tasks.set(++id, { callback, due: clock + delay }); return id; }, clearTimeout: (key: number) => tasks.delete(key) });
  const frames: any[] = []; source.on('frame', (value: any) => frames.push(value));
  const abort = new AbortController(); await source.start({ callId: 'call', signal: abort.signal });
  const runNext = () => { const [key, value] = tasks.entries().next().value!; tasks.delete(key); value.callback(); };
  runNext(); assert.equal(frames.length, 1); assert.equal(frames[0].timestamp, 1100);
  clock += 1000; runNext(); assert.equal(frames.length, 2); assert.equal(tasks.size, 1);
  assert.ok(tasks.values().next().value!.due > clock);
  abort.abort(); assert.equal(tasks.size, 0); assert.equal(source.state, 'stopped');
  assert.deepEqual((await source.listSources()).map((s: any) => s.capturesDevices), [false]);
  await source.start({ callId: 'new-call' }); runNext(); assert.equal(frames[2].callId, 'new-call'); assert.equal(frames[2].sequence, 0);
  await source.stop();
});

test('external source never selects a device and rejects stale sessions and out-of-order frames', async () => {
  assert.throws(() => createVideoSource({ backend: 'camera' }), /not implicit/);
  assert.throws(() => createVideoSource({ backend: 'external' }), /sourceId/);
  const source = createVideoSource({ ...format, backend: 'external', sourceId: 'test-source', kind: 'camera' });
  const frames: any[] = []; source.on('frame', (value: any) => frames.push(value));
  await source.start({ callId: 'call' });
  const value = frame(1, { kind: 'camera' }); source.write(value); value.data.fill(0);
  assert.notDeepEqual(frames[0].data, value.data);
  assert.throws(() => source.write(frame(2, { kind: 'camera', callId: 'other' })), /session/);
  assert.throws(() => source.write(frame(1, { kind: 'camera' })), /increase/);
  await source.stop(); assert.throws(() => source.write(frame(3)), /running/);
});

test('slow transport retains only the newest pending frame and never claims remote playback', async () => {
  const sent: number[] = [], resolvers: ((value: any) => void)[] = [];
  const queue = new LatestVideoFrameQueue((value: any) => { sent.push(value.sequence); return new Promise(resolve => resolvers.push(resolve)); }, { callId: 'call', sourceId: 'test-source' });
  const first = queue.submit(frame(0)); await tick();
  const older = queue.submit(frame(1)), latest = queue.submit(frame(2));
  assert.equal((await older).state, 'dropped'); assert.deepEqual(sent, [0]);
  resolvers.shift()!({ evidence: 'test-transport-write' });
  const receipt = await first; assert.equal(receipt.state, 'dispatched'); assert.equal(receipt.evidence, 'test-transport-write');
  assert.equal('playedBytes' in receipt, false); await tick(); assert.deepEqual(sent, [0, 2]);
  resolvers.shift()!({ evidence: 'test-transport-write' }); assert.equal((await latest).state, 'dispatched'); queue.close();
});

test('queue rejects another owner, expires old frames, closes on timeout and cancels blocked writes', async () => {
  const queue = new LatestVideoFrameQueue(() => new Promise(() => {}), { callId: 'call', sourceId: 'test-source', timeoutMs: 20 });
  assert.throws(() => queue.submit(frame(0, { callId: 'other' })), /another/);
  assert.equal((await queue.submit(frame(0, { timestamp: Date.now() - 2000 }))).state, 'dropped');
  const stalled = queue.submit(frame(1)), pending = queue.submit(frame(2));
  assert.equal((await stalled).state, 'failed'); assert.equal((await pending).state, 'cancelled'); assert.equal(queue.closed, true);
  const next = new LatestVideoFrameQueue(() => new Promise(() => {}), { callId: 'call', sourceId: 'test-source' });
  const cancelled = next.submit(frame()); next.close(); assert.equal((await cancelled).state, 'cancelled');
});

class FakeWorker extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); packets: Buffer[] = []; exitCode: number | null = null; signalCode: string | null = null;
  stdin = new Writable({ write: (data, _encoding, done) => { this.packets.push(Buffer.from(data)); done(); } });
  json(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
  kill() { this.signalCode = 'SIGTERM'; queueMicrotask(() => { this.stdin.destroy(); this.emit('close', null, 'SIGTERM'); }); return true; }
}
function virtualFixture({ ready = true, device, timeoutMs = 500, linux = false }: { ready?: boolean; device?: string; timeoutMs?: number; linux?: boolean } = {}) {
  const backend = linux ? 'v4l2loopback' : 'obs', configuredDevice = linux ? '/dev/video42' : 'OBS Virtual Camera';
  device ??= configuredDevice;
  const children: { child: FakeWorker; args: string[] }[] = [];
  const sink = createVirtualCameraSink({ ...format, backend, device: configuredDevice, startupTimeoutMs: 1000, timeoutMs }, { platform: linux ? 'linux' : 'win32', spawn: (_command: string, args: string[]) => {
    const child = new FakeWorker(); children.push({ child, args });
    if (args.includes('--diagnostics')) queueMicrotask(() => { child.json({ available: true, opensDevices: false }); child.exitCode = 0; child.emit('close', 0, null); });
    else if (ready) queueMicrotask(() => child.json({ type: 'ready', ...format, backend, device, nativeDeviceId: 'fixture-native-id' }));
    return child;
  } });
  return { sink, children, worker: () => children.at(-1)!.child };
}

test('virtual camera requires explicit backend/device and diagnostics open no camera', async () => {
  assert.throws(() => virtualCameraConfig({ device: 'OBS Virtual Camera' }, 'win32'), /explicit/);
  assert.throws(() => virtualCameraConfig({ backend: 'obs', device: 'default' }, 'win32'), /forbidden/);
  assert.throws(() => virtualCameraConfig({ backend: 'obs', device: 'Physical Webcam' }, 'win32'), /exact/);
  assert.throws(() => virtualCameraConfig({ backend: 'v4l2loopback', device: '/dev/video0' }, 'darwin'), /supported/);
  const f = virtualFixture(); assert.equal((await f.sink.diagnostics())[0].level, 'ok');
  assert.equal(f.children[0].args.includes('--diagnostics'), true); assert.equal(f.children.some(c => c.args.includes('--run')), false);
});

test('virtual camera reports dispatch only after the worker acknowledges exact sequence and bytes', async () => {
  const f = virtualFixture(); await f.sink.start({ callId: 'call', sourceId: 'test-source' });
  assert.equal(f.sink.nativeDeviceId, 'fixture-native-id');
  const receipts: any[] = []; f.sink.on('receipt', (value: any) => receipts.push(value));
  const written = f.sink.write(frame(0)); await tick();
  assert.equal(receipts.length, 0); assert.equal(f.worker().packets.length, 1);
  const decoded = decodeVideoFrame(f.worker().packets[0]); assert.equal(decoded.sequence, 0);
  f.worker().json({ type: 'submitted', sequence: 0, bytes: decoded.data.length, evidence: 'pyvirtualcam-send' });
  const receipt = await written; assert.equal(receipt.state, 'dispatched'); assert.equal(receipt.evidence, 'pyvirtualcam-send');
  assert.throws(() => f.sink.write(frame(1, { callId: 'other' })), /another/);
  await f.sink.stop(); assert.equal(f.worker().signalCode, 'SIGTERM');
});

test('virtual camera rejects a fallback device and shuts down a hung or cancelled worker', async () => {
  const wrong = virtualFixture({ device: 'Unexpected Webcam' });
  await assert.rejects(wrong.sink.start({ callId: 'call', sourceId: 'test-source' }), /unexpected/);
  assert.equal(wrong.worker().signalCode, 'SIGTERM');
  const hung = virtualFixture({ timeoutMs: 20 }); await hung.sink.start({ callId: 'call', sourceId: 'test-source' });
  const write = hung.sink.write(frame()); assert.equal((await write).state, 'failed'); await tick(); assert.equal(hung.worker().signalCode, 'SIGTERM');
  const starting = virtualFixture({ ready: false }); const abort = new AbortController();
  const started = starting.sink.start({ callId: 'call', sourceId: 'test-source', signal: abort.signal }); abort.abort();
  await assert.rejects(started, /stopped|cancelled/); assert.equal(starting.worker().signalCode, 'SIGTERM');
});

test('Python protocol parser accepts JS frames, rejects cross-session/replayed frames without loading devices', () => {
  const worker = fileURLToPath(new URL('../bridge/video/virtual_camera_worker.py', import.meta.url));
  const code = `import importlib.util,io,json,sys\nspec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)\nc=json.loads(sys.argv[2]); size=w.validate_config(c, 'win32')\nb=sys.stdin.buffer.read(); metadata,data=w.read_frame(io.BytesIO(b),c,size,-1)\nassert len(data)==size and metadata['sequence']==2\nfor bad,last in [(dict(c,callId='other'),-1),(c,2)]:\n try: w.read_frame(io.BytesIO(b),bad,size,last)\n except ValueError: pass\n else: raise AssertionError('invalid frame accepted')\nassert 'pyvirtualcam' not in sys.modules and 'numpy' not in sys.modules\nprint('validated')\n`;
  const result = spawnSync('python3', ['-B', '-c', code, worker, JSON.stringify({ ...format, backend: 'obs', device: 'OBS Virtual Camera', callId: 'call', sourceId: 'test-source' })], { input: encodeVideoFrame(frame(2)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /validated/);
});

test('Python worker acknowledges only a successful virtual-camera send and closes after EOF or device failure', () => {
  const worker = fileURLToPath(new URL('../bridge/video/virtual_camera_worker.py', import.meta.url));
  const code = `import importlib.util,io,json,sys,types
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
config=json.loads(sys.argv[2]); raw=sys.stdin.buffer.read(); original_output=sys.stdout; sent=[]; closed=[]; failing=False
class Camera:
 def __init__(self,**kw):
  assert kw['device']=='OBS Virtual Camera' and kw['backend']=='obs'
  self.device=kw['device']; self.backend=kw['backend']
 def __enter__(self): return self
 def __exit__(self,*args): closed.append(True)
 def send(self,frame):
  assert len(sys.stdout.getvalue().splitlines())==1, 'ack arrived before camera.send'
  if failing: raise RuntimeError('virtual device disconnected')
  sent.append(bytes(frame))
sys.modules['numpy']=types.SimpleNamespace(uint8=object(),frombuffer=lambda raw,dtype: raw)
sys.modules['pyvirtualcam']=types.SimpleNamespace(Camera=Camera,PixelFormat=types.SimpleNamespace(I420='i420',RGBA='rgba'))
sys.platform='win32'
for fail in [False,True]:
 failing=fail; sys.stdin=types.SimpleNamespace(buffer=io.BytesIO(raw)); sys.stdout=io.StringIO()
 try: w.run(config)
 except RuntimeError:
  assert fail
 else:
  assert not fail
 messages=[json.loads(line) for line in sys.stdout.getvalue().splitlines()]
 assert messages[0]['type']=='ready'
 if fail: assert len(messages)==1
 else: assert messages[1]['type']=='submitted' and messages[1]['evidence']=='pyvirtualcam-send' and messages[1]['sequence']==2
assert len(sent)==1 and len(sent[0])==192 and len(closed)==2
original_output.write('camera send and cleanup verified\\n')
# sys.stdout points to StringIO; flush the real pipe explicitly before interpreter teardown.
original_output.flush()
`;
  const result = spawnSync('python3', ['-B', '-c', code, worker, JSON.stringify({ ...format, backend: 'obs', device: 'OBS Virtual Camera', callId: 'call', sourceId: 'test-source' })], { input: encodeVideoFrame(frame(2)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /cleanup verified/);
});

test('Python worker repeats the last frame on its clock without duplicate receipts and stops on pipe EOF', () => {
  const worker = fileURLToPath(new URL('../bridge/video/virtual_camera_worker.py', import.meta.url));
  const code = `import importlib.util,io,json,os,sys,threading,time,types
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
config=json.loads(sys.argv[2]); packets=sys.stdin.buffer.read(); original_output=sys.stdout
source=io.BytesIO(packets); size=w.validate_config(config,'win32'); expected=[bytes(w.read_frame(source,config,size,-1)[1]),bytes(w.read_frame(source,config,size,0)[1])]
boundary=12+int.from_bytes(packets[4:8],'big')+size
readfd,writefd=os.pipe(); stream=io.BufferedReader(os.fdopen(readfd,'rb',buffering=0))
sys.stdin=types.SimpleNamespace(buffer=stream);sys.stdout=io.StringIO();sys.platform='win32'
sent=[];closed=[];first_repeated=threading.Event();second_repeated=threading.Event();producer_errors=[]
class Camera:
 def __init__(self,**kw):self.device=kw['device'];self.backend=kw['backend']
 def __enter__(self):return self
 def __exit__(self,*args):closed.append(True)
 def send(self,frame):
  value=bytes(frame);assert value in expected;sent.append((value,time.monotonic()))
  if sum(item[0]==expected[0] for item in sent)>=4:first_repeated.set()
  if sum(item[0]==expected[1] for item in sent)>=3:second_repeated.set()
sys.modules['numpy']=types.SimpleNamespace(uint8=object(),frombuffer=lambda raw,dtype:raw)
sys.modules['pyvirtualcam']=types.SimpleNamespace(Camera=Camera,PixelFormat=types.SimpleNamespace(I420='i420'))
def produce():
 try:
  os.write(writefd,packets[:boundary]);assert first_repeated.wait(2),'first static frame did not repeat'
  os.write(writefd,packets[boundary:]);assert second_repeated.wait(2),'replacement static frame did not repeat'
 except BaseException as error:producer_errors.append(error)
 finally:os.close(writefd)
producer=threading.Thread(target=produce);producer.start()
try:w.run(config)
finally:producer.join(2);stream.close()
assert not producer.is_alive() and not producer_errors,producer_errors
messages=[json.loads(line) for line in sys.stdout.getvalue().splitlines()]
assert messages[0]['type']=='ready' and [m['sequence'] for m in messages[1:]]==[0,1],messages
assert all(m['type']=='submitted' and m['bytes']==size for m in messages[1:])
assert len(sent)>=7 and len(closed)==1
assert sent[-1][1]-sent[0][1]>=5/config['fps'],'device writes burst instead of following fps'
count=len(sent);time.sleep(0.08);assert len(sent)==count,'output continued after EOF'
original_output.write('fixed clock, replacement, unique receipts and EOF verified\\n')
# sys.stdout points to StringIO; flush the real pipe explicitly before interpreter teardown.
original_output.flush()
`;
  const config = { ...format, fps: 30, backend: 'obs', device: 'OBS Virtual Camera', callId: 'call', sourceId: 'test-source' };
  const packets = Buffer.concat([0, 1].map(sequence => encodeVideoFrame(frame(sequence, { fps: 30, data: Buffer.alloc(192, sequence + 1) }))));
  const result = spawnSync('python3', ['-B', '-c', code, worker, JSON.stringify(config)], { input: packets, encoding: 'utf8', timeout: 6000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /unique receipts and EOF verified/);
});

test('Python clock keeps a bounded reader queue and propagates idle device and input failures', () => {
  const worker = fileURLToPath(new URL('../bridge/video/virtual_camera_worker.py', import.meta.url));
  const code = `import importlib.util,io,json,os,queue,sys,threading,time,types
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
config=json.loads(sys.argv[2]); packet=sys.stdin.buffer.read(); original_output=sys.stdout; original_read=w.read_frame
base=json.loads(packet[12:12+int.from_bytes(packet[4:8],'big')]);raw=packet[12+int.from_bytes(packet[4:8],'big'):]
def encoded(sequence):
 header=json.dumps(dict(base,sequence=sequence)).encode();return b'KRV1'+len(header).to_bytes(4,'big')+len(raw).to_bytes(4,'big')+header+raw
queues=[];original_queue=queue.Queue
class BoundedQueue(original_queue):
 def __init__(self,maxsize):assert maxsize==2;super().__init__(maxsize);queues.append(self)
w.queue.Queue=BoundedQueue
sys.modules['numpy']=types.SimpleNamespace(uint8=object(),frombuffer=lambda raw,dtype:raw)
sys.platform='win32'
for mode in ['bounded','idle-failure','truncated']:
 sent=[];closed=[];reads=[];first=threading.Event();release=threading.Event();observer_errors=[]
 def read_frame(*args):reads.append(True);return original_read(*args)
 w.read_frame=read_frame
 class Camera:
  def __init__(self,**kw):self.device=kw['device'];self.backend=kw['backend']
  def __enter__(self):return self
  def __exit__(self,*args):closed.append(True)
  def send(self,frame):
   sent.append(bytes(frame))
   if mode=='bounded' and len(sent)==1:first.set();assert release.wait(2)
   if mode=='idle-failure' and len(sent)==3:raise RuntimeError('device lost during static repeat')
 sys.modules['pyvirtualcam']=types.SimpleNamespace(Camera=Camera,PixelFormat=types.SimpleNamespace(I420='i420'))
 if mode=='idle-failure':
  readfd,writefd=os.pipe();stream=io.BufferedReader(os.fdopen(readfd,'rb',buffering=0));os.write(writefd,encoded(0))
 else:stream=io.BytesIO(b''.join(encoded(n) for n in range(12)) if mode=='bounded' else encoded(0)+b'KRV')
 sys.stdin=types.SimpleNamespace(buffer=stream);sys.stdout=io.StringIO()
 def observe():
  try:
   assert first.wait(2);time.sleep(0.03)
   assert len(reads)<=4 and queues[-1].qsize()==2,(len(reads),queues[-1].qsize())
  except BaseException as error:observer_errors.append(error)
  finally:release.set()
 observer=threading.Thread(target=observe) if mode=='bounded' else None
 if observer:observer.start()
 try:
  try:w.run(config)
  except (RuntimeError,ValueError) as error:
   assert mode!='bounded';assert ('static repeat' if mode=='idle-failure' else 'Truncated') in str(error),str(error)
  else:assert mode=='bounded'
 finally:
  if mode=='idle-failure':os.close(writefd)
  stream.close()
  if observer:observer.join(2)
 assert not observer_errors,observer_errors
 messages=[json.loads(line) for line in sys.stdout.getvalue().splitlines()]
 assert [m['sequence'] for m in messages[1:]]==(list(range(12)) if mode=='bounded' else [0]),messages
 assert len(closed)==1
original_output.write('bounded backpressure and device/input errors verified\\n')
# sys.stdout points to StringIO; flush the real pipe explicitly before interpreter teardown.
original_output.flush()
`;
  const config = { ...format, fps: 60, backend: 'obs', device: 'OBS Virtual Camera', callId: 'call', sourceId: 'test-source' };
  const result = spawnSync('python3', ['-B', '-c', code, worker, JSON.stringify(config)], { input: encodeVideoFrame(frame(0, { fps: 60 })), encoding: 'utf8', timeout: 6000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /backpressure and device\/input errors verified/);
});

function numpyPython(t: { skip(message: string): void }) {
  const candidates = [process.env.KOISHI_RTC_VIDEO_PYTHON, fileURLToPath(new URL('../runtime/video-venv/bin/python', import.meta.url)), 'python3'].filter(Boolean) as string[];
  const python = candidates.find(command => spawnSync(command, ['-B', '-c', 'import numpy'], { encoding: 'utf8', timeout: 5000 }).status === 0);
  if (!python) t.skip('Install optional bridge/video/requirements.txt or set KOISHI_RTC_VIDEO_PYTHON to exercise actual NumPy conversion.');
  return python;
}

test('NV12 conversion has BT.601 limited colors, averaged 2x2 chroma and exact I420 plane order', t => {
  const python = numpyPython(t); if (!python) return;
  const worker = fileURLToPath(new URL('../bridge/video/virtual_camera_worker.py', import.meta.url));
  const code = `import importlib.util,sys,numpy as np
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
# Independent anchor values: black/white and saturated RGB in limited-range YUV.
for rgb,expected in [([0,0,0],[16]*4+[128,128]),([255,255,255],[235]*4+[128,128]),([255,0,0],[82]*4+[90,240]),([0,255,0],[144]*4+[54,34]),([0,0,255],[41]*4+[240,110])]:
 input=np.tile(rgb+[37],4).astype(np.uint8); copy=input.copy(); output=w.to_nv12(input,2,2,'rgba')
 assert output.dtype==np.uint8 and output.shape==(6,) and output.flags.c_contiguous
 assert output.tolist()==expected,(rgb,output.tolist(),expected)
 np.testing.assert_array_equal(input,copy)
# Equal red/green/blue/white coverage has neutral chroma; nearest-neighbor fails.
mixed=np.array([255,0,0,0,0,255,0,12,0,0,255,240,255,255,255,255],dtype=np.uint8)
assert w.to_nv12(mixed,2,2,'rgba').tolist()==[82,144,41,235,128,128]
# Distinct quadrants detect UV/VU reversal and row/block layout errors.
colors=np.array([[255,0,0,1],[0,255,0,2],[0,0,255,3],[255,255,255,4]],dtype=np.uint8)
image=np.empty((4,4,4),dtype=np.uint8)
for i,color in enumerate(colors): image[(i//2)*2:(i//2+1)*2,(i%2)*2:(i%2+1)*2]=color
assert w.to_nv12(image.reshape(-1),4,4,'rgba').tolist()==[82,82,144,144,82,82,144,144,41,41,235,235,41,41,235,235,90,240,54,34,240,110,128,128]
i420=np.array(list(range(16))+[20,40,60,80]+[100,120,140,160],dtype=np.uint8)
assert w.to_nv12(i420,4,4,'i420').tolist()==list(range(16))+[20,100,40,120,60,140,80,160]
for data,width,height,fmt in [(mixed,3,2,'rgba'),(mixed,2,2,'wrong'),(mixed[:-1],2,2,'rgba'),(mixed.astype(np.int32),2,2,'rgba')]:
 try:w.to_nv12(data,width,height,fmt)
 except ValueError:pass
 else:raise AssertionError('invalid conversion accepted')
print('NV12 arithmetic and layout verified')
`;
  const result = spawnSync(python, ['-B', '-c', code, worker], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /NV12 arithmetic and layout verified/);
});

test('Linux worker requires native NV12 for both raw inputs while preserving input protocol receipts', t => {
  const python = numpyPython(t); if (!python) return;
  const worker = fileURLToPath(new URL('../bridge/video/virtual_camera_worker.py', import.meta.url));
  const code = `import importlib.util,io,json,sys,types,numpy as np
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]); w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
config=json.loads(sys.argv[2]); packet=sys.stdin.buffer.read(); output=sys.stdout; closed=[]; sent=[]; native='NV12'
size=16*8*(4 if config['pixelFormat']=='rgba' else 3)//(1 if config['pixelFormat']=='rgba' else 2)
_,original=w.read_frame(io.BytesIO(packet),config,size,-1)
expected=w.to_nv12(np.frombuffer(original,dtype=np.uint8),16,8,config['pixelFormat'])
class Camera:
 def __init__(self,**kw):
  assert kw['fmt']=='NV12'; self.device=kw['device']; self.backend=kw['backend']; self.native_fmt=native
 def __enter__(self): return self
 def __exit__(self,*args): closed.append(True)
 def send(self,frame):
  assert frame.flags.c_contiguous and frame.dtype==np.uint8 and frame.shape==(16*8*3//2,)
  np.testing.assert_array_equal(frame,expected);sent.append(True)
sys.modules['pyvirtualcam']=types.SimpleNamespace(Camera=Camera,PixelFormat=types.SimpleNamespace(NV12='NV12'))
w.verify_loopback=lambda device:'platform:v4l2loopback-042';sys.platform='linux'
for native in ['NV12','I420']:
 sys.stdin=types.SimpleNamespace(buffer=io.BytesIO(packet));sys.stdout=io.StringIO()
 try:w.run(config)
 except ValueError as error:
  assert native=='I420' and 'native NV12' in str(error); assert not sys.stdout.getvalue()
 else:
  assert native=='NV12';messages=[json.loads(line) for line in sys.stdout.getvalue().splitlines()]
  assert messages[0]['pixelFormat']==config['pixelFormat'] and messages[0]['outputPixelFormat']=='nv12' and messages[0]['nativePixelFormat']=='nv12'
  assert messages[0]['conversion']==config['pixelFormat']+'-to-nv12' and messages[0]['nativeDeviceId']=='platform:v4l2loopback-042'
  assert messages[1]['bytes']==size and messages[1]['sequence']==2
assert len(sent)==1 and len(closed)==2
try:w.validate_config(dict(config,width=15,pixelFormat='rgba'),'linux')
except ValueError:pass
else:raise AssertionError('odd Linux NV12 dimensions accepted')
sys.stdout=output;print('NV12 worker protocol verified')
`;
  for (const pixelFormat of ['rgba', 'i420']) {
    const config = { ...format, pixelFormat, backend: 'v4l2loopback', device: '/dev/video42', callId: 'call', sourceId: 'test-source' };
    const original = frame(2, { pixelFormat, data: generateVideoFrame(config, 2) });
    const result = spawnSync(python, ['-B', '-c', code, worker, JSON.stringify(config)], { input: encodeVideoFrame(original), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /NV12 worker protocol verified/);
  }
});

test('exact Linux backend write failures stop without a newline while ordinary logs and incomplete prefixes do not', async () => {
  const f = virtualFixture({ linux: true }); await f.sink.start({ callId: 'call', sourceId: 'test-source' });
  const errors: Error[] = []; f.sink.on('error', (error: Error) => errors.push(error));
  const pending = f.sink.write(frame(0)); await tick();
  f.worker().stderr.write('diagnostic: error writing frame: not a backend failure\nordinary warning\n');
  assert.equal(f.sink.state, 'running'); assert.equal(errors.length, 0);
  f.worker().stderr.write('error writing fra');
  assert.equal(f.sink.state, 'running', 'an incomplete native prefix is not a failure');
  f.worker().stderr.write('me: Broken pipe'); // Native fprintf deliberately has no newline.
  assert.notEqual((await pending).state, 'dispatched'); await tick();
  assert.equal(f.sink.state, 'stopped'); assert.equal(f.worker().signalCode, 'SIGTERM');
  assert.equal(errors.length, 1); assert.match(errors[0]!.message, /device write failed: Broken pipe/);
  assert.throws(() => f.sink.write(frame(1)), /not running/);
});

test('a complete native write-failure prefix stops even if strerror arrives in a later chunk', async () => {
  const f = virtualFixture({ linux: true }); await f.sink.start({ callId: 'call', sourceId: 'test-source' });
  const errors: Error[] = []; f.sink.on('error', (error: Error) => errors.push(error));
  const pending = f.sink.write(frame(0)); await tick();
  f.worker().stderr.write('error writing frame: ');
  assert.notEqual((await pending).state, 'dispatched'); await tick();
  assert.equal(f.sink.state, 'stopped'); assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /backend write\(2\) failed/);
  f.worker().stderr.write('Broken pipe'); assert.equal(errors.length, 1);
});

test('late kernel-write stderr revokes future sending and cannot poison a replacement worker', async () => {
  const f = virtualFixture({ linux: true }); await f.sink.start({ callId: 'call', sourceId: 'test-source' });
  const errors: Error[] = []; f.sink.on('error', (error: Error) => errors.push(error));
  const pending = f.sink.write(frame(0)); await tick();
  f.worker().json({ type: 'submitted', sequence: 0, bytes: frame(0).data.length, evidence: 'pyvirtualcam-send' });
  assert.equal((await pending).state, 'dispatched'); // This is only the local API return, not remote receipt.
  f.worker().stderr.write('error writing frame: Invalid argument\n'); await tick();
  assert.equal(f.sink.state, 'stopped'); assert.equal(errors.length, 1);
  const old = f.worker(); await f.sink.start({ callId: 'next-call', sourceId: 'test-source' });
  old.stderr.write('error writing frame: Broken pipe\n'); assert.equal(f.sink.state, 'running');
  await f.sink.stop();
  const obs = virtualFixture(); await obs.sink.start({ callId: 'call', sourceId: 'test-source' });
  obs.worker().stderr.write('error writing frame: other backend diagnostic\n'); assert.equal(obs.sink.state, 'running'); await obs.sink.stop();
});
