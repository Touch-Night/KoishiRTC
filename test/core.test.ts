import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RtcManager, validateAudio, unavailableCapabilities, type CallProvider, type CallSnapshot, type AudioFrame } from '../src/core.js';
const frame: AudioFrame = { callId: 'c1', data: new Uint8Array(1920), sampleRate: 48000, channels: 1, encoding: 'pcm_s16le', sequence: 0, timestamp: 1 };
function fixture() {
  const manager = new RtcManager();
  let call: CallSnapshot = { id:'c1', providerId:'p', account:{platform:'test',selfId:'1'}, kind:'direct',targetId:'2',direction:'incoming',state:'ringing',createdAt:1,updatedAt:1,participants:[],muted:false };
  const events = new EventEmitter();
  const publish = (patch: Partial<CallSnapshot>) => { call = {...call,...patch}; events.emit('event',{type:'call',call}); };
  const provider: CallProvider = { id:'p',account:call.account,events,
    capabilities:()=>Object.fromEntries(Object.keys(unavailableCapabilities('')).map(k=>[k,{supported:true}])) as any,
    start:async()=>{},stop:async()=>{},calls:()=>[call],dial:async()=>call,
    accept:async()=>publish({state:'connected'}),reject:async()=>publish({state:'ended'}),hangup:async()=>publish({state:'ended'}),
    setMuted:async(_id,muted)=>publish({muted}),clearAudio:async()=>{},
    writeAudio:async(f,id)=>({id,callId:f.callId,acceptedBytes:f.data.length,playedBytes:0,state:'queued'}),diagnostics:async()=>[] };
  return {manager,provider,publish,events};
}
test('ownership is exclusive; receive is bounded; ended calls cannot be resurrected', async()=>{
  const {manager,provider,publish,events}=fixture(); await manager.register(provider);
  const a=manager.controller('a'),b=manager.controller('b'); a.claim('c1');
  assert.throws(()=>b.claim('c1'),/控制/); await assert.rejects(a.writeAudio('c1',frame),/接通/); await a.accept('c1');
  const stream=a.audio('c1',{maxBufferMs:20})[Symbol.asyncIterator](); const first=stream.next();
  events.emit('event',{type:'audio',audio:frame}); assert.equal((await first).value?.data.length,1920);
  events.emit('event',{type:'audio',audio:{...frame,sequence:1}}); events.emit('event',{type:'audio',audio:{...frame,sequence:2}});
  await assert.rejects(stream.next(),/消费/);
  await a.hangup('c1'); assert.equal(manager.getCall('c1').owner,undefined);
  publish({state:'connected'}); assert.equal(manager.getCall('c1').state,'ended'); await manager.dispose();
});
test('release cannot overwrite an end callback that arrived while clearing playback',async()=>{
  const {manager,provider,publish}=fixture(); await manager.register(provider); const a=manager.controller('a'); a.claim('c1');
  provider.clearAudio=async()=>publish({state:'ended'}); await a.release('c1'); assert.equal(manager.getCall('c1').state,'ended'); await manager.dispose();
});
test('abort closes an idle audio reader, malformed PCM rejected, unknown speaker stays unknown',async()=>{
  const {manager,provider,events}=fixture(); await manager.register(provider); const a=manager.controller('a');a.claim('c1');await a.accept('c1');
  assert.throws(()=>validateAudio({...frame,data:new Uint8Array(3)}));
  const abort=new AbortController(); const reader=a.audio('c1',{signal:abort.signal})[Symbol.asyncIterator](); const next=reader.next();
  events.emit('event',{type:'audio',audio:{...frame,speakerId:'unverified'}}); assert.equal((await next).value?.speakerId,undefined);
  const pending=reader.next();abort.abort();await assert.rejects(pending,/取消/);await manager.dispose();
});
test('provider unload terminates streams and releases ownership',async()=>{
  const {manager,provider}=fixture();await manager.register(provider);const a=manager.controller('a');a.claim('c1');await a.accept('c1');
  const reader=a.audio('c1')[Symbol.asyncIterator]();const pending=reader.next();await manager.unregister('p');assert.equal((await pending).done,true);assert.equal(manager.getCall('c1').state,'failed');assert.equal(manager.getCall('c1').owner,undefined);await a.dispose();await manager.dispose();
});
test('releasing a controller revokes all its audio readers before another plugin takes over',async()=>{
  const {manager,provider}=fixture();await manager.register(provider);const a=manager.controller('a'),b=manager.controller('b');a.claim('c1');await a.accept('c1');
  const reader=a.audio('c1')[Symbol.asyncIterator]();const pending=reader.next();const rejected=assert.rejects(pending,/取消/);await a.release('c1');await rejected;
  b.claim('c1');assert.equal(manager.getCall('c1').owner,'b');await manager.dispose();
});
