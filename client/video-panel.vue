<script setup lang="ts">
import { onUnmounted, ref, computed, watch } from 'vue';
import { send } from '@koishijs/client';
const rpc = send as (type: string, ...args: any[]) => Promise<any>;
const props = defineProps<{call:any;capabilities:any;operator:string}>();
const pending=ref<Record<string,number>>({}),error=ref(''),notice=ref(''),statusError=ref(''),state=ref<any>({tracks:[],sending:{}}),sources=ref<any[]>([]),expanded=ref(false);
const participant=ref(''),kind=ref('camera'),source=ref(''),framing=ref('full'),selectedTrack=ref(''),frameUrl=ref(''),frameTime=ref(0);
let timer:ReturnType<typeof setTimeout>|undefined,statusTimer:ReturnType<typeof setTimeout>|undefined,stopped=false,generation=0,contextGeneration=0,statusGeneration=0,stateVersion=0,lastSequence=-1,requestId=0,feedbackVersion=0,statusFailures=0,sourcesAttempted=false;
const owned=computed(()=>!props.call.owner||props.call.owner===props.operator);
const hasOwner=computed(()=>!!props.operator&&props.call.owner===props.operator);
const supported=computed(()=>props.capabilities?.receiveVideo?.supported);
const sourceOptions=computed(()=>[...new Map(sources.value.filter(s=>(s.channels||[s.kind]).includes(kind.value)).map(s=>[s.id,s])).values()]);
const canSend=computed(()=>props.capabilities?.[kind.value==='camera'?'sendVideo':'shareScreen']?.supported);
const canFrame=computed(()=>kind.value==='camera'&&source.value==='external-frames');
const sendPending=computed(()=>!!pending.value['send:'+kind.value]);
const stopPending=computed(()=>!!pending.value['stop:'+kind.value]);
const transition=computed(()=>props.call.mediaTransition);
const transitionActive=computed(()=>['preparing','closing','negotiating','connecting','restoring'].includes(transition.value?.status));
const transitionLabels:Record<string,string>={preparing:'正在准备屏幕共享',closing:'正在切换原生通话通道',negotiating:'正在协商屏幕共享',connecting:'正在连接屏幕共享',restoring:'正在恢复音视频',completed:'屏幕共享通道已就绪',failed:'屏幕共享切换失败',cancelled:'屏幕共享切换已取消'};
const transitionText=computed(()=>transitionLabels[transition.value?.status]||'');
const sendingText=computed(()=>{const channel=state.value.sending?.[kind.value];return channel?.state==='sending'?(channel.sourceId==='test-pattern'?'正在发送动态测试画面；请由通话对方确认收到。':'发送渠道已开启；请由通话对方确认收到画面。'):channel?.state==='failed'?'发送失败：'+(channel.error||'请检查后端状态'):channel?.state==='starting'?'正在启动发送渠道…':'选择来源后可在这次通话中开启画面。';});
const api=(action:string,args:any={},callId=props.call.id)=>rpc('rtc/video',action,{callId,...args});
const identity=(track:any)=>track.participantId;
const trackName=(track:any)=>(props.call.participants.find((p:any)=>p.id===identity(track))?.name||identity(track)||'未知成员')+' · '+(track.kind==='camera'?'摄像头':'屏幕');
const current=(epoch:number,callId:string)=>!stopped&&epoch===contextGeneration&&callId===props.call.id&&props.call.state==='connected'&&owned.value;
function chooseSource(){if(!sourceOptions.value.some(s=>s.id===source.value)){const active=state.value.sending?.[kind.value]?.sourceId;source.value=sourceOptions.value.find(s=>s.id===active)?.id||sourceOptions.value.find(s=>s.id==='test-pattern'&&s.sourceType==='generated')?.id||'';}}
function clearFrame(){if(frameUrl.value)URL.revokeObjectURL(frameUrl.value);frameUrl.value='';frameTime.value=0;lastSequence=-1;}
function clearPreview(){const trackId=selectedTrack.value;selectedTrack.value='';generation++;clearTimeout(timer);clearFrame();return trackId;}
function cleanup(callId:string,trackId:string){if(trackId)void api('unsubscribe',{trackId},callId).catch(()=>{});}
async function action(key:string,work:(valid:()=>boolean)=>Promise<void>){
 if(pending.value[key]||!owned.value||props.call.state!=='connected')return;
 const id=++requestId,feedback=++feedbackVersion,epoch=contextGeneration,callId=props.call.id;
 pending.value[key]=id;error.value='';notice.value='';
 const valid=()=>current(epoch,callId)&&pending.value[key]===id;
 try{await work(valid);}catch(e){if(valid()&&feedback===feedbackVersion)error.value=String(e);}
 finally{if(pending.value[key]===id)delete pending.value[key];}
}
async function poll(epoch:number,callId:string,trackId:string){
 try{
  if(stopped||epoch!==generation||!hasOwner.value||props.call.id!==callId||props.call.state!=='connected'||selectedTrack.value!==trackId)return;
  const result=await api('frame',{trackId},callId);if(stopped||epoch!==generation)return;
  if(result.error)error.value=result.error;
  if(result.ended){error.value=result.error||'视频预览已结束，可重新选择观看。';clearPreview();return;}
  const frame=result.frame,age=frame?Date.now()-frame.timestamp:Infinity;
  if(frame&&frame.callId===callId&&frame.trackId===trackId&&frame.sequence>lastSequence&&frame.encoding==='jpeg'&&age>=-1000&&age<3000){
   const bytes=Uint8Array.from(atob(frame.data),(v:string)=>v.charCodeAt(0));
   const next=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));if(frameUrl.value)URL.revokeObjectURL(frameUrl.value);
   frameUrl.value=next;frameTime.value=frame.timestamp;lastSequence=frame.sequence;
  }else if(frameTime.value&&Date.now()-frameTime.value>3000){clearFrame();}
 }catch(e){if(epoch===generation){error.value=String(e);cleanup(callId,clearPreview());}}
 finally{if(!stopped&&epoch===generation&&selectedTrack.value===trackId)timer=setTimeout(()=>poll(epoch,callId,trackId),200);}
}
async function readState(callId:string,context:number){const version=stateVersion,result=await api('state',{statusOnly:true},callId);if(current(context,callId)&&version===stateVersion)state.value=result;}
async function pollState(epoch:number,callId:string,context:number){
 const valid=()=>epoch===statusGeneration&&current(context,callId)&&hasOwner.value;
 if(!valid())return;
 try{await readState(callId,context);if(valid()){statusFailures=0;statusError.value='';}}
 catch(e){if(valid()){statusFailures++;statusError.value=statusFailures>=3?'视频状态自动刷新已暂停，请手动刷新重试。':String(e);}}
 finally{if(valid()&&statusFailures<3)statusTimer=setTimeout(()=>pollState(epoch,callId,context),2000);}
}
function startStatus(){clearTimeout(statusTimer);statusGeneration++;statusFailures=0;if(hasOwner.value&&props.call.state==='connected')void pollState(statusGeneration,props.call.id,contextGeneration);}
async function loadSources(automatic:boolean){
 if(automatic&&(!hasOwner.value||sourcesAttempted)||pending.value.sources)return;
 if(!owned.value||props.call.state!=='connected')return;
 sourcesAttempted=true;const id=++requestId,context=contextGeneration,callId=props.call.id;pending.value.sources=id;
 try{const result=await api('sources',automatic?{statusOnly:true}:{},callId);if(current(context,callId)&&pending.value.sources===id){sources.value=result;chooseSource();}}
 catch(e){if(current(context,callId)){if(automatic)statusError.value=String(e);else throw e;}}
 finally{if(pending.value.sources===id)delete pending.value.sources;}
}
function togglePanel(event:Event){expanded.value=(event.target as HTMLDetailsElement).open;if(expanded.value&&hasOwner.value)void loadSources(true);}
async function watchTrack(){await action('preview',async valid=>{
 const callId=props.call.id,previous=clearPreview();
 if(previous)await api('unsubscribe',{trackId:previous},callId);
 if(!valid())return;
 const track=await api('subscribe',{participantId:participant.value,kind:kind.value},callId);
 if(!valid()){cleanup(callId,track.trackId);return;}
 selectedTrack.value=track.trackId;void poll(generation,callId,track.trackId);
 await readState(callId,contextGeneration);
});}
async function stopPreview(){delete pending.value.preview;await action('preview-stop',async()=>{const callId=props.call.id,id=clearPreview();if(id)await api('unsubscribe',{trackId:id},callId);});}
async function inspect(){await action('inspect',async valid=>{const callId=props.call.id,context=contextGeneration;await loadSources(false);if(!valid())return;await readState(callId,context);if(valid())startStatus();});}
async function sending(actionName:'send'|'stop',channel=kind.value){
 if(pending.value['stop:'+channel]||actionName==='send'&&pending.value['send:'+channel])return;
 // Stop is deliberately parallel to a native upgrade/start still awaiting its result.
 if(actionName==='stop')delete pending.value['send:'+channel];
 await action(actionName+':'+channel,async valid=>{
  const callId=props.call.id,version=++stateVersion,feedback=feedbackVersion;
  const result=await api(actionName,{kind:channel,...(actionName==='send'?{sourceId:source.value,...(canFrame.value?{framing:framing.value}:{})}:{})},callId);
  if(!valid())return;
  if(version===stateVersion){stateVersion++;state.value=result;}
  if(feedback===feedbackVersion)notice.value=actionName==='stop'?'停止请求已处理，发送状态以后台回执为准。':'发送请求已完成，请由通话对方确认收到画面。';
 });
}
watch(()=>[props.call.id,props.call.state,props.call.owner,props.operator],(next,previous)=>{
 if(previous&&next.every((value,index)=>value===previous[index]))return;
 if(previous&&(next[0]!==previous[0]||next[1]!=='connected'||next[3]!==previous[3]||!owned.value||(previous[2]&&previous[2]!==next[2]))){
  contextGeneration++;stateVersion++;feedbackVersion++;pending.value={};cleanup(previous[0],clearPreview());state.value={tracks:[],sending:{}};sources.value=[];source.value='';framing.value='full';participant.value='';error.value='';notice.value='';statusError.value='';sourcesAttempted=false;
 }
 startStatus();if(expanded.value&&hasOwner.value)void loadSources(true);
},{immediate:true});
watch(kind,()=>{source.value='';chooseSource();});
watch(source,()=>{framing.value='full';});
onUnmounted(()=>{stopped=true;contextGeneration++;statusGeneration++;clearTimeout(statusTimer);cleanup(props.call.id,clearPreview());});
</script>
<template>
 <details v-if="supported||capabilities?.sendVideo?.supported||capabilities?.shareScreen?.supported" class="video-panel" @toggle="togglePanel">
  <summary>视频与屏幕共享<span v-if="state.sending?.camera?.state==='sending'||state.sending?.screen?.state==='sending'" class="summary-state"> · 正在发送画面</span></summary>
  <p v-if="!owned" class="hint">当前由其他插件或窗口控制。</p>
  <template v-else>
   <p v-if="!hasOwner" class="hint">选择并开启画面后，此页面将取得通话控制权。</p>
   <p v-if="transitionText" class="hint" role="status">{{transitionText}}<template v-if="transitionActive">，切换期间音频可能短暂停顿。</template><span v-if="transition?.error">：{{transition.error}}</span></p>
   <button v-if="transitionActive" :disabled="!!pending['stop:screen']||call.state!=='connected'" @click="sending('stop','screen')">{{pending['stop:screen']?'正在取消…':'取消屏幕共享切换'}}</button>
   <div class="choices">
    <label>视频类型<select v-model="kind"><option value="camera">摄像头</option><option value="screen">屏幕共享</option></select></label>
    <label v-if="supported">观看成员<select v-model="participant"><option value="" disabled>选择成员</option><option v-for="p in call.participants" :key="p.id" :value="p.id">{{p.name||p.id}}</option></select></label>
   </div>
   <div class="buttons"><button v-if="supported" :disabled="!!pending.preview||!participant||call.state!=='connected'" @click="watchTrack">观看画面</button><button v-if="selectedTrack||pending.preview" :disabled="!!pending['preview-stop']" @click="stopPreview">停止观看</button><button :disabled="!!pending.inspect||!!pending.sources||call.state!=='connected'" @click="inspect">{{pending.sources?'正在读取来源…':'刷新视频状态与来源'}}</button></div>
   <div v-if="selectedTrack" class="preview"><img v-if="frameUrl" :src="frameUrl" alt="通话对方实时画面"/><p v-else>等待此成员的视频帧…</p><span v-if="frameTime">实时画面 · {{new Date(frameTime).toLocaleTimeString()}}</span></div>
   <div v-if="state.tracks?.length" class="tracks"><span v-for="track in state.tracks" :key="track.trackId">{{trackName(track)}} · {{track.available===false?'已关闭':track.hasFrame?'已收到画面':track.subscribed?'已订阅':'可订阅'}}</span></div>
   <template v-if="canSend||state.sending?.[kind]||sendPending||(kind==='screen'&&transitionActive)">
    <label>发送来源<select v-model="source"><option value="" disabled>{{pending.sources?'正在读取可用来源…':'刷新来源后选择画面'}}</option><option v-for="s in sourceOptions" :value="s.id" :key="s.id">{{s.name}}</option></select></label>
    <label v-if="canFrame">画幅<select v-model="framing"><option value="full">完整画幅</option><option value="portrait-safe">手机竖屏留边</option></select></label>
    <p v-if="canFrame" class="hint">选择后点击发送按钮应用。竖屏留边把内容缩到中间安全区，便于手机 QQ 竖屏观看。</p>
    <div class="buttons"><button :disabled="sendPending||stopPending||!canSend||!source||call.state!=='connected'" @click="sending('send')">{{sendPending?'正在开启…':kind==='camera'?'开启摄像头画面':'开启屏幕共享'}}</button><button :disabled="stopPending||call.state!=='connected'" @click="sending('stop')">{{stopPending?'正在停止…':kind==='camera'?'停止摄像头':'停止共享'}}</button></div>
    <p class="hint" role="status">{{sendingText}}</p>
    <p v-if="sourceOptions.find(s=>s.id===source)?.sourceType==='generated'" class="hint">动态测试画面由程序绘制并标示“测试画面”，不是 Bot 人物影像，也不会抓取摄像头或桌面。</p>
    <p v-if="sourceOptions.find(s=>s.id===source)?.sourceType==='frames'" class="hint">画面由消费插件通过 writeVideo 提供；开启渠道后等待该插件送入帧，不会自动抓取桌面。</p>
   </template>
   <p v-if="notice" role="status" class="hint">{{notice}}</p>
   <p v-if="statusError" role="status" class="hint">{{statusError}}</p>
   <p v-if="error" role="alert" class="error">{{error}}</p>
  </template>
 </details>
