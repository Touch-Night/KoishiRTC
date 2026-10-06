import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { DesktopBridgeProvider } from '../src/providers/bridge.js';
import { RtcManager } from '../src/core.js';
// @ts-expect-error standalone bridge module
import { DesktopControl } from '../bridge/desktop/control.mjs';
// @ts-expect-error standalone bridge module
import { createDaemon } from '../bridge/daemon.mjs';
const pause = (ms = 5) => new Promise<void>(r => setTimeout(r,ms));
const until = async (fn:()=>boolean) => { for(let n=0;n<200;n++){if(fn())return;await pause();}assert.fail('timed out'); };
const profile = (calibrated:boolean) => ({formatVersion:1,platform:'wechat',os:'linux',calibrated,evidenceMode:'continuous',identity:{name:'{self}'},target:{name:'{target}'},audioInput:{name:'{input}'},audioOutput:{name:'{output}'},states:{idle:[{name:'Idle'}],connected:[{name:'Connected'}]},actions:{hangup:{kind:'direct',steps:[{kind:'invoke',selector:{name:'Hangup'},commit:true}]}}});
const token = 'desktop-review-token-'.repeat(3);
async function fixture(calibrated:boolean) {
 const config = {platform:'wechat',selfId:'self',application:{executable:'/synthetic/WeChat'},profile:profile(calibrated),audioRoute:{inputName:'Virtual Mic',outputName:'Virtual Speaker'},targets:[{id:'peer',kind:'direct'}]};
 const driver = {snapshot:async()=>({epoch:'snapshot',processIdentity:'7:1',observedAt:Date.now(),truncated:false,nodes:['self','peer','Virtual Mic','Virtual Speaker','Connected','Hangup'].map((name,id)=>({id:String(id),name,visible:true,enabled:true,actions:['invoke']}))}),act:async()=>{},stop:async()=>{}};
 const control = new DesktopControl(config,{driver,platform:'linux'});
 const audio:any = new EventEmitter(); let starts=0,stops=0,saves=0,writes=0;
 audio.config={sampleRate:48000,channels:1};audio.diagnostics=async()=>[];audio.listDevices=async()=>[];audio.start=async()=>{starts++;};audio.stop=async()=>{stops++;};audio.setMuted=async()=>{};audio.clear=async()=>{};
 audio.write=async()=>{writes++;return {state:'queued'};};
 const daemon = await createDaemon({host:'127.0.0.1',port:0,token,account:{platform:'wechat',selfId:'self'},desktop:config,audio:audio.config},{control,audio,persistAudio:async()=>{saves++;}});
 const address = await daemon.start(), manager = new RtcManager(), provider = new DesktopBridgeProvider({id:'desktop',url:`ws://127.0.0.1:${address.port}/v1/stream`,token,platform:'wechat',selfId:'self'});
 await manager.register(provider); await until(()=>manager.listCalls().length===1); await pause(30);
 return {control,audio,daemon,manager,provider,get starts(){return starts;},get stops(){return stops;},get saves(){return saves;},get writes(){return writes;},async close(){await manager.dispose();await daemon.stop();}};
}

test('uncalibrated desktop evidence cannot be upgraded into audio permission by daemon',async t=>{
 const f=await fixture(false);t.after(()=>f.close());
 assert.equal(f.control.caps.receiveAudio.supported,false);
 assert.equal(f.provider.capabilities().receiveAudio.supported,false,'daemon must preserve desktop profile media gate');
 assert.equal(f.provider.capabilities().sendAudio.supported,false);
 assert.equal(f.starts,0,'connecting a provider must not open media for an uncalibrated desktop profile');
});

test('calibrated desktop with current route evidence can deliver PCM through actual daemon/provider/manager',async t=>{
 const f=await fixture(true);t.after(()=>f.close());
 assert.equal(f.provider.capabilities().receiveAudio.supported,true); assert.equal(f.starts,1);
 const id=f.manager.listCalls()[0]!.id,owner=f.manager.controller('desktop-review');owner.claim(id);
 const reader=owner.audio(id)[Symbol.asyncIterator](),pending=reader.next();
 f.audio.emit('audio',{sampleRate:48000,channels:1,sequence:0,timestamp:Date.now(),data:Buffer.alloc(960)});
 assert.equal((await pending).value?.callId,id);
 await reader.return!();await owner.release(id);
});

test('desktop evidence revocation stops active media and rejects writes immediately',async t=>{
 const f=await fixture(true);t.after(()=>f.close()); const id=f.manager.listCalls()[0]!.id;
 f.control.caps.receiveAudio={supported:false,reason:'route evidence revoked'};f.control.emit('status');
 await until(()=>f.stops>0);await until(()=>!f.provider.capabilities().receiveAudio.supported);
 await assert.rejects(f.provider.writeAudio({callId:id,encoding:'pcm_s16le',sampleRate:48000,channels:1,sequence:1,timestamp:1,data:Buffer.alloc(960)},'after-revocation'),(e:any)=>e.code==='NOT_CONNECTED');
 assert.equal(f.writes,0);assert.equal(f.starts,1);
});

test('desktop routes remain read-only even when daemon can persist other audio configurations',async t=>{
 const f=await fixture(true);t.after(()=>f.close());
 const routes=await f.provider.audioRoutes();assert.equal(routes.editable,false);assert.match(routes.reason,/probe/);
 await assert.rejects(f.provider.configureAudio('new-in','new-out'),(e:any)=>e.code==='READ_ONLY');assert.equal(f.saves,0);
});

test('accessibility commit rejects changed target evidence even if the shared button is unchanged',()=>{
 const script = String.raw`
import sys,time,types
sys.path.insert(0,'bridge/desktop')
import accessibility_worker as m
nodes=[{'name':'user-id-A','actions':[]},{'name':'Call','actions':['invoke']}]
for n in nodes:n.update(role='Button',className='',automationId='',value='',description='',visible=True,enabled=True,protected=False)
clicked=[]
class UI:
 def roots(self):return [0,1]
 def children(self,n):return []
 def read(self,n):return dict(nodes[n])
 def act(self,n,op,value):clicked.append(nodes[0]['name'])
p=types.SimpleNamespace(pid=7,create_time=lambda:1.0,exe=lambda:'/synthetic/WeChat')
m.processes=lambda application:p
w=m.Worker({'executable':'/synthetic/WeChat'});w.driver=UI();w.process='7:1.0'
snapshot=w.snapshot()
nodes[0]['name']='user-id-B'
try:
 w.act({'epoch':snapshot['epoch'],'nodeId':'1','operation':'invoke','guards':{'all':[{'name':'user-id-A'}],'none':[]}})
except (ValueError,RuntimeError):pass
assert not clicked, 'stale target A was checked, but the unchanged Call button invoked '+repr(clicked)
`;
 const result=spawnSync('python3',['-B','-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
});
