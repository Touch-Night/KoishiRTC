# KOOK 语音推流

本后端使用 KOOK 官方 `voice/join`、`voice/leave`、`voice/keep-alive` 与 RTP Opus。它能加入允许的语音频道，将消费插件的 PCM 连续发送到频道；官方接口没有提供接收用户音频或视频的入口，因此不会声明 receiveAudio、receiveVideo、私聊拨号等能力。

在 Koishi 的 rtc-bridge 配置 `kook` 中新增一项：

- `id`：唯一后端名称，例如 `kook-voice`。
- `token`：KOOK Bot Token，使用配置中的秘密字段。
- `selfId`：机器人用户 ID。启动时通过 `user/me` 核对实际身份。
- `channelIds`：允许加入的语音频道 ID。空列表禁止加入。
- `channelPasswords`：可选的频道 ID → 密码字典。
- `maxQueueMs`：待发送音频上限，默认 2000 毫秒。

控制台可以枚举白名单内的语音频道、加入、静音、清空播放及退出。后端不会接管账号已被其他应用加入的频道，不会自动加入。无需虚拟声卡，也不需要 ffmpeg；使用 opusscript 将 48 kHz 双声道 PCM 编码为 20ms Opus 包。

同一 UDP socket 持续发送 RTP 与 RTCP，遵循服务端返回的 SSRC、payload type、端口与码率；40 秒一次 keep-alive。发送静音控制只影响本插件输出。`dispatched` 仅说明本机 UDP 发送完成，`playedBytes` 保持 0，不代表远端已经听到。

已验证真实 Opus 编解码和本地 UDP RTP/RTCP 收包；未使用 KOOK 账号在线验收。离开请求失败时保留“正在结束”，继续阻止新入会，可重新点击退出清理。

一手接口：[KOOK 语音 API](https://developer.kookapp.cn/doc/http/voice)、[账号身份](https://developer.kookapp.cn/doc/http/user)。