</template>
<style scoped>
.video-panel,.video-panel *{box-sizing:border-box;min-width:0}
.video-panel{max-width:100%;overflow-wrap:anywhere}
.buttons button{max-width:100%;white-space:normal}
.video-panel .preview img{max-width:100%;max-height:min(480px,60vh)}
.video-panel{border-top:1px solid color-mix(in srgb,currentColor 15%,transparent);margin-top:18px;padding-top:14px}summary{cursor:pointer;font-weight:600;min-height:34px}label{font-size:12px;display:block;margin:12px 0}.choices{display:grid;grid-template-columns:1fr 1fr;gap:12px}select{display:block;width:100%;margin-top:7px;min-width:0;font:inherit;font-size:14px;padding:10px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;color:inherit;background:var(--k-color-surface,Canvas)}.buttons{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);padding:10px 12px;border-radius:8px;min-height:42px;cursor:pointer}button:disabled{opacity:.4;cursor:default}.preview{position:relative;background:#111820;border-radius:12px;overflow:hidden;min-height:160px;margin-top:14px;display:grid;place-items:center;color:#fff}.preview img{width:100%;max-height:480px;object-fit:contain;display:block}.preview span{position:absolute;bottom:8px;left:8px;background:#0009;border-radius:4px;padding:3px 7px;font-size:11px}.tracks{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;overflow-wrap:anywhere;margin:10px 0}.hint{opacity:.7;font-size:12px}.error{color:#bd5353;overflow-wrap:anywhere}@media(max-width:520px){.choices{grid-template-columns:minmax(0,1fr);gap:0}}
</style>
