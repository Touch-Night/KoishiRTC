import type { Context, Schema as SchemaType } from 'koishi';
import { createRequire } from 'node:module';
// Koishi 4.18's loader mixes CJS and ESM; reuse its canonical CJS service classes.
const { Schema, Service } = createRequire(import.meta.url)('koishi') as typeof import('koishi');
import { fileURLToPath } from 'node:url';
import type { Client } from '@koishijs/plugin-console';
import { RtcManager, RtcController, RtcError } from './core.js';
import { DesktopBridgeProvider, type BridgeConfig } from './providers/bridge.js';
import type { TelegramConfig } from './providers/telegram.js';
import type { KookConfig } from './providers/kook.js';
import type { LiveKitConfig } from './providers/livekit.js';
import type { CallProvider, CallRequest } from './types.js';
export * from './core.js';
export { DiscordProvider } from './providers/discord.js';
export { TelegramProvider } from './providers/telegram.js';
export { KookProvider } from './providers/kook.js';
export { LiveKitProvider } from './providers/livekit.js';
export { DesktopBridgeProvider } from './providers/bridge.js';
export const name = 'rtc-bridge';
export const inject = { optional: ['console'] };
export const usage = `提供独立的 ctx.rtc 通话服务。QQ 使用原生通话桥；微信、飞书、腾讯会议使用需校准的桌面控制桥，均配合独立音频路由。Discord、Telegram、KOOK 和 LiveKit 使用各自的媒体后端。不会自动接听、拨打或录音。启用控制台页面需安装 auth 并以权限等级 4 登录。详见插件包中的 docs。`;
export interface DiscordConfig { id: string; token: string; selfId: string; guildIds: string[] }
export interface Config { bridges: BridgeConfig[]; discord: DiscordConfig[]; telegram?: TelegramConfig[]; kook?: KookConfig[]; livekit?: LiveKitConfig[]; historyLimit: number }
export const Config: SchemaType<Config> = Schema.object({
  bridges: Schema.array(Schema.object({
    id: Schema.string().required().description('唯一后端名称，例如 qq-desktop'),
    url: Schema.string().default('ws://127.0.0.1:6120/v1/stream').description('桌面桥接 WebSocket 地址'),
    token: Schema.string().role('secret').required().description('与桌面桥接一致的令牌（至少 32 字节）'),
    platform: Schema.string().default('onebot').description('与桥接配置一致：QQ 为 onebot；其他桌面后端为 wechat、feishu 或 tencent-meeting'),
    selfId: Schema.string().required().description('桥接登录的账号 ID'),
  })).default([]).description('桌面通话桥接'),
  discord: Schema.array(Schema.object({
    id: Schema.string().required().description('唯一后端名称，例如 discord-voice'),
    token: Schema.string().role('secret').required().description('Discord Bot Token'),
    selfId: Schema.string().required().description('Discord 机器人用户 ID'),
    guildIds: Schema.array(Schema.string()).default([]).description('允许加入的服务器 ID；留空时不允许加入任何服务器'),
  })).default([]).description('Discord 语音频道'),
  telegram: Schema.array(Schema.object({
    id: Schema.string().required().description('唯一后端名称，例如 telegram-calls'),
    selfId: Schema.string().required().description('Telegram 普通用户账号 ID（不支持 Bot Token）'),
    python: Schema.string().required().description('安装媒体依赖的 Python 解释器绝对路径'),
    configPath: Schema.string().required().description('Telegram 私密配置文件绝对路径；先运行 bridge/telegram 的登录工具'),
    allowedChatIds: Schema.array(Schema.string()).default([]).description('允许通话的用户和群组 ID；空列表禁止通话'),
    maxQueueMs: Schema.number().min(20).max(10000).default(2000).description('音频队列上限（毫秒）'),
  })).default([]).description('Telegram 普通用户通话'),
  kook: Schema.array(Schema.object({
    id: Schema.string().required().description('唯一后端名称，例如 kook-voice'),
    token: Schema.string().role('secret').required().description('KOOK Bot Token'),
    selfId: Schema.string().required().description('KOOK 机器人账号 ID'),
    channelIds: Schema.array(Schema.string()).default([]).description('允许加入的语音频道 ID；留空禁止加入'),
    channelPasswords: Schema.dict(Schema.string().role('secret')).default({}).description('需密码的频道：频道 ID → 密码'),
    maxQueueMs: Schema.number().min(20).max(10000).default(2000).description('发送音频队列上限（毫秒）'),
  })).default([]).description('KOOK 语音推流（官方 API 不提供收音）'),
  livekit: Schema.array(Schema.object({
    id: Schema.string().required().description('唯一后端名称，例如 livekit-room'),
    url: Schema.string().required().description('LiveKit WSS 地址；仅本机允许 ws://'),
    apiKey: Schema.string().role('secret').required().description('LiveKit API Key'),
    apiSecret: Schema.string().role('secret').required().description('LiveKit API Secret'),
    selfId: Schema.string().required().description('此参与者的唯一身份；不要与其他客户端共用'),
    roomNames: Schema.array(Schema.string()).default([]).description('允许加入的房间名称'),
    maxQueueMs: Schema.number().min(20).max(10000).default(2000).description('发送音频队列上限（毫秒）'),
  })).default([]).description('LiveKit 音视频房间'),
  historyLimit: Schema.number().min(0).max(1000).default(100).description('内存中保留的已结束通话数量（不保存音频）'),
});
declare module 'koishi' { interface Context { rtc: RtcService } }
declare module '@koishijs/console' { interface Events {
  'rtc/status'(): unknown;
  'rtc/diagnostics'(providerId?: string): unknown;
  'rtc/devices'(providerId: string): unknown;
  'rtc/audio-routes'(providerId: string): unknown;
  'rtc/configure-audio'(providerId: string, inputDevice: string, outputDevice: string): unknown;
  'rtc/channels'(providerId: string): unknown;
  'rtc/control'(action: string, args: Record<string, unknown>): unknown;
  'rtc/video'(action: string, args: Record<string, unknown>): unknown;
} }
export class RtcService extends Service<Config> {
  readonly manager: RtcManager;
  private providers = new Map<string, CallProvider>();
  private startup: { id: string; level: 'error'; message: string }[] = [];
  private levels = new Map<string, { level: number; timestamp: number }>();
  private activity: { at: number; type: string; detail: string }[] = [];
  constructor(ctx: Context, config: Config) {
    super(ctx, 'rtc', true); this.config = config; this.manager = new RtcManager({ historyLimit: config.historyLimit });
    this.manager.on('call', c => this.record('call', `${c.account.platform} · ${c.targetId} · ${c.state}`));
    this.manager.on('diagnostic', d => this.record('diagnostic', `${d.providerId}: ${d.error}`));
    this.manager.on('level', e => this.levels.set(e.callId, { level: e.level, timestamp: e.timestamp }));
    this.manager.on('playback', e => { if (e.state === 'failed') this.record('playback', `${e.callId}: ${e.error || '播放失败'}`); });
    ctx.inject(['console'], ctx => this.console(ctx));
  }
  private record(type: string, detail: string) { this.activity.unshift({ at: Date.now(), type, detail }); this.activity.length = Math.min(100, this.activity.length); }
  /** Consumer scope automatically releases controls and stops queued playback when unloaded. */
  controller(ctx: Context, owner: string): RtcController {
    const controller = this.manager.controller(owner); ctx.on('dispose', () => controller.dispose()); return controller;
  }
  async register(ctx: Context, provider: CallProvider) {
    let disposed = false;
    let unregister: (() => Promise<void>) | undefined;
    const remove = async () => {
      disposed = true;
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id);
      await unregister?.();
    };
    ctx.on('dispose', remove);
    unregister = await this.manager.register(provider);
    if (disposed) { await unregister(); throw new RtcError('DISPOSED', '注册通话后端的插件已停止。'); }
    this.providers.set(provider.id, provider);
    return remove;
  }
  override async start() {
    const ids = [...this.config.bridges, ...this.config.discord, ...(this.config.telegram ?? []), ...(this.config.kook ?? []), ...(this.config.livekit ?? [])].map(p => p.id);
    if (ids.some(id => !/^[\w.-]{1,80}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('通话后端名称必须唯一，仅允许字母、数字、下划线、点与短横线');
    for (const config of this.config.bridges) {
      try { await this.register(this.ctx, new DesktopBridgeProvider(config)); }
      catch (e) { this.startup.push({ id: config.id, level: 'error', message: String(e) }); }
    }
    for (const config of this.config.discord) {
      try {
        const { DiscordProvider } = await import('./providers/discord.js');
        await this.register(this.ctx, new DiscordProvider(config));
      } catch (e) { this.startup.push({ id: config.id, level: 'error', message: String(e).replaceAll(config.token, '[redacted]') }); }
    }
    for (const config of this.config.telegram ?? []) {
      try { const { TelegramProvider } = await import('./providers/telegram.js'); await this.register(this.ctx, new TelegramProvider(config)); }
      catch (e) { this.startup.push({ id: config.id, level: 'error', message: String(e) }); }
    }
    for (const config of this.config.kook ?? []) {
      try { const { KookProvider } = await import('./providers/kook.js'); await this.register(this.ctx, new KookProvider(config)); }
      catch (e) { this.startup.push({ id: config.id, level: 'error', message: String(e).replaceAll(config.token, '[redacted]') }); }
    }
    for (const config of this.config.livekit ?? []) {
      try { const { LiveKitProvider } = await import('./providers/livekit.js'); await this.register(this.ctx, new LiveKitProvider(config)); }
      catch (e) { this.startup.push({ id: config.id, level: 'error', message: String(e).replaceAll(config.apiSecret, '[redacted]').replaceAll(config.apiKey, '[redacted]') }); }
    }
  }
  override async stop() { await this.manager.dispose(); this.providers.clear(); }
  private console(ctx: Context) {
    ctx.console.addEntry({ dev: fileURLToPath(new URL('../client/index.ts', import.meta.url)), prod: fileURLToPath(new URL('./client', import.meta.url)) });
    const controllers = new Map<string, { client: Client; controller: RtcController; detach: () => void }>();
    const previews = new Map<string, { clientId: string; callId: string; trackId: string; frame?: unknown; error?: string }>();
    const dropPreviews = (clientId: string, callId?: string) => {
      for (const [key, preview] of previews) if (preview.clientId === clientId && (callId === undefined || preview.callId === callId)) {
        preview.frame = undefined; previews.delete(key);
      }
    };
    const revoke = (client: Client) => {
      const item = controllers.get(client.id);
      if (!item || item.client !== client) return;
      controllers.delete(client.id); item.detach(); dropPreviews(client.id);
      // dispose closes readers synchronously before awaiting native cleanup.
      void item.controller.dispose();
    };
    const authorize = (client: Client) => {
      const auth = (client as Client & { auth?: { authority?: number; expiredAt?: number } }).auth;
      if (!auth || typeof auth.authority !== 'number' || !Number.isFinite(auth.authority) || auth.authority < 4 || typeof auth.expiredAt !== 'number' || !Number.isFinite(auth.expiredAt) || auth.expiredAt <= Date.now() || client.socket.readyState !== 1) throw new RtcError('FORBIDDEN', '请先在 Koishi 控制台以权限等级 4 登录（需要 auth 插件）。');
    };
    const getController = (client: Client) => {
      try { authorize(client); } catch (error) { revoke(client); throw error; }
      let item = controllers.get(client.id);
      if (item && item.client !== client) throw new RtcError('FORBIDDEN', '控制台会话已改变，请重新连接。');
      if (!item) {
        const close = () => revoke(client);
        client.socket.addEventListener('close', close);
        item = { client, controller: this.manager.controller(`console:${client.id}`), detach: () => client.socket.removeEventListener('close', close) };
        controllers.set(client.id, item);
      }
      return item.controller;
    };
    const checkSession = (client: Client, controller: RtcController) => {
      try {
        authorize(client);
        if (controllers.get(client.id)?.controller !== controller || controllers.get(client.id)?.client !== client) throw new RtcError('FORBIDDEN', '控制台会话已释放。');
      } catch (error) { revoke(client); throw error; }
    };
    ctx.setInterval(() => {
      for (const item of controllers.values()) {
        try { authorize(item.client); } catch { revoke(item.client); }
      }
      for (const [id, level] of this.levels) if (Date.now() - level.timestamp > 5000) this.levels.delete(id);
    }, 1000);
    ctx.on('dispose', async () => {
      const pending = [...controllers.values()].map(item => { item.detach(); dropPreviews(item.client.id); return item.controller.dispose(); });
      controllers.clear(); await Promise.allSettled(pending);
    });
    const service = this;
    ctx.console.addListener('rtc/status', function (this: Client) {
      authorize(this); return { operator: `console:${this.id}`, providers: service.manager.listProviders(), calls: service.manager.listCalls(), levels: Object.fromEntries(service.levels), activity: service.activity, startup: service.startup };
    }, { authority: 4 });
    ctx.console.addListener('rtc/diagnostics', async function (this: Client, providerId) { authorize(this); return [...service.startup, ...await service.manager.diagnostics(providerId)]; }, { authority: 4 });
    ctx.console.addListener('rtc/devices', async function (this: Client, providerId) {
      authorize(this); const provider = service.providers.get(providerId);
      if (!(provider instanceof DesktopBridgeProvider)) return []; return provider.devices();
    }, { authority: 4 });
    ctx.console.addListener('rtc/audio-routes', async function (this: Client, providerId) {
      authorize(this); const provider = service.providers.get(providerId); return provider instanceof DesktopBridgeProvider ? provider.audioRoutes() : { editable: false };
    }, { authority: 4 });
    ctx.console.addListener('rtc/configure-audio', async function (this: Client, providerId, inputDevice, outputDevice) {
      authorize(this); const provider = service.providers.get(providerId);
      if (!(provider instanceof DesktopBridgeProvider) || typeof inputDevice !== 'string' || typeof outputDevice !== 'string') throw new Error('音频路由参数无效');
      return provider.configureAudio(inputDevice, outputDevice);
    }, { authority: 4 });
    ctx.console.addListener('rtc/channels', async function (this: Client, providerId) {
      authorize(this); const p = service.providers.get(providerId) as CallProvider & { channels?: () => Promise<unknown> };
      return p?.channels ? p.channels() : [];
    }, { authority: 4 });
    ctx.console.addListener('rtc/control', async function (this: Client, action, args) {
      const c = getController(this);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('操作参数无效');
      if (action === 'dial') {
        if (typeof args.providerId !== 'string' || typeof args.targetId !== 'string' || !['direct','group'].includes(String(args.kind))) throw new Error('请选择通话对象');
        return c.dial(args.providerId, { kind: args.kind, targetId: args.targetId, guildId: args.guildId, media: args.media, groupMode: args.groupMode, inviteeIds: args.inviteeIds } as CallRequest);
      }
      if (typeof args.callId !== 'string') throw new Error('请选择通话');
      if (action === 'release') { if (service.manager.getCall(args.callId).owner !== `console:${this.id}`) throw new RtcError('NOT_CONTROLLER', '这次通话由其他插件或窗口控制。'); dropPreviews(this.id, args.callId); return c.release(args.callId); }
      if (!['accept','reject','hangup','mute','clear','tone'].includes(action)) throw new Error('未知操作');
      c.claim(args.callId);
      if (action === 'mute') { if (typeof args.muted !== 'boolean') throw new Error('无效静音设置'); return c.setMuted(args.callId, args.muted); }
      if (action === 'tone') {
        const call = service.manager.getCall(args.callId), provider = service.providers.get(call.providerId), format = provider?.audioFormat;
        if (!format) throw new Error('后端未声明音频格式');
        const samples = Math.round(format.sampleRate * .02);
        for (let part = 0; part < 20; part++) {
          const data = Buffer.alloc(samples * format.channels * 2);
          for (let i = 0; i < samples; i++) {
            const index = part * samples + i, total = 20 * samples;
            const envelope = Math.min(1, index / (format.sampleRate * .015), (total - index) / (format.sampleRate * .015));
            const value = Math.round(Math.sin(index * 2 * Math.PI * 440 / format.sampleRate) * 2500 * envelope);
            for (let channel = 0; channel < format.channels; channel++) data.writeInt16LE(value, (i * format.channels + channel) * 2);
          }
          await c.writeAudio(args.callId, { ...format, data, sequence: part, timestamp: Date.now() });
        }
        return { queuedMs: 400 };
      }
      if (action === 'clear') return c.clearAudio(args.callId);
      return c[action as 'accept' | 'reject' | 'hangup'](args.callId);
    }, { authority: 4 });
    ctx.console.addListener('rtc/video', async function (this: Client, action, args) {
      const c = getController(this);
      if (!['state', 'sources', 'subscribe', 'unsubscribe', 'frame', 'send', 'stop'].includes(action)) throw new Error('未知视频操作');
      const validId = (id: unknown, max: number) => typeof id === 'string' && id.length > 0 && id.length <= max && !id.includes('\0');
      if (!args || typeof args !== 'object' || Array.isArray(args) || !validId(args.callId, 1024)) throw new Error('请选择通话');
      const callId = args.callId as string;
      if (['subscribe', 'send', 'stop'].includes(action) && !['camera', 'screen'].includes(String(args.kind))) throw new Error('请选择视频类型');
      if (action === 'subscribe' && !validId(args.participantId, 160)) throw new Error('请选择成员');
      if (action === 'send' && !validId(args.sourceId, 2048)) throw new Error('请选择画面来源');
      if (action === 'send' && args.framing !== undefined && (typeof args.framing !== 'string' || !['full', 'portrait-safe'].includes(args.framing) || args.kind !== 'camera' || args.sourceId !== 'external-frames')) throw new Error('画幅仅适用于外部帧摄像头渠道');
      if (['frame', 'unsubscribe'].includes(action) && !validId(args.trackId, 512)) throw new Error('请选择视频轨道');
      // A delayed preview poll or unmount cleanup must never reclaim a released
      // lease. Only an explicit new viewing/sending action may obtain control.
      if (['frame', 'unsubscribe', 'stop'].includes(action)) {
        if (service.manager.getCall(callId).owner !== `console:${this.id}`) throw new RtcError('NOT_CONTROLLER', '视频预览的控制权已释放。');
      } else c.claim(callId);
      const checked = async <T>(pending: Promise<T>) => { const result = await pending; checkSession(this, c); return result; };
      if (action === 'state') return checked(c.videoState(callId));
      if (action === 'sources') return checked(c.videoSources(callId));
      if (action === 'send') return checked(c.sendVideo(callId, { kind: args.kind as 'camera' | 'screen', sourceId: args.sourceId as string, ...(args.framing === undefined ? {} : { framing: args.framing as 'full' | 'portrait-safe' }) }));
      if (action === 'stop') return checked(c.stopVideo(callId, args.kind as 'camera' | 'screen'));
      if (action === 'subscribe') {
        const track = await checked(c.subscribeVideo(callId, { participantId: args.participantId as string, kind: args.kind as 'camera' | 'screen' }));
        const key = `${this.id}\0${callId}\0${track.trackId}`;
        if (!previews.has(key)) {
          const preview = { clientId: this.id, callId, trackId: track.trackId, frame: undefined as unknown, error: undefined as string | undefined };
          previews.set(key, preview);
          void (async () => {
            try {
              for await (const frame of c.video(callId, track.trackId)) {
                checkSession(this, c);
                if (previews.get(key) !== preview) break;
                preview.frame = { ...frame, data: Buffer.from(frame.data).toString('base64') };
              }
            } catch (error) { preview.error = String(error); }
            finally { preview.frame = undefined; if (previews.get(key) === preview) previews.delete(key); }
          })();
        }
        return track;
      }
      const key = `${this.id}\0${callId}\0${args.trackId}`;
      if (action === 'frame') {
        const preview = previews.get(key);
        return { frame: preview?.frame ?? null, error: preview?.error ?? null, ended: !preview };
      }
      const preview = previews.get(key); if (preview) preview.frame = undefined; previews.delete(key);
      return checked(c.unsubscribeVideo(callId, args.trackId as string));
    }, { authority: 4 });
    // Console listeners are not scoped by Koishi. Drop only this instance's
    // handlers so disabling/reloading the plugin cannot keep stale controls.
    const listeners = ctx.console.listeners;
    const ownedListeners = ['rtc/status', 'rtc/diagnostics', 'rtc/devices', 'rtc/audio-routes', 'rtc/configure-audio', 'rtc/channels', 'rtc/control', 'rtc/video']
      .map(name => [name, listeners[name]] as const);
    ctx.on('dispose', () => {
      for (const [name, listener] of ownedListeners) if (listeners[name] === listener) delete listeners[name];
    });
  }
}
export function apply(ctx: Context, config: Config) { ctx.plugin(RtcService, config); }
