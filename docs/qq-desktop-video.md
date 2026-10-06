# QQ 桌面视频适配

Linux、Windows、macOS 共用通话关联、原生解码证据、订阅与两条发送渠道。Windows x64 和 macOS ARM64/x64 已接入固定官方构建的原生协议并开放；实机验收仍待目标系统用户完成。当前 Linux ARM64 的 QQ 双路收发经过实测，不能用它代替其他平台的验收。

平台来源层负责三件事：

1. Electron `desktopCapturer` 枚举 source ID，零尺寸缩略图，不主动抓取私有画面。
2. 显式选中窗口/显示器后，独立 in-memory session 只给该 ID 开 display capture，拒绝音频、弹窗和导航；画面维持原比例，来源结束就停止发送。source ID 失效不降级到其他窗口或显示器。
3. 只把自有渲染窗口的 `getMediaSourceId()` 数字部分传给 QQ。Windows 是 HWND，macOS 是 CGWindowID，Linux 是 X11 Window。尤其不能拿 macOS NSView 指针当窗口 ID。显示器不依赖推测的 Electron ID/QQ display index 对应关系。

任意 JPEG 帧输出继续用原有 `writeVideo`：screen 画到自有窗口，camera 经明确配置的 pyvirtualcam 虚拟设备。Linux 保留 NV12 页对齐防花屏；Windows/macOS 使用其后端的 RGBA 输入，设备 ID 与 QQ 实际枚举核对后才启动。缺权限、缺依赖、驱动打不开、原生拒绝或超时均是失败，不伪造成功。

[Windows 配置](qq-windows.md#视频收发实现已开放等待-windows-实机验收)、[macOS 配置](qq-macos.md#视频收发实现已开放等待-macos-实机验收)、[原生静态证据](../bridge/qq/desktop-video-evidence.json)。

验收按层记录：精确原生 profile → 权限与源枚举 → 原生本地启停 ACK → 上层 writeVideo 回执 → 对方实际看到两路独立动态画面。私聊普通视频、私聊屏幕通话、群通话都检查；还需覆盖摄像头占用/拔除、窗口关闭、取消或挂断中的晚到回调、再次拨给同一人、Mac Intel/Apple Silicon、Windows 显示缩放，以及重启后的权限。离线测试不会把这些项目标为已通过。

协议与平台 API 依据：[Electron DesktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[BrowserWindow.getMediaSourceId](https://www.electronjs.org/docs/latest/api/browser-window#wingetmediasourceid)、[系统权限](https://www.electronjs.org/docs/latest/api/system-preferences)、[pyvirtualcam](https://github.com/letmaik/pyvirtualcam)。
