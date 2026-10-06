#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createAudioBackend } from './audio/index.mjs';

const capabilities = reason => Object.fromEntries(['dial','dialScreen','accept','reject','hangup','joinGroup','startGroup','leaveGroup','receiveAudio','sendAudio','receiveVideo','sendVideo','shareScreen','participants','speakerIdentity','mute'].map(k=>[k,{supported:false,reason}]));
const terminal = s => ['ended','failed'].includes(s);
const needsNativeCleanup = call => call?.phase !== 'ended' &&
  (call?.nativeTeardownUnknown === true || call?.nativeAckTimedOut === true);
const error = (code,message) => Object.assign(new Error(message),{code});
const sameCall = (left,right) => {
  const {updatedAt: _leftTime,...a}=left, {updatedAt: _rightTime,...b}=right;
  return isDeepStrictEqual(a,b);
};
export class QqControl extends EventEmitter {
  constructor(config) {
    super(); this.config=config; this.calls=new Map(); this.caps=capabilities('QQ 控制桥接尚未连接');
    this.cursor=0; this.stopped=true; this.bootId=''; this.notices=[]; this.linkEpoch=0; this.offline=true; this.lifecycle=0;
  }
  async request(route,body,requestId,signal) {
    const url = new URL(this.config.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw error('INVALID_URL','QQ 控制桥必须是本机 HTTP 或远程 HTTPS');
    const signals=[AbortSignal.timeout(route.startsWith('/v1/video/')?20000:4000)]; if(this.abort)signals.push(this.abort.signal); if(signal)signals.push(signal);
    const response=await fetch(new URL(route,url),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.config.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify({...body,requestId:requestId||randomUUID()}):undefined,signal:AbortSignal.any(signals)});
    const result=await response.json(); if(!response.ok||result?.ok!==true) throw error(result?.error?.code||'QQ_BRIDGE_ERROR',result?.error?.message||'QQ 桥接请求失败');
    return result.data;
  }
  identity(state) {
    if(!state?.selfId || String(state.selfId)!==String(this.config.selfId))throw error('ACCOUNT_MISMATCH','QQ 控制桥实际登录账号与配置不一致');
    if(typeof state.bootId!=='string'||!state.bootId||state.bootId.length>100)throw error('INVALID_STATUS','QQ 控制桥没有有效启动标识');
  }
  fail(message) {
    if(!this.offline)this.linkEpoch++;
    this.offline=true; this.caps=capabilities(message); this.notices=[{id:'qq',level:'error',message}];
    for(const c of [...this.calls.values()])if(!terminal(c.state))this.update({...c,state:'failed',error:'QQ 控制连接丢失；请检查客户端中的实际通话'});
    this.emit('status');
  }
  async start() {
    if(!this.stopped)return;
    this.stopped=false; this.lifecycle++; this.abort=new AbortController(); await this.poll();
  }
  async poll() {
    if(this.stopped)return; const lifecycle=this.lifecycle, linkEpoch=this.linkEpoch;
    try {
      // status carries identity, boot ID and the call in one response. A naked
      // current-call response can belong to a different process after restart.
      const [cap,result,state]=await Promise.all([this.request('/v1/capabilities'),this.request(`/v1/events?after=${this.cursor}&bootId=${encodeURIComponent(this.bootId)}`),this.request('/v1/status')]);
      if(this.stopped||this.lifecycle!==lifecycle||this.linkEpoch!==linkEpoch)return;
      this.identity(cap); this.identity(state);
      if(cap.bootId!==state.bootId||cap.bootId!==result?.bootId||!Number.isSafeInteger(result.nextSeq)||result.nextSeq<0||!Array.isArray(result.events))throw error('INVALID_STATUS','QQ 控制桥在读取期间重启或返回了无效状态');
      if(this.bootId&&this.bootId!==state.bootId)for(const c of [...this.calls.values()])if(!terminal(c.state))this.update({...c,state:'failed',error:'QQ 控制桥已重启'});
      this.bootId=state.bootId; this.cursor=result.nextSeq; this.offline=false;
      const caps=capabilities('QQ AVSDK 暂未提供此能力');
      for(const [a,b] of Object.entries({dial:'private.dial',dialScreen:'private.screenDial',accept:'private.accept',reject:'private.reject',hangup:'private.hangup',joinGroup:'group.join',startGroup:'group.start',leaveGroup:'group.leave',participants:'group.participants'})) { const c=cap.capabilities?.[b];caps[a]={supported:c?.status==='supported',reason:c?.reason||'未知能力'}; }
      // Video discovery is independent of the 400 ms voice/status poll. A slow
      // video Host must not freeze call lifecycle or PCM state reconciliation.
      const videoKey=`${state.bootId}:${linkEpoch}`;
      if(this.videoCapsKey===videoKey)for(const key of ['receiveVideo','sendVideo','shareScreen'])caps[key]=this.videoCaps[key];
      if(!this.videoProbe&&(this.videoCapsKey!==videoKey||Date.now()-(this.videoCapsAt||0)>2000)){
        this.videoProbe=(async()=>{
          const next=capabilities('此原生 Host 未提供视频能力');
          try{const video=await this.request('/v1/video/state');if(video?.supported===true){
            next.receiveVideo={supported:true,reason:'已实现原生视频订阅；帧与接通状态分开验证'};
            next.sendVideo={supported:video.sendSupported===true,reason:'须明确选择摄像头渠道的视频来源；本端 ACK 不代表远端已收到画面'};
            next.shareScreen={supported:video.shareScreenSupported===true,reason:'须明确选择屏幕共享渠道的视频来源；可用来源由 Host 枚举，本端 ACK 不代表远端已收到画面'};
          }}catch{}
          if(this.stopped||this.lifecycle!==lifecycle||this.linkEpoch!==linkEpoch||this.bootId!==state.bootId||this.offline)return;
          this.videoCaps=next;this.videoCapsKey=videoKey;this.videoCapsAt=Date.now();
          for(const key of ['receiveVideo','sendVideo','shareScreen'])this.caps[key]=next[key];this.emit('status');
        })().finally(()=>{this.videoProbe=undefined;});
      }
      this.caps=caps; this.notices=[{id:'qq',level:'ok',message:'已连接 QQ 控制桥'}];
      if(result.gap)this.notices.push({id:'gap',level:'warning',message:'控制事件已过期，已重新读取当前通话状态'});
      const current=state.call;
      // Historical active events must never become new live calls after a gap
      // or transport epoch change. Only the authoritative snapshot may do so.
      for(const e of result.events)if(e?.type==='call.state'&&e.call&&(e.call.id===current?.id||e.call.phase==='ended'||e.call.phase==='error'&&!needsNativeCleanup(e.call)))this.ingest(e.call);
      if(current)this.ingest(current);
      const currentId=current?`${this.bootId}:${this.linkEpoch}:${current.id}`:undefined;
      for(const c of [...this.calls.values()])if(!terminal(c.state)&&c.id!==currentId)this.update({...c,state:'failed',error:'QQ 当前快照中已无此通话'});
      this.emit('status');
    } catch(e) {
      if(!this.stopped&&this.lifecycle===lifecycle)this.fail(e.message);
    } finally { if(!this.stopped&&this.lifecycle===lifecycle)this.timer=setTimeout(()=>this.poll(),this.offline?2000:400); }
  }
  ingest(c) {
    if(!c||typeof c.id!=='string'||!c.id||c.id.length>100||!['private','group'].includes(c.kind))return;
    const phaseState={ringing:'ringing',accepting:'connecting',accepted:'connecting',connected:'connected',ended:'ended',error:'failed',dialing:'dialing',calling:'dialing',joining:'connecting',rejecting:'ending',ending:'ending'}[c.phase];if(!phaseState)return;
    // A native failure/timeout is not evidence that the room was left. Keep
    // the call controllable and stop PCM until explicit teardown is observed.
    const cleanup=needsNativeCleanup(c), state=cleanup?'ending':phaseState;
    const nativeError=typeof c.nativeError==='string'?c.nativeError.slice(0,350):'';
    const callError=cleanup?`QQ 通话未确认结束，请${c.kind==='group'?'退出语音':'挂断'}清理${nativeError?`：${nativeError}`:''}`:
      state==='failed'?nativeError||'QQ 通话失败':state==='ended'&&nativeError?nativeError:undefined;
    const id=`${this.bootId}:${this.linkEpoch}:${c.id}`;const old=this.calls.get(id);
    if(old&&terminal(old.state)&&!terminal(state))return;
    const next={id,nativeId:c.id,kind:c.kind==='group'?'group':'direct',direction:c.direction==='outgoing'?'outgoing':'incoming',state,targetId:String(c.kind==='group'?c.groupId||'unknown':c.direction==='outgoing'?c.peerUin||c.peerUid||'unknown':c.callerUin||c.callerUid||'unknown'),createdAt:old?.createdAt??(Date.parse(c.inviteAt||c.createdAt)||Date.now()),participants:Array.isArray(c.participants)?[...new Set(c.participants.filter(p=>p&&typeof p.uid==='string').map(p=>p.uid))].sort().slice(0,500).map(id=>({id,identity:'platform'})):[],muted:old?.muted??false,error:callError};
    this.update(next);
  }
  update(call) {
    const old=this.calls.get(call.id);
    // Polling, property order and caller-supplied timestamps are not changes.
    // Preserve the stored object/time until a public call field really changes.
    if(old&&sameCall(old,call))return old;
    const next={...call,updatedAt:Date.now()};this.calls.set(next.id,next);this.emit('call',next);
    const ended=[...this.calls.values()].filter(c=>terminal(c.state));for(const stale of ended.slice(0,-50))this.calls.delete(stale.id);
    return next;
  }
  async verify(signal) {
    signal?.throwIfAborted();
    if(this.stopped||this.offline||!this.bootId)throw error('QQ_OFFLINE','QQ 控制桥尚未验证账号身份');
    const lifecycle=this.lifecycle, epoch=this.linkEpoch, bootId=this.bootId;
    try {
      const state=await this.request('/v1/capabilities',undefined,undefined,signal); signal?.throwIfAborted(); this.identity(state);
      if(this.stopped||this.lifecycle!==lifecycle||this.offline||this.linkEpoch!==epoch||this.bootId!==bootId||state.bootId!==bootId)throw error('STALE_CONNECTION','QQ 控制连接已改变，请重新读取通话状态');
      return state;
    } catch(e) { if(!signal?.aborted&&!this.stopped&&this.lifecycle===lifecycle)this.fail(e.message); throw e; }
  }
  async channels() {
    await this.verify(); const state=await this.request('/v1/groups/current');
    return (state.groups||[]).filter(g=>g.isAudio&&g.onlineCount>0&&!g.nativeTimeout&&Date.now()-Date.parse(g.observedAt)<=state.activityMaxAgeMs).map(g=>({id:g.groupId,name:`QQ 群 ${g.groupId} · ${g.onlineCount} 人`,kind:'group',guildName:'正在进行的群语音'}));
  }
  async control(op,args,requestId,signal) {
    const verified=await this.verify(signal), epoch=this.linkEpoch, lifecycle=this.lifecycle;
    if(op==='dial'&&(args.media!==undefined&&!['audio','video','screen'].includes(args.media)||['video','screen'].includes(args.media)&&args.kind!=='direct'))throw error('INVALID_TARGET','视频或屏幕共享邀请仅适用于私聊，媒体类型必须为 audio、video 或 screen');
    const key=op==='dial'?(args.kind==='group'?(args.groupMode==='create'?'group.start':'group.join'):(args.media==='screen'?'private.screenDial':'private.dial')):op==='hangup'&&this.calls.get(args.callId)?.kind==='group'?'group.leave':`private.${op}`;
    if(verified.capabilities?.[key]?.status!=='supported')throw error('CAPABILITY_UNAVAILABLE',verified.capabilities?.[key]?.reason||'QQ 当前不支持此操作');
    if(op==='dial') {
      const group=args.kind==='group', create=group&&args.groupMode==='create';const response=await this.request(group?(create?'/v1/groups/start':'/v1/groups/join'):'/v1/calls/dial',group?{groupId:args.targetId,...(create?{inviteeIds:args.inviteeIds||[]}: {})}:{peerUid:args.targetId,...(args.media===undefined?{}:{media:args.media})},requestId,signal);
      const state=await this.request('/v1/status',undefined,undefined,signal);signal?.throwIfAborted();this.identity(state);
      if(this.stopped||this.lifecycle!==lifecycle||this.offline||this.linkEpoch!==epoch||state.bootId!==verified.bootId)throw error('RESULT_UNKNOWN','拨号后控制连接改变；请检查客户端');
      if(state.call)this.ingest(state.call);
      const c=[...this.calls.values()].find(c=>c.id.startsWith(`${verified.bootId}:${epoch}:`)&&c.nativeId===response.callId&&!terminal(c.state));
      if(!c)throw error('RESULT_UNKNOWN','拨号已提交，但尚无确认的通话标识；请查看客户端');return c;
    }
    const c=this.calls.get(args.callId);if(!c||terminal(c.state)||!c.id.startsWith(`${verified.bootId}:${epoch}:`))throw error('STALE_CALL','此通话已经结束或来自旧连接');
    const route=op==='hangup'&&c.kind==='group'?'/v1/groups/leave':`/v1/calls/${op}`;
    return this.request(route,{callId:c.nativeId},requestId,signal);
  }
  async video(op,args,requestId,signal) {
    await this.verify(signal); const lifecycle=this.lifecycle,epoch=this.linkEpoch,bootId=this.bootId;
    const call=this.calls.get(args.callId),cleanup=['unsubscribe','stop','state'].includes(op);
    if(!call||!call.id.startsWith(`${bootId}:${epoch}:`)||(!cleanup&&call.state!=='connected'))throw error('STALE_CALL','视频请求不属于当前已连接的通话');
    if(!['state','sources','subscribe','unsubscribe','frame','send','stop','write'].includes(op))throw error('INVALID_REQUEST','未知视频操作');
    if(op==='send'&&args.framing!==undefined&&(!['full','portrait-safe'].includes(args.framing)||args.kind!=='camera'||args.sourceId!=='external-frames'))throw error('INVALID_SOURCE','画幅仅适用于external-frames摄像头渠道');
    let result;
    if(op==='state'||op==='sources')result=await this.request(`/v1/video/${op}`,undefined,undefined,signal);
    else if(op==='frame')result=await this.request(`/v1/video/frame?${new URLSearchParams({callId:call.nativeId,trackId:args.trackId})}`,undefined,undefined,signal);
    else result=await this.request(`/v1/video/${op}`,{callId:call.nativeId,...(op==='subscribe'?{uid:args.participantId,kind:args.kind}:op==='unsubscribe'?{trackId:args.trackId}:op==='send'?{kind:args.kind,sourceId:args.sourceId,...(args.framing===undefined?{}:{framing:args.framing})}:op==='write'?{kind:args.kind,encoding:args.encoding,width:args.width,height:args.height,sequence:args.sequence,timestamp:args.timestamp,data:args.data}:{kind:args.kind})},requestId,signal);
    if(this.stopped||this.offline||this.lifecycle!==lifecycle||this.linkEpoch!==epoch||this.bootId!==bootId)throw error('RESULT_UNKNOWN','视频操作期间控制连接已改变');
    if(op==='sources')return result;
    if(op==='write'){if(result?.callId!==call.nativeId)throw error('INVALID_VIDEO','视频写入回执来自另一通话');return {...result,callId:call.id};}
    if(op==='frame'){
      if(result===null)return null;
      if(result?.callId!==call.nativeId)throw error('INVALID_VIDEO','视频帧来自另一通话');
      return {...result,callId:call.id};
    }
    if(result?.sessionId!==null&&result?.sessionId!==call.nativeId)throw error('STALE_CALL','视频会话已改变');
    return {...result,sessionId:result.sessionId===null?null:call.id};
  }
  async stop() { this.stopped=true;this.lifecycle++;this.abort?.abort();clearTimeout(this.timer);this.fail('QQ 控制桥已停止'); }
}

