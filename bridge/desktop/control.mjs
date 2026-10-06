// SPDX-License-Identifier: GPL-3.0-only
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AccessibilityDriver } from './driver.mjs';
import { exactNode, findNodes, matchesAll, substitute, validateProfile } from './profile.mjs';
const error = (code,message) => Object.assign(new Error(message),{code});
const terminal = state => ['ended','failed'].includes(state);
const keys = ['dial','dialScreen','accept','reject','hangup','joinGroup','startGroup','leaveGroup','receiveAudio','sendAudio','receiveVideo','sendVideo','shareScreen','participants','speakerIdentity','mute'];
const unavailable = reason => Object.fromEntries(keys.map(key=>[key,{supported:false,reason}]));
const sleep = async (ms,signal) => { await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();};const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error('ABORTED','Operation interrupted'));};const timer=setTimeout(done,ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();}); };
export class DesktopControl extends EventEmitter {
  constructor(config,dependencies={}) {
    super(); this.config=config; this.driver=dependencies.driver??new AccessibilityDriver(config);
    this.now=dependencies.now??Date.now;this.pollIntervalMs=config.pollIntervalMs??500;
    this.actionTimeoutMs=config.actionTimeoutMs??10000;
    if(!Number.isInteger(this.pollIntervalMs)||this.pollIntervalMs<200||this.pollIntervalMs>10000||!Number.isInteger(this.actionTimeoutMs)||this.actionTimeoutMs<100||this.actionTimeoutMs>60000)throw error('INVALID_CONFIG','Invalid desktop polling/operation timeout');
    if(!config.application||typeof config.application.executable!=='string'||!path.isAbsolute(config.application.executable))throw error('INVALID_CONFIG','A specific absolute application executable is required');
    if(typeof config.selfId!=='string'||!config.selfId||config.selfId.length>512)throw error('INVALID_CONFIG','Configure the actual logged-in account ID');
    if(!config.audioRoute||typeof config.audioRoute.inputName!=='string'||!config.audioRoute.inputName||typeof config.audioRoute.outputName!=='string'||!config.audioRoute.outputName||config.audioRoute.inputName===config.audioRoute.outputName)throw error('INVALID_CONFIG','Select two explicit client-side virtual audio routes');
    if(config.targets!==undefined&&(!Array.isArray(config.targets)||config.targets.length>100||config.targets.some(target=>!target||typeof target.id!=='string'||!target.id||target.id.length>512||!['direct','group'].includes(target.kind))||new Set(config.targets.map(target=>target.id)).size!==config.targets.length))throw error('INVALID_CONFIG','Configure unique explicit peer/meeting IDs and their call kinds');
    this.profile=validateProfile(config.profile);if(this.profile.platform!==config.platform)throw error('ACCOUNT_MISMATCH','Desktop profile platform differs from the configured account');
    if(this.profile.os!==(dependencies.platform??process.platform))throw error('DESKTOP_PLATFORM','Profile must be calibrated for this operating system');
    this.calls=new Map();this.notices=[];this.caps=unavailable('Desktop client is not verified');this.offline=true;this.stopped=true;this.tail=Promise.resolve();this.requests=new Map();this.bootId=randomUUID();this.processIdentity=null;this.prepared=null;this.nextPrepareAt=0;this.evidenceMaxAgeMs=config.evidenceMaxAgeMs??300000;if(!Number.isInteger(this.evidenceMaxAgeMs)||this.evidenceMaxAgeMs<1000||this.evidenceMaxAgeMs>3600000)throw error('INVALID_CONFIG','Preflight evidence lifetime must be between 1 second and 1 hour');
  }
  serial(work){const job=this.tail.catch(()=>{}).then(work);this.tail=job;return job;}
  variables(target=''){return {self:this.config.selfId,target,input:this.config.audioRoute.inputName,output:this.config.audioRoute.outputName};}
  active(){return [...this.calls.values()].find(call=>!terminal(call.state));}
  update(call){const prior=this.calls.get(call.id);const fields=({updatedAt,...rest})=>rest;if(prior&&JSON.stringify(fields(prior))===JSON.stringify(fields(call)))return prior;const next={...call,updatedAt:this.now()};this.calls.set(call.id,next);this.emit('call',next);const ended=[...this.calls.values()].filter(c=>terminal(c.state));for(const old of ended.slice(0,-50))this.calls.delete(old.id);return next;}
  markOffline(reason){this.offline=true;this.caps=unavailable(reason);if(!this.stopped&&this.profile.calibrated===true&&this.active()&&this.profile.actions?.hangup){this.caps.hangup={supported:true,reason:'Cleanup requires fresh exact account and target evidence'};this.caps.leaveGroup={...this.caps.hangup};}this.notices=[{id:'desktop-control',level:'error',message:reason}];const current=this.active();if(current&&current.state!=='ending')this.update({...current,state:'ending',error:'Client state unverified; media stopped. Inspect the application before retrying.'});this.emit('status');}
  fingerprint(){return createHash('sha256').update(JSON.stringify([this.config.selfId,this.config.audioRoute,this.profile])).digest('hex');}
  preparedValid(){return this.prepared?.processIdentity===this.processIdentity&&this.prepared.fingerprint===this.fingerprint()&&(this.now()-this.prepared.checkedAt<=this.evidenceMaxAgeMs||this.active()?.id===this.prepared.callId);}
  async rawSnapshot(signal){
    signal?.throwIfAborted();const snapshot=await this.driver.snapshot(signal);signal?.throwIfAborted();
    if(!snapshot||typeof snapshot.epoch!=='string'||typeof snapshot.processIdentity!=='string'||!Array.isArray(snapshot.nodes)||snapshot.nodes.length>2500||snapshot.truncated||!Number.isFinite(snapshot.observedAt)||Math.abs(this.now()-snapshot.observedAt)>15000)throw error('DESKTOP_EVIDENCE','Accessibility tree is incomplete or stale; select a narrower application window');
    if(snapshot.nodes.some(node=>!node||typeof node.id!=='string'||typeof node.visible!=='boolean'||typeof node.enabled!=='boolean'||!Array.isArray(node.actions)))throw error('DESKTOP_EVIDENCE','Invalid accessibility node data');
    if(new Set(snapshot.nodes.map(n=>n.id)).size!==snapshot.nodes.length)throw error('DESKTOP_EVIDENCE','Duplicate accessibility nodes');
    if(this.processIdentity&&snapshot.processIdentity!==this.processIdentity){const current=this.active();if(current)this.update({...current,state:'failed',error:'The bound application process restarted; this session cannot be reused'});this.bootId=randomUUID();this.prepared=null;}
    this.processIdentity=snapshot.processIdentity;return snapshot;
  }
  async snapshot(signal){
    const snapshot=await this.rawSnapshot(signal);
    if(this.profile.evidenceMode==='preflight'){
      if(!this.preparedValid())throw error('DESKTOP_PREFLIGHT_REQUIRED','Account and client audio routes need a fresh preflight');
    }else exactNode(snapshot,this.profile.identity,this.variables());
    return snapshot;
  }
  async prepare(signal){
    if(this.profile.evidenceMode!=='preflight')return this.snapshot(signal);
    if(this.profile.calibrated!==true)throw error('DESKTOP_PREFLIGHT_REQUIRED','Inspect and calibrate settings preflight before enabling desktop calls');
    this.prepared=null;let snapshot=await this.rawSnapshot(signal);const generation=snapshot.processIdentity,verified=new Set();
    for(const step of this.profile.preflight){
      snapshot=await this.rawSnapshot(signal);if(snapshot.processIdentity!==generation)throw error('STALE_CONNECTION','Application changed during identity/audio preflight');
      if(step.kind==='verify'){exactNode(snapshot,this.profile[step.field],this.variables());verified.add(step.field);continue;}
      const node=exactNode(snapshot,step.selector,this.variables());
      if(step.kind==='invoke'){if(!node.enabled||!node.actions.includes('invoke'))throw error('DESKTOP_ACTION','Preflight settings control is unavailable');await this.driver.act(snapshot,node,'invoke',undefined,signal);}
      if(step.waitFor){const deadline=this.now()+this.actionTimeoutMs;while(true){snapshot=await this.rawSnapshot(signal);if(snapshot.processIdentity!==generation)throw error('STALE_CONNECTION','Application changed while opening settings');if(findNodes(snapshot,step.waitFor,this.variables()).length===1)break;if(this.now()>=deadline)throw error('DESKTOP_TIMEOUT','Preflight settings did not appear');await sleep(200,signal);}}
    }
    if(verified.size!==3)throw error('DESKTOP_EVIDENCE','Incomplete preflight');
    snapshot=await this.rawSnapshot(signal);if(snapshot.processIdentity!==generation)throw error('STALE_CONNECTION','Application changed after preflight');
    this.prepared={processIdentity:generation,fingerprint:this.fingerprint(),checkedAt:this.now(),callId:this.active()?.id};return snapshot;
  }
  state(snapshot,target=''){
    const states=Object.entries(this.profile.states).filter(([,selectors])=>matchesAll(snapshot,selectors,this.variables(target))).map(([name])=>name);
    if(states.length!==1)throw error('DESKTOP_STATE_UNKNOWN',`Call state matches ${states.length} definitions; positive, exclusive state evidence is required`);
    return states[0];
  }
  verifyRoute(snapshot,target=''){if(this.profile.evidenceMode==='preflight'){if(!this.preparedValid())throw error('DESKTOP_PREFLIGHT_REQUIRED','Virtual audio route evidence expired');return;}exactNode(snapshot,this.profile.audioInput,this.variables(target));exactNode(snapshot,this.profile.audioOutput,this.variables(target));}
  target(snapshot,desired){
    if(desired){exactNode(snapshot,this.profile.target,this.variables(desired));return desired;}
    const targets=(this.config.targets??[]).filter(target=>target&&typeof target.id==='string'&&findNodes(snapshot,this.profile.target,this.variables(target.id)).length===1);
    if(targets.length!==1)throw error('DESKTOP_TARGET_UNKNOWN','Incoming/current peer or meeting ID is not uniquely identified; calibrate its exact target evidence');
    return targets[0].id;
  }
  reconcile(snapshot){
    const old=this.active(), state=this.state(snapshot,old?.targetId??'');
    if(state==='idle'){if(old)this.update({...old,state:'ended',error:undefined});}
    else{
      const target=this.target(snapshot,old?.targetId);
      if(state==='connected')this.verifyRoute(snapshot,target);
      const targetConfig=(this.config.targets??[]).find(item=>item.id===target),kind=old?.kind??targetConfig?.kind??(this.profile.platform==='wechat'?'direct':'group');
      const call=old??{id:`desktop:${this.bootId}:${randomUUID()}`,kind,direction:state==='ringing'?'incoming':'outgoing',targetId:target,createdAt:this.now(),muted:false,participants:[]};
      if(this.prepared&&this.preparedValid())this.prepared.callId=call.id;
      this.update({...call,state:state==='ringing'?'ringing':state==='connected'?'connected':state==='ending'?'ending':'dialing',error:undefined});
    }
    this.offline=false;this.caps=unavailable('This desktop profile implements calibrated audio call controls only');
    for(const [op,cap] of Object.entries({dial:'dial',join:'joinGroup',accept:'accept',reject:'reject',hangup:'hangup'}))if(this.profile.calibrated===true&&this.profile.actions?.[op])this.caps[cap]={supported:true,reason:'Calibrated accessibility control; operation still verifies account, target and UI evidence'};
    if(this.caps.hangup.supported)this.caps.leaveGroup={...this.caps.hangup};
    if(this.profile.calibrated===true){this.caps.receiveAudio={supported:true,reason:'Virtual audio route must be verified while connected'};this.caps.sendAudio={...this.caps.receiveAudio};}
    this.notices=[{id:'desktop-control',level:'ok',message:'Application and account identified through accessibility'},...(this.profile.evidenceMode==='preflight'?[{id:'desktop-route-scope',level:'warning',message:'Audio routes were checked in client settings before the call. This client does not expose continuous route telemetry; manual changes during a call cannot be detected by hidden settings.'}]:[]),...(this.profile.calibrated===true?[]:[{id:'desktop-profile',level:'warning',message:'Profile is an uncalibrated template; controls are disabled'}])];this.emit('status');return snapshot;
  }
  commitGuards(snapshot,action,op,variables){
    const all=[action.target??this.profile.target],none=[];
    if(this.profile.evidenceMode!=='preflight'){all.push(this.profile.identity);if(['dial','accept'].includes(op))all.push(this.profile.audioInput,this.profile.audioOutput);}
    if(op!=='hangup'){const condition=this.profile.states[this.state(snapshot,variables.target)];all.push(...(Array.isArray(condition)?condition:condition.all));none.push(...(Array.isArray(condition)?[]:condition.none??[]));}
    const resolve=value=>typeof value==='string'?substitute(value,variables):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item)]));
    return {all:all.map(resolve),none:none.map(resolve)};
  }
  async start(){if(!this.stopped)return;this.stopped=false;this.abort=new AbortController();await this.poll();}
  async poll(){if(this.stopped)return;try{await this.serial(async()=>{if(!this.stopped){let snapshot=await this.rawSnapshot(this.abort.signal);if(this.profile.evidenceMode==='preflight'&&!this.preparedValid()){if(this.now()<this.nextPrepareAt)throw error('DESKTOP_PREFLIGHT_REQUIRED','Settings preflight failed; correct the profile or route before the next retry');this.nextPrepareAt=this.now()+30000;snapshot=await this.prepare(this.abort.signal);this.nextPrepareAt=0;}else if(this.profile.evidenceMode!=='preflight')exactNode(snapshot,this.profile.identity,this.variables());this.reconcile(snapshot);}});}catch(failure){if(!this.stopped)this.markOffline(failure.message);}finally{if(!this.stopped)this.timer=setTimeout(()=>this.poll(),this.pollIntervalMs);}}
  async channels(){return (this.config.targets??[]).map(target=>({id:target.id,name:target.name??target.id,kind:target.kind,guildName:target.kind==='direct'?'Configured desktop contact':'Configured desktop meeting; room activity is not inferred'}));}
  async waitFor(selector,variables,signal){const deadline=this.now()+this.actionTimeoutMs;while(true){const snapshot=await this.snapshot(signal);const found=findNodes(snapshot,selector,variables);if(found.length===1)return snapshot;if(found.length>1)throw error('DESKTOP_PROFILE','Expected condition is ambiguous');if(this.now()>=deadline)throw error('DESKTOP_TIMEOUT','Expected UI condition did not appear');await sleep(200,signal);}}
  async control(op,args,requestId,signal){
    if(!['dial','accept','reject','hangup'].includes(op)||typeof requestId!=='string'||!requestId)throw error('INVALID_REQUEST','An explicit supported operation and request ID are required');
    const fingerprint=JSON.stringify([op,args]);const known=this.requests.get(requestId);if(known){if(known.fingerprint!==fingerprint)throw error('IDEMPOTENCY_CONFLICT','Request ID belongs to a different action');return known.promise;}
    const item={fingerprint};item.promise=this.serial(()=>this.perform(op,args,signal));this.requests.set(requestId,item);item.promise.finally(()=>{item.settled=true;for(const[id,entry]of this.requests)if(this.requests.size>200&&entry.settled)this.requests.delete(id);}).catch(()=>{});return item.promise;
  }
  async perform(op,args,signal){
    signal?.throwIfAborted();if(this.stopped||this.profile.calibrated!==true)throw error('CAPABILITY_UNAVAILABLE','The desktop profile must first be inspected and calibrated');
    if(args.media&&args.media!=='audio')throw error('CAPABILITY_UNAVAILABLE','This backend implements audio calls only');
    if(args.groupMode==='create'||args.inviteeIds?.length)throw error('CAPABILITY_UNAVAILABLE','This backend joins explicit existing meeting IDs; it does not create or invite a group implicitly');
    let current=this.active(),target;
    if(op==='dial'){if(current)throw error('CALL_BUSY','The application already has an unfinished call');if(typeof args.targetId!=='string'||!args.targetId||args.targetId.length>512||!['direct','group'].includes(args.kind))throw error('INVALID_TARGET','Specify an exact peer or meeting ID');target=args.targetId;if(!(this.config.targets??[]).some(item=>item.id===target&&item.kind===args.kind))throw error('TARGET_NOT_ALLOWED','Configure this exact peer/meeting ID and call kind in desktop.targets before calling');}
    else{if(!current||current.id!==args.callId||terminal(current.state))throw error('STALE_CALL','Call does not match the active application session');target=current.targetId;}
    const name=op==='dial'&&args.kind==='group'?'join':op, action=this.profile.actions[name];if(!action||action.kind!==(current?.kind??args.kind))throw error('CAPABILITY_UNAVAILABLE','This operation is not calibrated for this call type');
    const variables=this.variables(target);let submitted=false,snapshot=this.profile.evidenceMode==='preflight'&&(['dial','accept'].includes(op)||!this.preparedValid())?await this.prepare(signal):await this.snapshot(signal);const processIdentity=snapshot.processIdentity;
    if(op==='hangup'&&matchesAll(snapshot,this.profile.states.idle,variables)){this.reconcile(snapshot);return {submitted:false,evidence:'already-idle-observed',remoteConfirmed:false};}
    const state=op==='hangup'?null:this.state(snapshot,target);if(op==='dial'&&state!=='idle'||['accept','reject'].includes(op)&&state!=='ringing')throw error('INVALID_STATE','The application is no longer in the expected state');
    try{
      for(const step of action.steps){
        signal?.throwIfAborted();snapshot=await this.snapshot(signal);if(snapshot.processIdentity!==processIdentity)throw error('STALE_CONNECTION','Application restarted during the control sequence');
        const node=exactNode(snapshot,step.selector,variables);
        if(step.commit){exactNode(snapshot,action.target??this.profile.target,variables);
          if(op==='dial'&&this.state(snapshot,target)!=='idle'||['accept','reject'].includes(op)&&this.state(snapshot,target)!=='ringing')throw error('INVALID_STATE','Call state changed during preparation');
          if(['dial','accept'].includes(op))this.verifyRoute(snapshot,target);}
        if(step.kind!=='assert'){
          if(!node.enabled||!node.actions.includes(step.kind))throw error('DESKTOP_ACTION','The selected semantic control is unavailable');
          if(step.commit){submitted=true;if(op==='dial')current=this.update({id:`desktop:${this.bootId}:${randomUUID()}`,kind:args.kind,direction:'outgoing',state:'dialing',targetId:target,createdAt:this.now(),participants:[],muted:false});else current=this.update({...current,state:op==='accept'?'connecting':'ending'});}
          if(step.commit&&this.prepared)this.prepared.callId=current.id;
          await this.driver.act(snapshot,node,step.kind,step.value===undefined?undefined:substitute(step.value,variables),signal,step.commit?this.commitGuards(snapshot,action,op,variables):undefined);
        }
        if(step.waitFor)await this.waitFor(step.waitFor,variables,signal);
      }
      const deadline=this.now()+this.actionTimeoutMs;
      while(true){
        snapshot=await this.snapshot(signal);if(snapshot.processIdentity!==processIdentity)throw error('STALE_CONNECTION','Application changed after call control submission');
        const next=this.state(snapshot,target);
        if(['hangup','reject'].includes(op)&&next==='idle'||['dial','accept'].includes(op)&&['dialing','connected'].includes(next)){
          // An unchanged incoming ringing indicator cannot confirm an accept.
          if(op==='accept'&&next==='ringing'){}else{this.reconcile(snapshot);return op==='dial'?this.calls.get(current.id):{submitted:true,evidence:'accessibility-state-transition',remoteConfirmed:next==='connected'};}
        }
        if(this.now()>=deadline)throw error('RESULT_UNKNOWN','Control was submitted but no matching call-state transition was observed');await sleep(200,signal);
      }
    }catch(failure){if(submitted&&current){this.update({...current,state:'ending',error:'Action outcome unconfirmed; media stopped. Inspect the client before cleanup.'});this.markOffline(failure.message);}throw failure;}
  }
  async stop(){if(this.stopped)return;this.stopped=true;this.abort?.abort();clearTimeout(this.timer);await this.driver.stop();this.markOffline('Desktop control stopped; the client itself was left open');}
}
export async function createDesktopControl(config){const desktop={...config.desktop,selfId:config.account?.selfId,platform:config.account?.platform};if(desktop.profileFile)desktop.profile=JSON.parse(await fs.readFile(desktop.profileFile,'utf8'));return new DesktopControl(desktop);}
