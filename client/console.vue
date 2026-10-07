<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { send } from '@koishijs/client';
import VideoPanel from './video-panel.vue';
const rpc = send as (type: string, ...args: any[]) => Promise<any>;
const state = ref<any>({providers:[],calls:[],levels:{},activity:[],startup:[]});
const error = ref(''), notice=ref(''),busy=ref(''),selected=ref(''), target=ref(''), guild=ref(''),kind=ref('direct'),groupMode=ref('join'),media=ref('audio'),invitees=ref('');
const toneBusy=ref('');let feedbackVersion=0;
const initialSources=ref<any[]>([]),initialSource=ref(''),sourceBusy=ref(false),sourceError=ref('');let sourceVersion=0;
const initialKind=computed(()=>kind.value==='direct'&&media.value!=='audio'?(media.value==='video'?'camera':'screen'):'');
const initialOptions=computed(()=>[...new Map(initialSources.value.filter(s=>(s.channels||[s.kind]).includes(initialKind.value)).map(s=>[s.id,s])).values()]);
const initialReady=computed(()=>!initialKind.value||!sourceBusy.value&&initialOptions.value.some(s=>s.id===initialSource.value));
async function loadInitialSources(){
  const version=++sourceVersion;initialSources.value=[];initialSource.value='';sourceError.value='';sourceBusy.value=false;
  if(!selected.value||!initialKind.value)return;
  sourceBusy.value=true;
  try{const sources=await rpc('rtc/video-sources',selected.value);if(version!==sourceVersion||stopped)return;initialSources.value=Array.isArray(sources)?sources:[];initialSource.value=initialOptions.value.find(s=>s.id==='test-pattern'&&s.sourceType==='generated')?.id||'';}
  catch(e){if(version===sourceVersion&&!stopped)sourceError.value=String(e);}
  finally{if(version===sourceVersion)sourceBusy.value=false;}
}
watch([selected,initialKind],()=>{void loadInitialSources();});
function dial(){return run('dial',()=>rpc('rtc/control','dial',{
  providerId:selected.value,kind:kind.value,targetId:target.value,guildId:guild.value,
  ...(kind.value==='group'?{groupMode:groupMode.value,...(groupMode.value==='create'?{inviteeIds:invitees.value.split(/[\s,，]+/).filter(Boolean)}:{})}:{media:media.value}),
  ...(initialKind.value?{initialVideo:[{kind:initialKind.value,sourceId:initialSource.value}]}:{}),
}));}