/** No audio is recorded to disk. Only one authenticated Koishi connection owns media. */
export async function createControl(config) {
  if(config.desktop){const {createDesktopControl}=await import('./desktop/control.mjs');return createDesktopControl(config);}
  return new QqControl({...config.qq,selfId:config.account?.selfId});
}
export async function createDaemon(config,{control,audio=createAudioBackend(config.audio),persistAudio}={}) {
  control ??= await createControl(config);
  if(!['127.0.0.1','::1','localhost'].includes(config.host||'127.0.0.1'))throw new Error('桥接仅监听本机；远程部署请使用 SSH 隧道或本机 TLS 反向代理');
  if(typeof config.token!=='string'||Buffer.byteLength(config.token)<32)throw new Error('桥接令牌至少需要 32 字节');
  if(typeof config.account?.selfId!=='string'||!config.account.selfId||typeof config.account.platform!=='string'||!config.account.platform)throw new Error('请配置桥接账号标识');
  let peer,peerAbort,activeAudio,startingAudio,mediaStop,stopping=false,stopPromise,mediaError,mediaReady=false,configuring=false,syncQueued;
  let operationTail=Promise.resolve();
  const playback=new Map();
  const serial=task=>{const job=operationTail.then(task);operationTail=job.catch(()=>{});return job;};
  const authorized=req=>{const a=Buffer.from(req.headers.authorization||''),b=Buffer.from(`Bearer ${config.token}`);return a.length===b.length&&timingSafeEqual(a,b);};
  const owns=socket=>!stopping&&peer===socket&&socket?.readyState===WebSocket.OPEN;
  const requireOwner=socket=>{if(!owns(socket))throw error('OWNER_DISCONNECTED','此连接已释放媒体控制权');};
  const sendTo=(socket,packet)=>{
    if(socket?.readyState!==WebSocket.OPEN)return;
    if(socket.bufferedAmount>512*1024){socket.close(1013,'audio consumer too slow');return;}
    try {socket.send(JSON.stringify(packet));}catch{socket.terminate();}
  };
  const send=packet=>sendTo(peer,packet);
  let videoTail=Promise.resolve(),videoPolling=false;
  const videoSessions=new Map();
  const videoSerial=task=>{const job=videoTail.then(task);videoTail=job.catch(()=>{});return job;};
  const videoNotice=e=>{
    const message=e.message||String(e);lastDiagnostics=[...lastDiagnostics.filter(d=>d.id!=='video'),{id:'video',level:'warning',message}];
    send({type:'error',message});sendStatus();
  };
  const videoCall=(socket,id,connected=true)=>{
    requireOwner(socket);const call=control.calls.get(id);
    if(typeof id!=='string'||!call||connected&&call.state!=='connected')throw error('NOT_CONNECTED','视频需要当前已连接的通话');
    if(typeof control.video!=='function')throw error('CAPABILITY_UNAVAILABLE','控制桥没有视频接口');return call;
  };
  const dropVideoWrite=(job,evidence)=>job.resolve({callId:job.frame.callId,kind:job.frame.kind,sequence:job.frame.sequence,state:'dropped',acceptedBytes:0,evidence});
  const closeVideoOutputs=(entry,kind)=>{
    const drains=[];
    for(const [channel,output]of entry.outputs||[])if(kind===undefined||channel===kind){
      output.closed=true;if(output.running)drains.push(output.running);if(output.pending)dropVideoWrite(output.pending,'video-source-stopped-before-submit');output.pending=undefined;entry.outputs.delete(channel);
    }
    return drains;
  };
  const drainVideoWrites=entry=>Promise.allSettled([...(entry.drains||[])]);
  const writeVideo=(socket,args)=>{
    const call=videoCall(socket,args.callId),entry=videoSessions.get(call.id),kind=args.kind;
    if(!['camera','screen'].includes(kind)||!control.caps[kind==='screen'?'shareScreen':'sendVideo']?.supported)throw error('CAPABILITY_UNAVAILABLE','当前后端不支持此视频渠道');
    const output=entry?.outputs.get(kind);
    if(!entry||entry.revoked||entry.owner!==socket||!output||output.closed)throw error('VIDEO_SOURCE_REQUIRED','请先明确开启可写入帧的视频来源');
    if(args.encoding!=='jpeg'||!Number.isInteger(args.width)||args.width<1||args.width>4096||!Number.isInteger(args.height)||args.height<1||args.height>4096||args.width*args.height>2073600||!Number.isSafeInteger(args.sequence)||args.sequence<0||!Number.isFinite(args.timestamp)||args.timestamp<0||typeof args.data!=='string'||args.data.length>349528||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data))throw error('INVALID_VIDEO','需要最多256KiB的JPEG帧及有效尺寸与序号');
    const bytes=Buffer.from(args.data,'base64');if(bytes.length<4||bytes.length>256*1024||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)throw error('INVALID_VIDEO','JPEG帧无效');
    if(args.sequence<=output.sequence)throw error('VIDEO_SEQUENCE','视频序号必须递增');output.sequence=args.sequence;
    const frame={callId:call.id,kind,encoding:'jpeg',width:args.width,height:args.height,sequence:args.sequence,timestamp:args.timestamp,data:args.data};
    const receipt=new Promise((resolve,reject)=>{if(output.pending)dropVideoWrite(output.pending,'newer-video-frame-before-submit');output.pending={frame,resolve,reject};});
    const pump=()=>{
      if(output.running||output.closed||!output.pending)return;
      const running=(async()=>{
        while(!output.closed&&output.pending){const job=output.pending;output.pending=undefined;
          try{
            videoCall(socket,call.id);
            if(entry.revoked||entry.outputs.get(kind)!==output)throw error('VIDEO_SOURCE_REQUIRED','视频来源已撤销');
            const result=await control.video('write',job.frame);
            videoCall(socket,call.id);
            if(output.closed||entry.revoked)throw error('RESULT_UNKNOWN','写入期间视频已停止，请勿重放旧帧');
            if(!result||result.callId!==call.id||result.kind!==kind||result.sequence!==job.frame.sequence||!['accepted','rendered','submitted','dropped','failed'].includes(result.state)||typeof result.evidence!=='string'||!result.evidence||result.evidence.length>500||result.acceptedBytes!==undefined&&(!Number.isSafeInteger(result.acceptedBytes)||result.acceptedBytes<0||result.acceptedBytes>Buffer.byteLength(job.frame.data,'base64')))throw error('INVALID_VIDEO','视频写入回执与提交帧不一致');
            job.resolve(result);
          }catch(e){if(!output.closed){entry.revoked=true;closeVideoOutputs(entry);}job.reject(e);}
        }
      })();
      output.running=running;entry.drains.add(running);
      void running.finally(()=>{output.running=undefined;entry.drains.delete(running);pump();});
    };
    pump();return receipt;
  };
  const cleanupVideo=async entry=>{
    closeVideoOutputs(entry);await drainVideoWrites(entry);
    const failures=[];
    // A subscription request can have reached native code before its reply was
    // lost. Resolve only this owner's reserved participant/kind pairs by state.
    if([...entry.tracks.values()].some(track=>!track.trackId)){
      try{const state=await control.video('state',{callId:entry.callId});
        for(const track of entry.tracks.values())if(!track.trackId)track.trackId=state.tracks?.find(item=>item.uid===track.participantId&&item.kind===track.kind&&item.subscribed)?.id;
      }catch(e){failures.push(e);}
    }
    for(const [key,track]of entry.tracks)if(track.trackId){
      try{await control.video('unsubscribe',{callId:entry.callId,trackId:track.trackId},randomUUID());entry.tracks.delete(key);}catch(e){failures.push(e);}
    }else if(!failures.length)entry.tracks.delete(key);
    for(const kind of entry.sending){try{await control.video('stop',{callId:entry.callId,kind},randomUUID());entry.sending.delete(kind);}catch(e){failures.push(e);}}
    if(failures.length)throw error('VIDEO_CLEANUP_UNKNOWN','视频清理结果未知，请重新停止视频或释放控制权：'+failures[0].message);
    if(videoSessions.get(entry.callId)===entry)videoSessions.delete(entry.callId);
  };
  const revokeVideo=(callId,owner)=>{
    const jobs=[];
    for(const entry of videoSessions.values())if((callId===undefined||entry.callId===callId)&&(owner===undefined||entry.owner===owner)){
      entry.revoked=true;closeVideoOutputs(entry);
      if(!entry.cleanup)entry.cleanup=videoSerial(()=>cleanupVideo(entry)).finally(()=>{entry.cleanup=undefined;});
      jobs.push(entry.cleanup);
    }
    return Promise.all(jobs);
  };
  const videoOperation=async(socket,op,args,requestId)=>{
    const cleanup=['clear','unsubscribe','stop'].includes(op),call=videoCall(socket,args.callId,!cleanup);
    let entry=videoSessions.get(call.id);
    if(op==='clear'){if(entry){entry.revoked=true;await cleanupVideo(entry);}return {cleared:true};}
    if(entry?.revoked){
      if(!cleanup)throw error('VIDEO_CLEANUP_REQUIRED','之前的视频清理尚未确认，请先停止视频');
      // Already executing on videoTail: clean directly, never await a queued job
      // behind ourselves. This also permits a new owner to finish old cleanup.
      await cleanupVideo(entry);entry=undefined;
    }
    if(entry&&entry.owner!==socket)throw error('VIDEO_BUSY','视频资源尚未由上一个控制者释放');
    if(op==='state')return control.video('state',{callId:call.id});
    if(op==='sources'){
      if(!control.caps.sendVideo?.supported&&!control.caps.shareScreen?.supported)throw error('CAPABILITY_UNAVAILABLE','当前后端不支持视频来源发送');
      return control.video('sources',{callId:call.id});
    }
    if(!['subscribe','unsubscribe','send','stop'].includes(op))throw error('INVALID_REQUEST','未知视频操作');
    if(op==='subscribe'){
      if(!control.caps.receiveVideo?.supported)throw error('CAPABILITY_UNAVAILABLE','当前后端不支持视频订阅');
      if(!['camera','screen'].includes(args.kind)||typeof args.participantId!=='string'||!args.participantId||args.participantId.length>160||!call.participants.some(member=>member.identity==='platform'&&member.id===args.participantId))throw error('INVALID_TRACK','视频目标必须是当前通话的真实成员');
    }
    let source;
    if(op==='send'){
      if(!['camera','screen'].includes(args.kind)||!control.caps[args.kind==='screen'?'shareScreen':'sendVideo']?.supported)throw error('CAPABILITY_UNAVAILABLE','当前后端不支持此视频发送类型');
      if(typeof args.sourceId!=='string'||!args.sourceId||args.sourceId.length>2048)throw error('INVALID_SOURCE','必须明确选择视频来源');
      if(args.framing!==undefined&&(!['full','portrait-safe'].includes(args.framing)||args.kind!=='camera'||args.sourceId!=='external-frames'))throw error('INVALID_SOURCE','画幅仅适用于external-frames摄像头渠道，必须为full或portrait-safe');
      const sources=await control.video('sources',{callId:call.id});videoCall(socket,call.id);
      source=Array.isArray(sources)&&sources.find(source=>source.id===args.sourceId&&source.kind===args.kind);
      if(!source)throw error('INVALID_SOURCE','视频来源不在当前列表中');
    }
    if(op==='stop'&&!['camera','screen'].includes(args.kind)||op==='unsubscribe'&&(typeof args.trackId!=='string'||!args.trackId||args.trackId.length>512))throw error('INVALID_REQUEST','无效视频清理参数');
    if(!entry){entry={callId:call.id,owner:socket,tracks:new Map(),sending:new Set(),outputs:new Map(),drains:new Set(),revoked:false};videoSessions.set(call.id,entry);}
    const previousOutput=entry.outputs.get(args.kind),reuseOutput=op==='send'&&previousOutput&&!previousOutput.closed&&previousOutput.sourceId===args.sourceId&&previousOutput.framing===(args.framing??'full');
    if((op==='send'||op==='stop')&&!reuseOutput){await Promise.allSettled(closeVideoOutputs(entry,args.kind));videoCall(socket,call.id,!cleanup);}
    let reserved;
    if(op==='subscribe'){
      const key=`${args.kind}\0${args.participantId}`;reserved=entry.tracks.get(key);
      if(!reserved&&entry.tracks.size>=4)throw error('VIDEO_LIMIT','同时最多订阅四路视频');
      if(!reserved){reserved={participantId:args.participantId,kind:args.kind,sequence:-1};entry.tracks.set(key,reserved);}
    }else if(op==='send')entry.sending.add(args.kind);
    // Do not abort native mutations with the peer's lifetime signal: retain the
    // bounded request outcome, then run the queued owner's cleanup even if gone.
    let result;
    try{result=await control.video(op,{callId:call.id,...(op==='subscribe'?{participantId:args.participantId,kind:args.kind}:op==='unsubscribe'?{trackId:args.trackId}:op==='send'?{kind:args.kind,sourceId:args.sourceId,...(args.framing===undefined?{}:{framing:args.framing})}:{kind:args.kind})},requestId);}
    catch(e){entry.revoked=true;closeVideoOutputs(entry);throw e;}
    if(op==='send'&&(result?.sending?.[args.kind]?.framing??'full')!==(args.framing??'full')){entry.revoked=true;closeVideoOutputs(entry);throw error('INVALID_VIDEO','后端未确认请求的视频画幅，请先停止此渠道');}
    if(op==='subscribe'){
      const track=result?.tracks?.find(item=>item.uid===reserved.participantId&&item.kind===reserved.kind&&item.subscribed);
      if(!track||typeof track.id!=='string'||!track.id||track.id.length>512){entry.revoked=true;throw error('INVALID_VIDEO','后端未返回匹配视频轨道');}reserved.trackId=track.id;
    }else if(op==='unsubscribe'){for(const [key,track]of entry.tracks)if(track.trackId===args.trackId)entry.tracks.delete(key);}
    else if(op==='stop')entry.sending.delete(args.kind);
    else if(op==='send'&&!reuseOutput&&source.sourceType==='frames'&&(!source.channels||source.channels.includes(args.kind))&&result?.sending?.[args.kind]?.sourceId===args.sourceId&&result.sending[args.kind].state==='sending')entry.outputs.set(args.kind,{sourceId:source.id,framing:args.framing??'full',sequence:-1,closed:false});
    videoCall(socket,call.id,!cleanup);return result;
  };
  const pollVideo=async()=>{
    if(stopping||videoPolling)return;videoPolling=true;
    try{await Promise.all([...videoSessions.values()].flatMap(entry=>entry.revoked||!owns(entry.owner)?[]:[...entry.tracks.values()].filter(track=>track.trackId).map(async track=>{
      const current=()=>!entry.revoked&&!track.revoked&&videoSessions.get(entry.callId)===entry&&owns(entry.owner)&&control.calls.get(entry.callId)?.state==='connected'&&control.calls.get(entry.callId).participants.some(member=>member.identity==='platform'&&member.id===track.participantId)&&entry.tracks.get(`${track.kind}\0${track.participantId}`)===track;
      if(!current()||!control.caps.receiveVideo?.supported)return;
      try{
        const frame=await control.video('frame',{callId:entry.callId,trackId:track.trackId});
        if(!frame||!current())return;
        if(frame.callId!==entry.callId||frame.trackId!==track.trackId||frame.participantId!==track.participantId||frame.kind!==track.kind||frame.encoding!=='jpeg'||!['native-first-frame-and-render-capture','native-decoded-size-change-and-render-capture'].includes(frame.evidence)||!Number.isInteger(frame.width)||frame.width<1||frame.width>8192||!Number.isInteger(frame.height)||frame.height<1||frame.height>8192||!Number.isSafeInteger(frame.sequence)||frame.sequence<=track.sequence||!Number.isFinite(frame.timestamp)||frame.timestamp<0||typeof frame.data!=='string'||frame.data.length>349528||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))return;
        const bytes=Buffer.from(frame.data,'base64');if(bytes.length<4||bytes.length>256*1024||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return;
        const packet=JSON.stringify({type:'video',frame:{callId:entry.callId,trackId:track.trackId,participantId:track.participantId,kind:track.kind,encoding:'jpeg',evidence:frame.evidence,width:frame.width,height:frame.height,sequence:frame.sequence,timestamp:frame.timestamp,data:frame.data}});
        // Video is lossy and leaves headroom for PCM/control on this transport.
        if(entry.owner.bufferedAmount+Buffer.byteLength(packet)>384*1024)return;
        entry.owner.send(packet);track.sequence=frame.sequence;
      }catch(e){if(current()&&entry.lastError!==e.message){entry.lastError=e.message;videoNotice(e);}}
    })));}finally{videoPolling=false;}
  };
  const videoTimer=setInterval(()=>{void pollVideo().catch(videoNotice);},150);videoTimer.unref();
  const safeCall=c=>{const {nativeId,...safe}=c;return safe;};
  const diagnostics=async(retry=false)=>{
    try {
      const ds=await audio.diagnostics();
      if(retry&&!ds.some(d=>d.level==='error'))mediaError=undefined;
      mediaReady=!mediaError&&!ds.some(d=>d.level==='error');
      return [...(control.notices||[]),...ds,...(mediaError?[{id:'media-runtime',level:'error',message:mediaError}]:[])];
    }catch(e){mediaReady=false;return [...(control.notices||[]),{id:'audio',level:'error',message:e.message}];}
  };
  let lastDiagnostics=await diagnostics();
  // Desktop accessibility profiles own account/route authorization. A working
  // audio device alone must not upgrade an uncalibrated or revoked profile.
  // QQ's independent virtual-audio bridge continues to own its audio capability.
  const mediaAuthorized=()=>mediaReady&&control.offline!==true&&control.stopped!==true&&(!config.desktop||control.caps.receiveAudio?.supported===true&&control.caps.sendAudio?.supported===true);
  const status=type=>{
    const caps=structuredClone(control.caps), canAudio=mediaAuthorized();
    for(const key of ['receiveAudio','sendAudio','mute'])caps[key]={supported:canAudio,reason:canAudio?'已配置独立音频设备':config.desktop?'请先校准并验证桌面账号、目标和虚拟音频路由':'请先完成音频设备诊断'};
    return {type,version:1,account:config.account,audioFormat:{sampleRate:config.audio.sampleRate||48000,channels:config.audio.channels||1,encoding:'pcm_s16le'},capabilities:caps,calls:[...control.calls.values()].map(safeCall),diagnostics:lastDiagnostics};
  };
  let lastStatusOwner,lastStatus;
  const sendStatus=(type='status')=>{
    if(peer?.readyState!==WebSocket.OPEN)return;
    const packet=status(type), comparable={...packet,type:'status'};
    if(type!=='hello'&&lastStatusOwner===peer&&isDeepStrictEqual(lastStatus,comparable))return;
    // Snapshot references too: control/account metadata may be mutated in place.
    lastStatusOwner=peer;lastStatus=structuredClone(comparable);send(packet);
  };
  const reportMediaError=e=>{
    mediaError=e.message||String(e);mediaReady=false;
    lastDiagnostics=[...lastDiagnostics.filter(d=>d.id!=='media-runtime'),{id:'media-runtime',level:'error',message:mediaError}];
    send({type:'error',message:mediaError});sendStatus();
  };
  const desired=()=>!stopping&&!configuring&&mediaAuthorized()&&owns(peer)?[...control.calls.values()].find(c=>c.state==='connected'):undefined;
  const active=()=>activeAudio&&owns(activeAudio.owner)&&control.calls.get(activeAudio.id)?.state==='connected'&&mediaAuthorized();
  const stopAudio=()=>{
    activeAudio=undefined;
    if(mediaStop)return mediaStop;
    // Revocation must interrupt a worker blocked in write/start, rather than
    // waiting behind the very command that needs that worker to exit.
    mediaStop=Promise.resolve().then(()=>audio.stop()).finally(()=>{playback.clear();mediaStop=undefined;});
    return mediaStop;
  };
  const syncMediaNow=async()=>{
    if(mediaStop)await mediaStop;
    const current=desired(), owner=peer;
    if(activeAudio&&(activeAudio.id!==current?.id||activeAudio.owner!==owner))await stopAudio();
    if(!current||activeAudio||!owns(owner))return;
    const starting={id:current.id,owner};startingAudio=starting;
    try {
      await audio.start();
      // Startup can outlive disconnect, call end, backend failure or a new peer.
      if(!owns(owner)||desired()?.id!==current.id){await stopAudio();return;}
      await audio.setMuted(control.calls.get(current.id)?.muted===true);
      if(!owns(owner)||desired()?.id!==current.id){await stopAudio();return;}
      activeAudio={id:current.id,owner};
    }catch(e){if(owns(owner)&&desired()?.id===current.id)reportMediaError(e);await stopAudio().catch(()=>{});}
    finally{if(startingAudio===starting)startingAudio=undefined;}
  };
  const syncMedia=()=>{
    if(syncQueued)return syncQueued;
    syncQueued=serial(syncMediaNow).catch(reportMediaError).finally(()=>{
      syncQueued=undefined;
      if(desired()&&!activeAudio)void syncMedia();
    });return syncQueued;
  };
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
    if(!authorized(req)){res.writeHead(401);res.end();return;}
    try { let body;
      if(req.method==='GET'&&req.url==='/v1/status')body=status('status');
      else if(req.method==='GET'&&req.url==='/v1/devices')body=await audio.listDevices();
      else if(req.method==='GET'&&req.url==='/v1/diagnostics')body=await serial(async()=>{lastDiagnostics=await diagnostics();await syncMediaNow();sendStatus();return lastDiagnostics;});
      else {res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));
    }catch{res.writeHead(500);res.end('{"error":"diagnostics failed"}');}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.on('clientError',(_e,s)=>s.destroy());
  const ws=new WebSocketServer({noServer:true,maxPayload:512*1024});
  server.on('upgrade',(req,socket,head)=>{
    if(stopping||req.url!=='/v1/stream'||!authorized(req)||req.headers.origin||peer){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    ws.handleUpgrade(req,socket,head,client=>ws.emit('connection',client,req));
  });
  ws.on('connection',socket=>{
    peer=socket;const scope=new AbortController();peerAbort=scope;let alive=true,busy=0;const seen=new Map();
    socket.on('pong',()=>{alive=true;});const ping=setInterval(()=>{if(!alive){socket.terminate();return;}alive=false;if(socket.readyState===WebSocket.OPEN)socket.ping();},5000);
    sendStatus('hello');void syncMedia();
    socket.on('error',()=>{});
    socket.on('close',()=>{scope.abort();clearInterval(ping);void revokeVideo(undefined,socket).catch(videoNotice);if(peer===socket){peer=undefined;void stopAudio().catch(reportMediaError);void syncMedia();}});
    socket.on('message',async(data,binary)=>{
      let request;
      try {
        requireOwner(socket);
        if(binary)throw error('INVALID_REQUEST','需要 JSON 协议帧');request=JSON.parse(data.toString());
        if(!request||request.type!=='request'||typeof request.id!=='string'||!request.id||request.id.length>80||typeof request.op!=='string'||!request.op||request.op.length>80||request.args!=null&&(typeof request.args!=='object'||Array.isArray(request.args)))throw error('INVALID_REQUEST','无效请求');
        // Frame payloads never enter the mutation replay cache. Sequence and a
        // single in-flight + latest pending frame per channel bound this path.
        if(request.op==='video.write'){
          const result=await writeVideo(socket,request.args||{});sendTo(socket,{type:'reply',id:request.id,ok:true,data:result});return;
        }
        const fingerprint=JSON.stringify([request.op,request.args||{}]), previous=seen.get(request.id);
        if(previous){if(previous.fingerprint!==fingerprint)throw error('REQUEST_ID_REUSED','同一请求标识不能用于不同参数');sendTo(socket,await previous.job);return;}
        if(busy>=16)throw error('BACKPRESSURE','媒体操作队列已满');
        busy++;
        const entry={fingerprint,settled:false};
        entry.job=(request.op.startsWith('video.')?videoSerial:serial)(async()=>{
          requireOwner(socket); const args=request.args||{};let result;
          if(request.op.startsWith('video.'))result=await videoOperation(socket,request.op.slice(6),args,request.id);
          else if(['accept','reject','hangup','dial'].includes(request.op)) {
            if(request.op==='dial'){
              if(!['direct','group'].includes(args.kind)||typeof args.targetId!=='string'||!args.targetId.trim()||args.targetId.length>512)throw error('INVALID_TARGET','通话目标无效');
              if(args.media!==undefined&&!['audio','video','screen'].includes(args.media)||['video','screen'].includes(args.media)&&args.kind!=='direct')throw error('INVALID_TARGET','视频或屏幕共享邀请仅适用于明确发起的私聊通话，媒体类型必须为 audio、video 或 screen');
              if(args.groupMode!==undefined&&!['join','create'].includes(args.groupMode)||args.kind!=='group'&&(args.groupMode!==undefined||args.inviteeIds!==undefined)||args.inviteeIds!==undefined&&(!Array.isArray(args.inviteeIds)||args.inviteeIds.length>16||args.inviteeIds.some(id=>typeof id!=='string'||!id.trim()||id.length>160))||args.inviteeIds?.length&&args.groupMode!=='create')throw error('INVALID_TARGET','邀请名单仅适用于主动发起群通话');
              if([...control.calls.values()].some(c=>!terminal(c.state)))throw error('CALL_BUSY','此账号已有未结束的通话');
            }else{
              if(typeof args.callId!=='string'||!args.callId)throw error('INVALID_REQUEST','需要通话标识');
              const call=control.calls.get(args.callId);
              if(!call||terminal(call.state))throw error('STALE_CALL','此通话已经结束');
              if(['accept','reject'].includes(request.op)&&call.state!=='ringing')throw error('INVALID_STATE','只有来电可以接听或拒接');
            }
            const cap=request.op==='dial'?(args.kind==='group'?(args.groupMode==='create'?'startGroup':'joinGroup'):args.media==='screen'?'dialScreen':'dial'):request.op==='hangup'&&control.calls.get(args.callId)?.kind==='group'?'leaveGroup':request.op;
            if(!control.caps[cap]?.supported)throw error('CAPABILITY_UNAVAILABLE',control.caps[cap]?.reason||'后端不支持');
            result=await control.control(request.op,args,request.id,scope.signal);if(request.op==='dial')result=safeCall(result);
            void syncMedia();
          }else if(request.op==='devices')result=await audio.listDevices();
          else if(request.op==='channels')result=await control.channels();
          else if(request.op==='audio.routes')result={inputDevice:config.audio.inputDevice,outputDevice:config.audio.outputDevice,editable:!config.desktop&&typeof persistAudio==='function',...(config.desktop?{reason:'桌面模式须停止桥接，配对修改客户端与桥接虚拟设备，再重新运行 probe 验证'}:{})};
          else if(request.op==='audio.configure'){
            if(config.desktop)throw error('READ_ONLY','桌面模式须停止桥接，配对修改客户端与桥接虚拟设备，再重新运行 probe 验证');
            if(typeof persistAudio!=='function')throw error('READ_ONLY','此桥接未启用配置文件保存');
            const requireIdle=()=>{requireOwner(socket);if([...control.calls.values()].some(c=>!terminal(c.state)))throw error('CALL_BUSY','请先结束通话，再更改音频路由');};
            requireIdle();configuring=true;
            try {
              const list=await audio.listDevices();requireIdle();
              for(const [key,direction]of [['inputDevice','input'],['outputDevice','output']])if(typeof args[key]!=='string'||!list.some(d=>d.id===args[key]&&d.direction===direction)||/^(?:default|@DEFAULT_.*@)$/i.test(args[key]))throw error('INVALID_DEVICE','请选择列表中的明确音频设备');
              if(args.inputDevice===args.outputDevice||args.inputDevice===`${args.outputDevice}.monitor`)throw error('AUDIO_LOOP','收音与发音必须使用两条独立线路');
              const old={...config.audio},settings={...old,inputDevice:args.inputDevice,outputDevice:args.outputDevice};
              await persistAudio(settings);
              try {requireIdle();}catch(e){try{await persistAudio(old);}catch(rollback){reportMediaError(rollback);}throw e;}
              Object.assign(config.audio,settings);if(audio.config)Object.assign(audio.config,settings);
              mediaError=undefined;lastDiagnostics=await diagnostics();sendStatus();result={saved:true};
            }finally{configuring=false;}
          }else if(request.op==='diagnostics'){
            lastDiagnostics=await diagnostics(true);requireOwner(socket);await syncMediaNow();result=lastDiagnostics;sendStatus();
          }else if(['audio.clear','mute','audio.write'].includes(request.op)){
            const callId=args.callId||args.frame?.callId;const call=control.calls.get(callId);
            if(!call||call.state!=='connected'||!active()||activeAudio.id!==callId)throw error('NOT_CONNECTED','通话或音频设备尚未接通');
            if(request.op==='audio.clear'){await audio.clear();result={cleared:true};}
            else if(request.op==='mute'){
              if(typeof args.muted!=='boolean')throw error('INVALID_REQUEST','muted 必须是布尔值');
              await audio.setMuted(args.muted);requireOwner(socket);
              const current=control.calls.get(callId);
              if(current?.state!=='connected')throw error('STALE_CALL','静音期间通话已结束');
              control.update({...current,muted:args.muted});result={muted:args.muted};
            }else{
              if(call.muted)throw error('MUTED','麦克风已静音');const f=args.frame;
              if(!f||f.callId!==callId||f.encoding!=='pcm_s16le'||f.sampleRate!==(config.audio.sampleRate||48000)||f.channels!==(config.audio.channels||1)||!Number.isSafeInteger(f.sequence)||f.sequence<0||!Number.isFinite(f.timestamp)||typeof f.data!=='string'||f.data.length>256000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)||typeof args.playbackId!=='string'||!args.playbackId||args.playbackId.length>160)throw error('INVALID_AUDIO','音频格式必须与桥接配置相同');
              const pcm=Buffer.from(f.data,'base64');if(!pcm.length||pcm.length%(2*f.channels)||pcm.length>f.sampleRate*f.channels*2)throw error('INVALID_AUDIO','音频帧长度无效');
              if(playback.size>=4096)throw error('BACKPRESSURE','未确认的音频播放过多');
              // The backend ID is private and unique across calls. A late worker
              // receipt cannot be attributed to a new caller reusing a public ID.
              const nativeId=randomUUID();playback.set(nativeId,{id:args.playbackId,callId,owner:socket});
              try {result={...(await audio.write(pcm,nativeId)),id:args.playbackId,callId};if(['played','cancelled','failed'].includes(result.state))playback.delete(nativeId);}
              catch(e){playback.delete(nativeId);throw e;}
            }
          }else throw error('UNKNOWN_OPERATION','未知操作');
          return {type:'reply',id:request.id,ok:true,data:result};
        }).catch(e=>({type:'reply',id:request.id,ok:false,error:{code:e.code||'BRIDGE_ERROR',message:e.message}})).finally(()=>{busy--;entry.settled=true;});
        seen.set(request.id,entry);
        // Never evict an in-flight request: a duplicate must share its outcome.
        for(const [id,cached]of seen)if(seen.size>256&&cached.settled)seen.delete(id);
        sendTo(socket,await entry.job);
      }catch(e){sendTo(socket,{type:'reply',id:typeof request?.id==='string'?request.id:undefined,ok:false,error:{code:e.code||'INVALID_REQUEST',message:e.message}});}
    });
  });
  const onCall=call=>{
    send({type:'call',call:safeCall(call)});
    const entry=videoSessions.get(call.id);
    if(call.state!=='connected')void revokeVideo(call.id).catch(videoNotice);
    else if(entry&&!entry.revoked)for(const [key,track]of entry.tracks)if(!track.revoked&&!call.participants.some(member=>member.identity==='platform'&&member.id===track.participantId)){
      track.revoked=true;
      void videoSerial(async()=>{
        if(!track.trackId){const state=await control.video('state',{callId:entry.callId});track.trackId=state.tracks?.find(item=>item.uid===track.participantId&&item.kind===track.kind&&item.subscribed)?.id;}
        if(track.trackId)await control.video('unsubscribe',{callId:entry.callId,trackId:track.trackId},randomUUID());
        if(entry.tracks.get(key)===track)entry.tracks.delete(key);
      }).catch(videoNotice);
    }
    if(call.state!=='connected'&&(activeAudio?.id===call.id||startingAudio?.id===call.id))void stopAudio().catch(reportMediaError);void syncMedia();
  };
  const onStatus=()=>{lastDiagnostics=[...(control.notices||[]),...lastDiagnostics.filter(d=>!['qq','gap'].includes(d.id))];sendStatus();if(!mediaAuthorized()&&(activeAudio||startingAudio))void stopAudio().catch(reportMediaError);void syncMedia();};
  const onAudio=frame=>{if(active())sendTo(activeAudio.owner,{type:'audio',frame:{...frame,encoding:'pcm_s16le',callId:activeAudio.id,data:Buffer.from(frame.data).toString('base64')}});};
  const onPlayback=receipt=>{
    const item=playback.get(receipt.id);if(!item)return;
    if(owns(item.owner))sendTo(item.owner,{type:'playback',receipt:{...receipt,id:item.id,callId:item.callId}});
    if(['played','cancelled','failed'].includes(receipt.state))playback.delete(receipt.id);
  };
  const onError=e=>{reportMediaError(e);void stopAudio().catch(()=>{});void syncMedia();};
  control.on('call',onCall);control.on('status',onStatus);audio.on('audio',onAudio);audio.on('playback',onPlayback);audio.on('error',onError);
  const stop=()=>{
    if(stopPromise)return stopPromise;
    stopping=true;clearInterval(videoTimer);peerAbort?.abort();peer?.terminate();peer=undefined;
    stopPromise=(async()=>{
      control.off('call',onCall);control.off('status',onStatus);
      const videoCleanup=revokeVideo();
      const results=await Promise.allSettled([videoCleanup,stopAudio(),operationTail]);
      await videoTail;results.push(...await Promise.allSettled([Promise.resolve().then(()=>control.stop())]));
      audio.off('audio',onAudio);audio.off('playback',onPlayback);audio.off('error',onError);
      await new Promise(resolve=>ws.close(resolve));
      if(server.listening)await new Promise(resolve=>server.close(resolve));
      const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    })();return stopPromise;
  };
  return {
    server,
    async start(){
      if(stopping)throw error('STOPPED','桥接已经停止');
      try {
        await new Promise((resolve,reject)=>{const fail=e=>{server.off('listening',ready);reject(e);};const ready=()=>{server.off('error',fail);resolve();};server.once('error',fail);server.once('listening',ready);server.listen(config.port??6120,config.host||'127.0.0.1');});
        await control.start();return server.address();
      }catch(e){await stop().catch(()=>{});throw e;}
    },
    stop,
  };
}
async function main(){
  const file=process.argv[2];if(!file)throw new Error('用法: node bridge/daemon.mjs /absolute/path/bridge.json');
  const original=JSON.parse(await fs.readFile(file,'utf8'));const config=structuredClone(original);
  if(config.tokenFile)config.token=(await fs.readFile(config.tokenFile,'utf8')).trim();
  if(config.qq?.tokenFile)config.qq.token=(await fs.readFile(config.qq.tokenFile,'utf8')).trim();
  const persistAudio=async audio=>{const next={...original,audio};const tmp=`${file}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(next,null,2)+'\n',{mode:0o600});await fs.rename(tmp,file);Object.assign(original,next);};
  const daemon=await createDaemon(config,{persistAudio});const address=await daemon.start();console.log(`RTC bridge listening on ${address.address}:${address.port}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void daemon.stop().then(()=>process.exit(0));});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
