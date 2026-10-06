import type { Context } from 'koishi';
import { Schema } from 'koishi';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {} from 'koishi-plugin-rtc-bridge'; // Adds ctx.rtc to Context.
import type { AudioFormat, CallSnapshot } from 'koishi-plugin-rtc-bridge/core';

export const name = 'rtc-pcm-example';
export const inject = ['rtc'];

export interface Config {
  allowed: {
    providerId: string; platform: string; selfId: string;
    kind: 'direct' | 'group'; targetId: string;
  }[];
  seconds: number;
}

export const Config: Schema<Config> = Schema.object({
  allowed: Schema.array(Schema.object({
    providerId: Schema.string().required(),
    platform: Schema.string().required(),
    selfId: Schema.string().required(),
    kind: Schema.union(['direct', 'group']).required(),
    targetId: Schema.string().required(),
  })).default([]).description('精确匹配允许操作的后端、登录账号及通话对象；空列表禁用'),
  seconds: Schema.number().min(1).max(10).default(5).description('每次读取 PCM 的最长秒数'),
});

export function apply(ctx: Context, config: Config) {
  if (!Number.isFinite(config.seconds) || config.seconds < 1 || config.seconds > 10) {
    throw new Error('seconds 必须在 1–10 之间');
  }
  const control = ctx.rtc.controller(ctx, name); // Automatically disposed with this plugin.
  const jobs = new Map<string, { abort: AbortController; done: Promise<string> }>();
  let disposed = false;
  const permitted = (call: CallSnapshot) => config.allowed.some(rule =>
    rule.providerId === call.providerId && rule.platform === call.account.platform
    && rule.selfId === call.account.selfId && rule.kind === call.kind
    && rule.targetId === call.targetId);

  async function sample(callId: string, tone: boolean, abort: AbortController) {
    const call = ctx.rtc.manager.getCall(callId);
    if (!permitted(call)) throw new Error('该通话的账号或对象不在允许列表中');
    if (call.state !== 'connected') throw new Error('只允许操作已连接的通话');
    const provider = ctx.rtc.manager.listProviders().find(item => item.id === call.providerId);
    if (!provider?.capabilities.receiveAudio.supported) throw new Error('后端暂不支持接收 PCM');
    if (tone && (!provider.capabilities.sendAudio.supported || !provider.audioFormat)) {
      throw new Error('后端暂不支持发送 PCM 或未声明发送格式');
    }
    if (tone && call.muted) throw new Error('本端已静音，请先由管理员明确取消静音');
    control.claim(callId); // Fails if another plugin or console holds the lease.

    const timer = setTimeout(() => abort.abort(), config.seconds * 1000);
    let frames = 0, samples = 0, sumSquares = 0, submittedBytes = 0;
    let failure: unknown;
    // Only local synthesized samples enter writeAudio; received PCM is never echoed.
    const writer = (tone ? sendTone(provider.audioFormat!) : Promise.resolve()).catch(error => {
      if (!abort.signal.aborted) { failure = error; abort.abort(); }
    });
    async function sendTone(format: AudioFormat) {
      const playback = randomUUID(), samplesPerFrame = Math.round(format.sampleRate * 0.02);
      for (let sequence = 0; sequence < 20; sequence++) {
        abort.signal.throwIfAborted();
        const data = Buffer.alloc(samplesPerFrame * format.channels * 2);
        for (let i = 0; i < samplesPerFrame; i++) {
          const position = sequence * samplesPerFrame + i;
          const fade = Math.min(1, position / (format.sampleRate * 0.015),
            (20 * samplesPerFrame - position) / (format.sampleRate * 0.015));
          const value = Math.round(Math.sin(position * 2 * Math.PI * 440 / format.sampleRate) * 2500 * fade);
          for (let channel = 0; channel < format.channels; channel++) {
            data.writeInt16LE(value, (i * format.channels + channel) * 2);
          }
        }
        // Await each 20 ms write: at most one request is in flight.
        const receipt = await control.writeAudio(callId, {
          ...format, data, sequence, timestamp: Date.now(),
        }, `${playback}:${sequence}`);
        if (receipt.state === 'failed' || receipt.state === 'cancelled') {
          throw new Error(receipt.error || `音频提交 ${receipt.state}`);
        }
        submittedBytes += receipt.acceptedBytes;
        await delay(20, undefined, { signal: abort.signal });
      }
    }
    try {
      for await (const frame of control.audio(callId, { signal: abort.signal, maxBufferMs: 500 })) {
        const view = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        for (let offset = 0; offset < view.byteLength; offset += 2) {
          const value = view.getInt16(offset, true) / 32768;
          sumSquares += value * value;
          samples++;
        }
        frames++;
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    } finally {
      clearTimeout(timer);
      abort.abort();
      // Release immediately cancels pending reads and clears queued playback.
      const [, release] = await Promise.allSettled([writer, control.release(callId)]);
      if (release?.status === 'rejected') failure ??= release.reason;
    }
    if (failure) throw failure;
    const rms = samples ? Math.sqrt(sumSquares / samples).toFixed(4) : '无样本';
    return `已释放控制权；收到 ${frames} 帧，RMS=${rms}。`
      + (tone ? `音调已提交 ${submittedBytes} 字节（不代表远端已听见）。` : '');
  }

  ctx.command('rtc-pcm <callId:string>', '有界读取允许通话的 PCM', { authority: 4 })
    .userFields(['authority'])
    .option('tone', '--tone 显式发送 400 ms 本地测试音调')
    .action(async ({ session, options }, callId) => {
      // Fail closed for programmatic execution without an authenticated user.
      if (!session?.user || !Number.isFinite(session.user.authority) || session.user.authority < 4) return '需要权限等级 4';
      if (disposed) return '插件已卸载';
      if (!callId) return '请提供已连接通话的 callId';
      if (jobs.has(callId)) return '该通话已有 PCM 任务，可用 rtc-pcm.stop 停止';
      const job = { abort: new AbortController(), done: Promise.resolve('') };
      jobs.set(callId, job);
      job.done = sample(callId, Boolean(options?.tone), job.abort).finally(() => jobs.delete(callId));
      try { return await job.done; }
      catch (error) { return `PCM 任务已停止：${error instanceof Error ? error.message : String(error)}`; }
    });

  ctx.command('rtc-pcm.stop <callId:string>', '停止本示例的 PCM 任务并释放控制权', { authority: 4 })
    .userFields(['authority'])
    .action(async ({ session }, callId) => {
      if (!session?.user || !Number.isFinite(session.user.authority) || session.user.authority < 4) return '需要权限等级 4';
      const job = jobs.get(callId);
      if (!job) return '该通话没有本示例启动的任务';
      job.abort.abort();
      await job.done.catch(() => {});
      return '已停止任务并释放控制权；通话仍由客户端管理';
    });

  ctx.on('dispose', async () => {
    disposed = true;
    for (const job of jobs.values()) job.abort.abort();
    await Promise.allSettled([...jobs.values()].map(job => job.done));
  });
}
