# LiveKit 音视频房间

此后端使用 LiveKit 官方 Node 原生 RTC SDK，直接收发 WebRTC 媒体，无需桌面客户端、虚拟声卡或系统麦克风。可以连接自行部署的 LiveKit 或 LiveKit Cloud；这不是对微信、飞书或腾讯会议房间的协议转换。

在 rtc-bridge 的 `livekit` 配置中新增：

- `id`：唯一后端名称。
- `url`：服务端 `wss://` 地址；仅本机测试允许 `ws://127.0.0.1`。
- `apiKey`、`apiSecret`：服务端凭据，均使用秘密字段。
- `selfId`：本插件在 LiveKit 中使用的独立参与者 identity，不与其他客户端共用。
- `roomNames`：允许加入的房间名称列表；空列表禁止加入。
- `maxQueueMs`：音频发送队列上限，默认 2000 毫秒。

控制台直接点选白名单房间并加入。入会生成仅允许该房间的短期 JWT，并核对服务端返回的房间名和参与者 identity。SDK 加载成功只表示本地依赖就绪；服务端凭据在实际加入时校验。不会自动入会或自动重连，连接中断后需要重新加入。

接收音频按参与者身份分开，输出 48 kHz 双声道 PCM。视频在用户或消费插件明确订阅后才交付 JPEG；摄像头与屏幕共享保留独立来源。发送来源是消费插件通过 `writeVideo` 提供的 JPEG 帧，两个渠道可同时发送不同内容，不会调用本机摄像头或抓取桌面。

`framing: 'portrait-safe'` 在摄像头渠道使用 360×640 画布完整容纳输入画面；默认画布为 640×360。画面按比例缩放留边，不擅自裁切或旋转输入。接收端按 SDK 的帧旋转元数据转正后编码 JPEG。

发送回执只确认交给本地 AudioSource/VideoSource，不冒充网络接收或远端播放。停止、释放控制、插件卸载会取消媒体流并关闭资源。

## 安装和验证

`npm install` 安装可选依赖 `@livekit/rtc-node`、`livekit-server-sdk`、`sharp`。安装平台必须有这些依赖支持的原生包；依赖缺失只使该后端启动失败，不影响 QQ 等其他后端。

自动回归默认不会连接外部房间。可用本地官方服务端执行真实传输测试：

```sh
RTC_LIVEKIT_SERVER=/绝对路径/livekit-server npx tsx --test test/livekit-integration.test.ts
```

测试创建临时凭据与仅监听环回地址的服务端，验证 PCM、独立的摄像头/屏幕视频以及关闭清理，结束后停止服务端并删除临时凭据。

接口依据：[官方 Node RTC SDK](https://github.com/livekit/node-sdks/tree/main/packages/livekit-rtc)、[媒体处理](https://docs.livekit.io/transport/media/raw-tracks/)。
