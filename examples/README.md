# 实时媒体消费插件示例

## JPEG 视频

`video-consumer.ts` 导出 `createVideoConsumer(ctx, owner)`，供另一个 Koishi 插件在 `apply()` 中创建。创建时不会拨号或打开设备；只有消费插件经自己的命令/按钮明确调用 `run()`，才会取得指定已连接通话的控制权。`expected` 必须精确匹配后端、账号和通话对象，接收订阅还须指定当前成员的原生 `participantId`。

```ts
const video = createVideoConsumer(ctx, 'my-plugin:video');
// 在已授权的命令/按钮处理器中调用；这些参数由消费插件提供。
await video.run({
  callId, expected, signal: abort.signal,
  receive: [
    { participantId, kind: 'camera' },
    { participantId, kind: 'screen' },
  ],
  onFrame: async (frame, signal) => consumeJpeg(frame, signal),
  outputs: {
    camera: signal => cameraJpegs(signal),
    screen: signal => screenJpegs(signal),
  },
  onReceipt: receipt => console.log(receipt.kind, receipt.state, receipt.evidence),
});
```

`cameraJpegs` 与 `screenJpegs` 是消费插件分别提供的 `AsyncIterable<{data: Uint8Array, width: number, height: number}>`，它们可以来自任何明确授权的来源；两个渠道不会互相复制输入。只接收时省略 `outputs`，只发送时传 `receive: []`。QQ 普通私聊只支持摄像头；屏幕渠道需要群通话或明确建立的私聊屏幕共享会话。

每个输入自己控制帧率，JPEG 最大 256 KiB、最多 2,073,600 像素、单边最多 4096；示例生成各渠道独立递增序号并逐帧等待回执。输入生成器及 `onFrame`/`onReceipt` 必须响应传入的 `AbortSignal`，包括正在等待下一帧时；不响应取消的自定义代码会阻塞清理。公共订阅只保留最新帧。`rendered`/`submitted` 只证明本地窗口或虚拟设备接收，不能当作远端显示成功。

`abort.abort()` 或 `await video.stop(callId)` 停止本次任务；自然结束的发送源只停止自己的渠道。错误、通话结束、控制权丢失和插件卸载会取消剩余任务，停止输出、取消订阅并释放控制权，清理失败会抛出错误。桥负责先停止 QQ 原生采集，再关闭虚拟相机 worker；消费插件不要自己提前关闭 worker。此示例不会挂断通话，也不绑定任何识别或模型服务。

离线生命周期验证：`node --import tsx --test examples/video-consumer.test.mjs`，使用假后端，不启动设备或通话。

仓库的 `npm test` 已包含这个回归，`npm run check` 会直接对照当前源码检查两个示例，不依赖旧的 `dist` 类型声明。

## 连续 PCM

`pcm-consumer.ts` 是独立 Koishi 插件，通过公开服务 `ctx.rtc` 消费实时音频。它不拨号、不接听；仅在权限等级 4 的用户明确执行命令时，接管已连接且精确匹配配置的通话。默认允许列表为空。

先启用 `rtc-bridge`，将本示例作为另一个插件加载并配置，例如：

```yaml
allowed:
  - providerId: qq-desktop
    platform: onebot
    selfId: '填写实际登录账号'
    kind: direct
    targetId: '填写通话快照中的原生 targetId'
seconds: 5
```

从 RTC 管理页面获取当前已连接通话的完整 `callId`。QQ 的原生 UID 不能用数字 QQ 号替代；群语音配置 `kind: group` 与该通话的 `targetId`。

- `rtc-pcm <callId>`：取得控制权后连续读取 PCM，最多读取配置的秒数（1–10 秒），返回帧数及归一化 RMS。
- `rtc-pcm <callId> --tone`：同时使用后端声明的采样率和声道，按 20 ms 分帧发送 400 ms 的本地 440 Hz 音调。
- `rtc-pcm.stop <callId>`：中止本示例正在进行的任务并释放控制权。

读取缓冲最多 500 ms，超限即失败。音频仅用于内存中的统计，不保存、不回传；发送数据全部在本地生成，避免音频回送循环。每帧写入都等待 API 回执，但提交成功不保证远端已经听见。超时、停止、错误及插件卸载会中止订阅并释放控制权，清除尚未播放的队列；不会挂断客户端通话。

在仓库根目录运行（需要仓库已生成 `dist`，或在独立插件项目中安装 `koishi` 与 `koishi-plugin-rtc-bridge`）：

```sh
npx tsc -p examples/tsconfig.json --noEmit
npx tsc -p examples/tsconfig.json
```

第二条命令输出 `examples/dist/pcm-consumer.js`、`video-consumer.js` 和类型声明。PCM 模块可以直接注册为插件；视频模块由消费插件导入其工厂函数。复制到独立插件包时保留 `type: module`，并声明对 `koishi` 和 `koishi-plugin-rtc-bridge` 的依赖；类型扩展通过 `import type {}` 加载，不需要手工声明 `ctx.rtc`。