const routes=ref<any>({editable:false});
const diagnostics=ref<any[]>([]),devices=ref<any[]>([]),channels=ref<any[]>([]);let timer: ReturnType<typeof setTimeout>,stopped=false;
const targetOptions=computed(()=>channels.value.filter((c:any)=>(c.kind||'group')===kind.value));
const provider=computed(()=>state.value.providers.find((p:any)=>p.id===selected.value));
const active=computed(()=>state.value.calls.filter((c:any)=>!['ended','failed'].includes(c.state)));
const ended=computed(()=>state.value.calls.filter((c:any)=>['ended','failed'].includes(c.state)));
const providerBusy=computed(()=>active.value.some((c:any)=>c.providerId===selected.value));
const labels:Record<string,string>={ringing:'来电',dialing:'正在呼叫',connecting:'正在连接',connected:'已接通',ending:'正在结束',ended:'已结束',failed:'连接中断',dial:'主动呼叫',dialScreen:'私聊屏幕共享邀请',accept:'接听',reject:'拒接',hangup:'挂断',joinGroup:'加入语音频道',startGroup:'发起群语音',leaveGroup:'退出语音频道',receiveAudio:'接收音频',sendAudio:'发送音频',participants:'成员列表',speakerIdentity:'发言者身份',mute:'静音',receiveVideo:'接收视频',sendVideo:'摄像头渠道发送',shareScreen:'屏幕渠道发送'};
const dialCapability=computed(()=>kind.value==='group'?(groupMode.value==='create'?'startGroup':'joinGroup'):media.value==='screen'?'dialScreen':'dial');
const time=(v:number)=>new Date(v).toLocaleTimeString();
const capable=(p:any,key:string)=>p?.capabilities?.[key]?.supported;
const controlledElsewhere=(c:any)=>!!c.owner&&c.owner!==state.value.operator;
const capFor=(c:any,key:string)=>!controlledElsewhere(c)&&capable(state.value.providers.find((p:any)=>p.id===c.providerId),key);
const audioReason=(c:any)=>controlledElsewhere(c)?'这次通话由其他插件或窗口控制，请先在那里释放控制权。':c.state!=='connected'?'接通后可使用音频。':!capFor(c,'sendAudio')||!capFor(c,'mute')?state.value.providers.find((p:any)=>p.id===c.providerId)?.capabilities?.sendAudio?.reason||'音频设备尚未就绪，正在自动检查。':c.muted?'麦克风已静音，取消静音后可播放测试音。':'';
async function refresh(){try{const next=await rpc('rtc/status');if(next){state.value=next;if(!selected.value&&next.providers[0]){selected.value=next.providers[0].id;void selectProvider();}error.value='';}}catch(e){error.value=String(e).includes('unauthorized')?'请先登录 Koishi 控制台管理员账号。':String(e);}finally{if(!stopped)timer=setTimeout(refresh,1000);}}
async function run(id:string,task:()=>Promise<any>,tone=false){if(busy.value||tone&&toneBusy.value)return;const pending=tone?toneBusy:busy;pending.value=id;const version=++feedbackVersion;notice.value='';try{const result=await task();if(version===feedbackVersion)notice.value=result?.message||'操作已提交，状态将随实际通话更新。';}catch(e){if(version===feedbackVersion)notice.value=String(e);}finally{pending.value='';}}
async function selectProvider(){devices.value=[];channels.value=[];target.value='';guild.value='';groupMode.value='join';media.value='audio';invitees.value='';kind.value=capable(provider.value,'joinGroup')&&!capable(provider.value,'dial')?'group':'direct';try{channels.value=await rpc('rtc/channels',selected.value)||[];}catch(e){notice.value=String(e);}}
async function inspect(){await run('diagnostics',async()=>{diagnostics.value=await rpc('rtc/diagnostics',selected.value||undefined);devices.value=selected.value?await rpc('rtc/devices',selected.value):[];routes.value=selected.value?await rpc('rtc/audio-routes',selected.value):{editable:false};});}
function control(c:any,action:string,extra:any={}){return run(`${c.id}:${action}`,()=>rpc('rtc/control',action,{callId:c.id,...extra}),action==='tone');}
function chooseChannel(){const c=channels.value.find((c:any)=>c.id===target.value);guild.value=c?.guildId||'';}
onMounted(refresh);onUnmounted(()=>{stopped=true;++sourceVersion;clearTimeout(timer);});
</script>
<template>
  <k-layout>
    <div class="rtc-scroll" tabindex="0" role="region" aria-label="实时通话控制台">
    <div class="rtc">
      <header class="hero">
        <svg class="mark" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="32" fill="none" stroke="currentColor" stroke-width="2" opacity=".2"/><path d="M21 40h4m6-11v22m9-31v40m9-31v22m6-11h4" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>
        <div><span class="eyebrow">KOISHI · REALTIME</span><h1>让对话接通</h1><p>通话与连续音频，交给你选择的插件。</p></div>
        <span class="live"><i/>{{ active.length ? active.length+' 路通话中' : '等待连接' }}</span>
      </header>
      <div v-if="error" role="alert" class="alert">{{ error }} <router-link v-if="error.includes('登录')" to="/login">前往登录</router-link></div>
      <div v-for="d in state.startup" :key="d.id" class="alert">{{ d.id }}：{{ d.message }}</div>
      <div v-if="!state.providers.length&&!error" class="empty">还没有配置通话后端。在 Koishi 插件配置中添加桌面通话桥接、Discord、Telegram、KOOK 或 LiveKit 后端，然后在这里检查连接。</div>
      <main>
        <section class="workspace">
          <div class="section-title"><h2>当前通话</h2><small>只有平台确认接通后才启动音频</small></div>
          <div v-if="!active.length" class="idle"><svg viewBox="0 0 80 80" width="64" aria-hidden="true"><path d="M19 33a21 21 0 0 1 42 0v18m-42-18v18m0-11h8v17h-8zm42 0h-8v17h8zM61 57c0 9-10 11-20 11" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg><p>暂无进行中的通话</p><small>收到来电后，接听按钮会显示在这里。不会自动接听。</small></div>
          <article v-for="c in active" :key="c.id" class="call" :class="c.state">
            <div class="call-top"><span class="badge">{{ c.account.platform }} · {{ c.kind==='group'?'群语音':'私聊通话' }}</span><strong>{{ labels[c.state] }}</strong></div>
            <h3>{{ c.targetId }}</h3><p class="sub">{{ c.providerId }} · {{ time(c.createdAt) }} · {{ c.direction==='incoming'?'对方发起':'本端发起' }}</p>
            <div class="meter" role="meter" aria-label="接收音量" :aria-valuenow="Math.round((state.levels[c.id]?.level||0)*100)" aria-valuemin="0" aria-valuemax="100"><span :style="{width:Math.min(100,(state.levels[c.id]?.level||0)*200)+'%'}"/></div>
            <p class="sub">{{ c.owner?'控制者：'+c.owner:'等待插件或管理员取得控制权' }}<span v-if="c.muted"> · 麦克风已静音</span></p>
            <div class="participants" v-if="c.participants.length"><span v-for="p in c.participants" :key="p.id||p.name">{{ p.name||p.id||'身份未知' }}</span></div>
            <div class="actions">
              <template v-if="c.state==='ringing'"><button class="primary" :disabled="!!busy||!capFor(c,'accept')" @click="control(c,'accept')">接听</button><button :disabled="!!busy||!capFor(c,'reject')" @click="control(c,'reject')">拒接</button></template>
              <template v-else><button :disabled="!!busy||!capFor(c,'mute')||c.state!=='connected'" @click="control(c,'mute',{muted:!c.muted})">{{ c.muted?'取消静音':'静音' }}</button><button :disabled="!!busy||controlledElsewhere(c)||c.state!=='connected'" @click="control(c,'clear')">停止当前播放</button></template>
              <button v-if="c.state==='connected'" :disabled="!!busy||!!toneBusy||c.muted||!capFor(c,'sendAudio')" @click="control(c,'tone')">{{ toneBusy===c.id+':tone'?'正在确认播放…':'播放测试音' }}</button>
              <button class="danger" :disabled="!!busy||!capFor(c,c.kind==='group'?'leaveGroup':'hangup')" @click="control(c,'hangup')">{{ c.kind==='group'?'退出语音':'挂断' }}</button>
              <button v-if="c.owner===state.operator" :disabled="!!busy" @click="control(c,'release')">释放控制</button>
            </div>
            <p v-if="audioReason(c)" class="sub" role="status">{{ audioReason(c) }}</p>
            <VideoPanel v-if="c.state==='connected'" :call="c" :capabilities="state.providers.find((p:any)=>p.id===c.providerId)?.capabilities" :operator="state.operator"/>
            <p v-if="c.error" class="alert">{{ c.error }}</p>
          </article>
          <p role="status" aria-live="polite" v-if="notice" class="notice">{{ notice }}</p>
          <section class="history" v-if="ended.length"><h2>最近通话</h2><div v-for="c in ended.slice(0,20)" :key="c.id" class="history-row"><div><strong>{{ c.targetId }}</strong><small>{{ c.account.platform }} · {{ time(c.createdAt) }}</small></div><span>{{ labels[c.state] }}</span><p v-if="c.error">{{ c.error }}</p></div></section>
        </section>
        <aside>
          <section class="panel"><h2>连接一个频道</h2><label>通话后端<select v-model="selected" @change="selectProvider"><option value="" disabled>选择已配置的后端</option><option v-for="p in state.providers" :key="p.id" :value="p.id">{{ p.id }} · {{ p.account.platform }}</option></select></label>
            <template v-if="provider">
              <label>通话类型<select v-model="kind" @change="target='';guild='';groupMode='join';media='audio'"><option value="direct" :disabled="!capable(provider,'dial')">私聊通话</option><option value="group" :disabled="!capable(provider,'joinGroup')&&!capable(provider,'startGroup')">群语音 / 会议房间</option></select></label>
              <label v-if="kind==='direct'">邀请类型<select v-model="media"><option value="audio">语音通话</option><option value="video" :disabled="!capable(provider,'dial')||(!capable(provider,'sendVideo')&&!capable(provider,'receiveVideo'))">视频通话</option><option value="screen" :disabled="!capable(provider,'dialScreen')">屏幕共享通话</option></select></label>
              <div v-if="initialKind" class="initial-video">
                <label>接通后发送的{{ initialKind==='camera'?'摄像头':'屏幕共享' }}画面<select v-model="initialSource" :disabled="sourceBusy"><option value="" disabled>{{ sourceBusy?'正在读取可用来源…':'选择画面来源' }}</option><option v-for="s in initialOptions" :key="s.id" :value="s.id">{{ s.id==='test-pattern'&&s.sourceType==='generated'?'动态测试画面':s.name }}</option></select></label>
                <button :disabled="sourceBusy||!!busy" @click="loadInitialSources">刷新来源</button>
                <p v-if="sourceError" role="alert" class="sub">{{ sourceError }}</p>
                <p v-else-if="!sourceBusy&&!initialOptions.length" class="sub">暂无可用来源，请检查视频后端和虚拟摄像头配置。</p>
                <p v-else-if="initialSource==='external-frames'" class="sub">接通后开启外部帧输入；调用方需要持续写入视频帧，才能显示内容。</p>
                <p v-else class="sub">接通后自动发送所选画面。动态测试画面是生成的图案；发送真实摄像头或桌面需在这里明确选择。</p>
              </div>
              <label v-if="kind==='group'&&capable(provider,'startGroup')">群通话操作<select v-model="groupMode"><option value="join">加入已有房间</option><option value="create">发起并邀请群成员</option></select></label>
              <label v-if="targetOptions.length&&(kind!=='group'||groupMode==='join')">{{kind==='group'?'频道 / 会议房间':'通话联系人'}}<select v-model="target" @change="chooseChannel"><option value="" disabled>选择允许的通话对象</option><option v-for="c in targetOptions" :key="c.id" :value="c.id">{{ c.guildName ? c.guildName+' / ' : '' }}{{ c.name }}</option></select></label>
              <template v-else><label>{{ kind==='group'?'语音频道 ID':'对方账号标识' }}<input v-model="target" autocomplete="off" :placeholder="provider.account.platform==='onebot'?'由 QQ 后端支持的用户标识':''"/></label><label v-if="provider.account.platform==='discord'">服务器 ID<input v-model="guild" autocomplete="off"/></label></template>
              <label v-if="kind==='group'&&groupMode==='create'">邀请成员（QQ 号，用空格或逗号分隔）<input v-model="invitees" autocomplete="off" placeholder="指定要邀请的成员"/></label>
              <button class="primary wide" :disabled="!!busy||providerBusy||!target||!initialReady||!capable(provider,dialCapability)" @click="dial">{{ kind==='group'?(groupMode==='create'?'发起群语音并邀请':'加入语音频道'):media==='screen'?'发起屏幕共享邀请':media==='video'?'发起视频邀请':'发起语音通话' }}</button>
              <p v-if="providerBusy" class="sub">此账号已有通话。请在通话中的“视频与屏幕共享”开启画面；语音转屏幕共享时会显示转换进度。</p>
              <p v-if="!capable(provider,dialCapability)" class="sub">{{ provider.capabilities[dialCapability]?.reason }}</p>
            </template>
          </section>
          <section class="panel"><div class="section-title"><h2>连接检查</h2><button :disabled="!!busy" @click="inspect">检查</button></div>
            <div v-if="provider" class="cap-grid"><details v-for="(cap,key) in provider.capabilities" :key="key"><summary><i :class="{ok:cap.supported}"/>{{ labels[key]||key }}</summary><p>{{ cap.reason||(cap.supported?'后端支持':'后端未提供') }}</p></details></div>
            <div v-for="d in diagnostics" :key="d.id" class="diagnostic" :class="d.level"><strong>{{ d.level==='ok'?'✓':d.level==='warning'?'△':'!' }}</strong><span>{{ d.message }}</span></div>
            <div v-if="routes.editable&&devices.length" class="route-settings"><label>从 QQ 扬声器收音<select v-model="routes.inputDevice"><option v-for="d in devices.filter(d=>d.direction==='input')" :key="d.id" :value="d.id">{{ d.name }}</option></select></label><label>向 QQ 麦克风发音<select v-model="routes.outputDevice"><option v-for="d in devices.filter(d=>d.direction==='output')" :key="d.id" :value="d.id">{{ d.name }}</option></select></label><button :disabled="!!busy||active.length>0" @click="run('routes',()=>rpc('rtc/configure-audio',selected,routes.inputDevice,routes.outputDevice))">保存音频路由</button></div>
            <details v-if="devices.length" class="devices"><summary>可用音频设备 · {{ devices.length }}</summary><p v-for="d in devices" :key="d.direction+d.id">{{ d.direction==='input'?'输入':'输出' }} · {{ d.name }}<code>{{ d.id }}</code></p></details>
            <p class="sub">输入与输出使用两条独立虚拟线路。结束通话后可以更改设备。</p>
          </section>
        </aside>
      </main>
      <details class="panel log"><summary>运行动态 · {{ state.activity.length }}</summary><p v-for="(item,i) in state.activity" :key="i"><time>{{ time(item.at) }}</time>{{ item.detail }}</p></details>
      <footer>音频仅实时传输，不自动录音。音量表表示桥接收到的音频；对端是否听到仍需实际通话确认。</footer>
    </div>
    </div>
  </k-layout>
