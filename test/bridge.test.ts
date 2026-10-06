import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import WebSocket from 'ws';
// @ts-expect-error bridge is intentionally plain Node ESM, also used outside Koishi
import { createDaemon } from '../bridge/daemon.mjs';
import { DesktopBridgeProvider } from '../src/providers/bridge.js';
import { RtcManager, unavailableCapabilities } from '../src/core.js';
const token='a'.repeat(64);
async function setup() {
  const control:any=new EventEmitter();control.calls=new Map();control.caps=unavailableCapabilities('not supported');control.caps.accept={supported:true};control.caps.hangup={supported:true};control.notices=[];
  control.start=async()=>{};control.stop=async()=>{};
  control.update=(c:any)=>{control.calls.set(c.id,c);control.emit('call',c);};
  control.control=async(op:string,args:any)=>{const c=control.calls.get(args.callId);control.update({...c,state:op==='accept'?'connected':'ended'});return {status:'submitted'};};
  const audio:any=new EventEmitter();let running=false;audio.listDevices=async()=>[];audio.diagnostics=async()=>[{id:'fixture',level:'ok',message:'injected audio'}];audio.start=async()=>{running=true};audio.stop=async()=>{running=false};audio.setMuted=async()=>{};audio.clear=async()=>{};audio.write=async(data:Buffer,id:string)=>({id,acceptedBytes:data.length,playedBytes:0,state:'queued'});
  const daemon=await createDaemon({host:'127.0.0.1',port:0,token,account:{platform:'onebot',selfId:'1'},audio:{sampleRate:48000,channels:1}},{control,audio});
  const addr=await daemon.start();return {daemon,control,audio,running:()=>running,url:`ws://127.0.0.1:${addr.port}/v1/stream`,http:`http://127.0.0.1:${addr.port}`};
}
const eventually=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('condition timed out');};
test('authenticated desktop bridge follows real callbacks and stops media on disconnect',async()=>{
  const f=await setup(), manager=new RtcManager();const provider=new DesktopBridgeProvider({id:'qq',url:f.url,token,platform:'onebot',selfId:'1'});
  try {
    await manager.register(provider);await eventually(()=>provider.capabilities().accept.supported);
    f.control.update({id:'native-1',kind:'direct',direction:'incoming',state:'ringing',targetId:'2',createdAt:1});
    await eventually(()=>manager.listCalls().length===1);assert.equal(f.running(),false);
    const c=manager.listCalls()[0]!,a=manager.controller('test');a.claim(c.id);await a.accept(c.id);await eventually(()=>f.running());
    const reader=a.audio(c.id)[Symbol.asyncIterator](), next=reader.next();
    f.audio.emit('audio',{data:Buffer.alloc(1920),sampleRate:48000,channels:1,sequence:0,timestamp:Date.now()});
    assert.equal((await next).value?.data.length,1920);
    const receipt=await a.writeAudio(c.id,{data:Buffer.alloc(1920),sampleRate:48000,channels:1,sequence:0,timestamp:Date.now(),encoding:'pcm_s16le'});
    assert.equal(receipt.state,'queued');assert.equal(receipt.playedBytes,0);
    await reader.return?.();await manager.dispose();await eventually(()=>!f.running());
  }finally{await manager.dispose();await f.daemon.stop();}
});
test('bridge rejects unauthenticated HTTP, browser-origin WebSockets and second media owners',async()=>{
  const f=await setup();let first:WebSocket|undefined;
  try {
    assert.equal((await fetch(f.http+'/v1/status')).status,401);
    const denied=new WebSocket(f.url,{headers:{Authorization:`Bearer ${token}`,Origin:'http://evil.invalid'}});await once(denied,'error');
    first=new WebSocket(f.url,{headers:{Authorization:`Bearer ${token}`}});await once(first,'open');
    const second=new WebSocket(f.url,{headers:{Authorization:`Bearer ${token}`}});await once(second,'error');
    assert.equal((await fetch(f.http+'/v1/status',{headers:{Authorization:`Bearer ${token}`}})).status,200);
  }finally{first?.terminate();await f.daemon.stop();}
});