</template>
<style scoped>
/* Koishi's fixed .layout-main clips overflow; scroll inside its available area. */
.rtc-scroll{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;scrollbar-gutter:stable;-webkit-overflow-scrolling:touch}
.rtc-scroll:focus-visible{outline:2px solid #287cbb;outline-offset:-2px}
.rtc{width:100%;overflow-wrap:anywhere}
.rtc{--line:color-mix(in srgb,currentColor 13%,transparent);--soft:color-mix(in srgb,currentColor 4%,transparent);--accent:#287cbb;max-width:1240px;margin:auto;padding:24px;color:var(--k-text-normal,#334155);font:14px/1.5 system-ui,"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif;box-sizing:border-box}.rtc *{box-sizing:border-box;min-width:0}.hero{display:flex;align-items:center;gap:18px;padding:18px 0 30px}.mark{width:72px;color:var(--accent);flex:none}.eyebrow{font-size:10px;letter-spacing:.18em;opacity:.6}h1{font-size:29px;line-height:1.2;margin:8px 0}h2{font-size:17px;margin:0 0 16px}h3{font-size:23px;overflow-wrap:anywhere;margin:16px 0 8px}p{line-height:1.65;margin:6px 0}.hero p,.sub,small,footer{opacity:.8}.live{margin-left:auto;white-space:nowrap;display:flex;align-items:center;gap:9px}.live i{width:8px;height:8px;border-radius:50%;background:#45a791}.rtc main{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(290px,1fr);gap:24px}.section-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.panel,.call,.idle,.empty{border:1px solid var(--line);border-radius:18px;padding:22px;background:var(--soft);margin-bottom:18px}.idle{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:250px;text-align:center}.idle svg{opacity:.4}.call.connected{border-color:#45a79170}.call.ringing{border-color:#287cbb80}.call-top{display:flex;justify-content:space-between;align-items:center;gap:12px}.badge{font-size:12px;border-radius:7px;padding:5px 8px;background:var(--soft)}.call-top strong{font-size:13px;color:var(--accent)}.meter{height:7px;border-radius:20px;background:var(--line);overflow:hidden;margin:20px 0}.meter span{display:block;height:100%;background:#45a791;border-radius:20px;transition:width .15s}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}button,input,select{font:inherit;border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:inherit;background:var(--k-color-surface,transparent)}button{cursor:pointer;min-height:42px;touch-action:manipulation}button:hover:not(:disabled){background:var(--line)}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.38;cursor:not-allowed}button.primary{background:var(--accent);color:white;border-color:transparent}button.danger{color:#c75151}.wide{width:100%;margin-top:6px}label{display:block;font-size:12px;margin:12px 0}input,select{display:block;width:100%;margin-top:7px;font-size:14px}option{background:var(--k-color-surface,Canvas);color:CanvasText}.alert,.notice{padding:13px 16px;border-radius:10px;background:var(--soft);border-left:3px solid #c7843f;overflow-wrap:anywhere;margin:14px 0}.cap-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cap-grid summary{font-size:12px;cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px}.cap-grid i{width:6px;height:6px;background:#98a0a9;border-radius:50%;flex:none}.cap-grid i.ok{background:#45a791}.cap-grid p{font-size:11px;overflow-wrap:anywhere;opacity:.7}.diagnostic{display:flex;gap:10px;margin-top:14px;font-size:12px;overflow-wrap:anywhere}.diagnostic strong{color:#c7843f}.diagnostic.ok strong{color:#45a791}.diagnostic.error strong{color:#c75151}.devices{margin-top:16px;font-size:12px}.devices code{display:block;overflow-wrap:anywhere;opacity:.6}.history{margin-top:30px}.history-row{display:grid;grid-template-columns:1fr auto;gap:8px;padding:15px 0;border-bottom:1px solid var(--line)}.history-row strong{display:block;overflow-wrap:anywhere}.history-row small{display:block;margin-top:5px}.history-row p{grid-column:1/-1;font-size:12px;opacity:.65}.participants{display:flex;gap:6px;flex-wrap:wrap}.participants span{padding:3px 7px;background:var(--soft);border-radius:5px}.log{margin-top:20px}.log summary,.devices summary{cursor:pointer}.log p{font-size:12px;overflow-wrap:anywhere;border-top:1px solid var(--line);padding-top:8px}.log time{display:inline-block;margin-right:14px;opacity:.6}footer{font-size:11px;padding:5px 4px 28px}button,summary{-webkit-tap-highlight-color:transparent}@media(max-width:760px){.rtc{padding:16px}.rtc main{grid-template-columns:minmax(0,1fr);gap:6px}.hero{gap:10px;flex-wrap:wrap;padding-top:0}.mark{width:51px}h1{font-size:24px}.live{font-size:11px}.panel,.call,.idle{padding:17px}.section-title small{font-size:11px}.hero p{font-size:12px}}@media(prefers-reduced-motion:reduce){.meter span{transition:none}}
</style>
