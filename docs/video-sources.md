# 原始视频源与虚拟相机输出

`bridge/video` 是独立的 ESM 模块，支持 Linux、Windows、macOS。默认 `generated` 源只生成移动色条与帧序号标记；`external` 源只接受调用者送入的原始帧，不会打开摄像头或截取桌面。公共订阅接口的 JPEG `VideoFrame` 与这里的 `VideoSourceFrame` 是两种不同格式。

视频上行的可用边界是：生成或外部帧 → 本地虚拟相机 → 平台明确选中该相机 → 通话发送。此模块实现前两步。QQ 摄像头与屏幕共享的原生控制、授权和远端接收由平台 provider 处理；传到本地虚拟相机不证明 QQ 已发送，也不证明对方看到画面。

## API

```js
import { createVideoSource, createVirtualCameraSink } from './bridge/video/index.mjs';

const format = { width: 640, height: 360, fps: 15, pixelFormat: 'i420' };
const scope = { callId: 'my-call', sourceId: 'generated:color-bars' };
const source = createVideoSource({ ...format, backend: 'generated', sourceId: scope.sourceId });
// Linux 示例。设备必须已经存在且确认为 v4l2loopback；这里不创建或安装设备。
const sink = createVirtualCameraSink({ ...format, backend: 'v4l2loopback', device: '/dev/video20' });

source.on('error', error => { console.error(error); void sink.stop(); });
sink.on('error', error => { console.error(error); void source.stop(); });
source.on('frame', frame => {
  try { void sink.write(frame).then(receipt => console.log(receipt.state, receipt.evidence)); }
  catch (error) { console.error(error); void source.stop(); }
});
await sink.start(scope);
await source.start({ callId: scope.callId });
// 通话结束、租约丢失或来源切换时：先停止平台的视频发送，再停止 source 与 sink。
// await source.stop(); await sink.stop();
```

`createVideoSource` 返回 EventEmitter，提供 `start({callId,signal?})`、`stop()`、`listSources()`、`diagnostics()`；事件为 `frame`、`state`、`error`。`external` 还提供同步 `write(frame)`，必须显式配置 `sourceId` 和 `kind: 'camera'|'screen'|'generated'`。调用者负责已有摄像头/屏幕来源的授权，不允许根据任意远端消息自动启用采集。

`VideoSourceFrame` 类型见 `bridge/video/types.ts`。尺寸 2×2 至 1920×1080，1–60 fps；I420 必须偶数宽高、连续 Y/U/V 三平面，RGBA 为逐像素 R/G/B/A。每次 `start` 绑定 `callId`，同一来源会话内序号严格递增；来源切换或租约变化应停止旧队列并建立新会话，拒绝迟到帧。

`LatestVideoFrameQueue` 最多保留一个正在提交的帧与一个最新待发帧。较旧待发帧返回 `dropped`；超时使队列关闭；停止取消未确认帧。它从不返回 `played`。独立传输适配器必须遵守 AbortSignal，关闭输出通道，避免失去所有权后继续发送。

`encodeVideoFrame` / `decodeVideoFrame` 的内部二进制格式为 `KRV1` + 4 字节大端 JSON 长度 + 4 字节大端原始数据长度 + JSON 元数据 + 像素。元数据最多 2048 字节，原始帧最多 8,294,400 字节，不经过现有 512 KiB 音频 WebSocket。不要直接把无上限的 base64 原始视频塞进音频通道。

## 可选虚拟相机

仅使用生成源不需要 Python。使用本地虚拟相机输出时，在所选 Python 3.10+ 环境执行：

```sh
python -m pip install -r bridge/video/requirements.txt
python bridge/video/virtual_camera_worker.py --diagnostics
```

诊断只检查 Python 模块，不打开设备，不安装驱动。`createVirtualCameraSink` 的 `python` 参数可指定独立环境的可执行文件。

| 系统 | 显式 backend | 显式 device |
| --- | --- | --- |
| Linux | `v4l2loopback` | 已创建的 `/dev/videoN` |
| Windows | `obs` / `unitycapture` | `OBS Virtual Camera` / Unity Capture 的确切设备名 |
| macOS | `obs` | `OBS Virtual Camera` |

这些后端需要用户事先安装对应虚拟相机。Linux 启动时通过 `VIDIOC_QUERYCAP` 验证驱动为 v4l2loopback，拒绝物理摄像头。设备未找到或确认返回的设备与配置不同就停止，不尝试默认相机或其他后端。[pyvirtualcam 官方 API](https://letmaik.github.io/pyvirtualcam/)

macOS 13 及以上配合当前 pyvirtualcam 需要 OBS 30+；OBS 内建相机只有一个实例，不能让 OBS 与此 worker 同时向它输出。各系统仍须单独验收原生相机安装、权限与 QQ 选设备流程。[pyvirtualcam 安装说明](https://github.com/letmaik/pyvirtualcam#supported-virtual-cameras)

确认设备后，以下命令显式输出 10 秒合成画面。它不会操作 QQ，也不会采集桌面或物理摄像头：

```sh
# Linux：把 video20 替换成已核对的虚拟设备。
node bridge/video/demo.mjs --run --backend v4l2loopback --device /dev/video20 --seconds 10
# Windows/macOS：需先安装并释放对应 OBS 虚拟相机。
node bridge/video/demo.mjs --run --backend obs --device "OBS Virtual Camera" --seconds 10
```

没有 `--run`、backend 或 device 时命令拒绝运行。Ctrl+C 停止 source 和 worker。`dispatched` + `pyvirtualcam-send` 只表示 Python `camera.send()` 返回成功。某些虚拟相机会保留最后一帧；`clear()` 会关闭本地 worker，但不能证明远端停止发送旧画面，必须同时执行平台的视频停止操作。

Linux 的设备输出明确使用 **NV12**，输入协议仍接受 RGBA 或 I420，且两者都要求偶数宽高。RGBA 通过 NumPy 转为 BT.601 limited-range：Y 平面在前，色度先按 2×2 RGB 块平均，再按 U、V 交织；alpha 不参与颜色计算。I420 保留所有样本，仅把原有独立 U/V 平面交织，色彩范围沿用输入。其他系统保留原来的输出格式。

worker 启动会核对 `camera.native_fmt` 确实为 NV12，`ready` 报告原输入 `pixelFormat`、`outputPixelFormat: 'nv12'`、`nativePixelFormat: 'nv12'` 和 `rgba-to-nv12` / `i420-to-nv12`。回执字节数仍按输入格式计算。RGB 输入在 pyvirtualcam Linux 后端会自动变成 I420；本次精确 Linux QQ 客户端的 I420 捕获 shader 缺失、NV12 shader 存在，因此这条兼容路径显式绕开 I420 设备输出。

此前 2026-10-06 本机 `/dev/video42` 的 640×360、15 fps、10 秒 RGBA 输入测试曾得到 150 帧本地提交、零丢帧/失败；它发生在旧 I420 设备输出路径，不能作为 NV12 或远端视频已通过的证据。NV12 转换已做真实 NumPy 的颜色、2×2 降采样及内存布局离线测试；真实 QQ 复测另行记录。

## QQ 安装副本与外部帧配置

三平台 QQ 安装器会按固定清单部署 `video` 运行模块、Python worker、依赖清单及它们引用的 `audio/common.mjs`。Linux/Windows 路径为 `<安装目录>/video`；macOS 为 `<安装目录>/bridge/video`。不复制源码目录中的运行数据、token、Python 缓存或预编译的本机库，也不自动安装或启动相机驱动。Linux 的音频 guard 仍在目标机器编译。

在选定的 Python 环境安装部署目录中的 `video/requirements.txt`，再创建 AV Host 的 `<KOISHI_RTC_QQ_BRIDGE_DIR>/runtime/video.json`。Linux/Windows 的 bridgeDir 通常就是安装目录；macOS 为 `<安装目录>/bridge/qq`。`python` 使用绝对路径，例如：

```json
{
  "virtualCamera": {
    "backend": "v4l2loopback",
    "device": "/dev/video42",
    "python": "/absolute/path/to/video-venv/bin/python"
  }
}
```

此配置只定义输出设备，不会采集物理相机。消费插件选中 `external-frames` 后，通过公共 `writeVideo` 提供 JPEG 帧；输出渠道可以是 `screen`，或配置完成的 `camera`。摄像头渠道先启动生产者，再由 QQ 枚举并明确匹配同一设备。Linux 使用 `VIDIOC_QUERYCAP` 的 `bus_info` 作为 `sink.nativeDeviceId`（例如 `platform:v4l2loopback-042`），不把 `/dev/video42` 当作 QQ 的设备 ID。Windows/macOS 可显式设置 `qqDeviceId`；否则尝试精确匹配配置的 `device`。枚举不匹配时应报错，不选择第一台或默认相机。

屏幕渠道把外部帧绘制到 AV Host 自有窗口后共享该窗口；它不需要虚拟相机驱动。相机渠道的本地提交回执仍不证明远端收到或显示了帧。Windows/macOS 的虚拟设备与 QQ 相机上行尚待各自系统实测。

Linux `FrameOutputs` 的实际相机输出尺寸按系统页大小选择：4 KiB 页为 **1024×576**，64 KiB 页为 **1024×640**。输入 JPEG 在这个固定画布中等比缩放并留黑边，不裁剪、不拉伸；64 KiB 页下的额外高度用于设备缓冲对齐。输入帧的原始尺寸不等于虚拟相机输出尺寸。屏幕渠道仍使用自己的独立窗口。

`FrameOutputs.open(kind, callId, { framing })` 支持两种相机内容布局，默认 `full`：

- `full`：将完整输入图等比放入整个画布，适合群视频或能显示完整横屏画面的客户端。
- `portrait-safe`：将完整输入图等比放入中央 **9:16** 安全区，供会把横屏视频居中铺满竖屏界面的接收端使用。横屏源会留更多黑边；9:16 竖屏源直接填满安全区，不会再次重复缩小。64 KiB 页下额外的对齐高度也留在安全区之外。

这两种模式都保持原有物理摄像头尺寸和 NV12 页对齐，不改变 QQ 的摄像头方向或协商分辨率。`screen` 渠道始终沿用 `full`，不受相机布局影响。2026-10-06 的普通私聊视频实测中，接收方确认 `portrait-safe` 的完整测试画面与运动均可见；同日群视频已确认原有 `full` 画面完整。不同客户端仍可能采用不同显示裁剪方式，因此安全区是内容排版选择，不是对远端界面的控制。

虚拟相机 worker 按固定帧率持续输出（`FrameOutputs` 为 15 fps）；没有新帧时重复最后一帧，新输入到达后替换它。只有实际提交的新输入帧产生一次对应序号的 ACK，重复帧不会制造额外回执或增加已确认帧数。消费插件停止写入后仍可能看到最后一帧，必须调用公共 `stopVideo()` 结束该渠道。

停止顺序必须保持为：关闭应用层新帧入口 → 停止 QQ 视频发布及摄像头采集，等待命令 **49** 回执 → 停止虚拟相机 worker。已审计的 Linux QQ 捕获线程使用无超时 `poll()`；49 会先等待线程退出，再执行 `STREAMOFF`/关闭设备。若提前停止生产者，采集线程可能没有新帧唤醒，导致原生 join 卡住。因此等待 49 时必须保留 worker 的最后帧心跳，不能用先停 worker 的方式清理。公共 provider 已负责这个顺序；消费插件使用 [视频消费示例](../examples/video-consumer.ts) 的停止与释放接口即可。

## QQ 原生上传证据与限制

官方 Linux ARM64 QQ `3.2.34-53644` 的 `libAVSDKPlugin.so`，SHA-256 为 `07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c`。静态符号和反汇编确认 `QRTCServiceInterfaceWrapper::VideoInData(unsigned int)`（命令 32，地址 `0x4e6f80`）长度仅 4 字节，正文为 `d65f03c0 ret`。内部 `QRTCService::VideoInData(...)` 有实现，但该 PPAPI 命令没有转发它，不能据名字声称 raw video 已送入 QQ。

原生命令 47 为 `StartCameraCapture(camera_name, is_id, support_vcam)`；命令 48 开始本地相机传输。在这个精确版本中，没有 cameraCore 时 48 返回 `-1`，其日志中“Using default camera”不代表真的回退采集。真正的切源风险是 47 在已有 cameraCore 时直接成功而不重选名称，因此应先以命令 49 释放旧源，再明确选择新设备并核实打开结果；仅命令投递成功不足以允许传输。Windows/macOS 的 ABI 与本地视频上行仍需各平台实测，不以 Linux 静态证据宣称已通过。

当前已完成离线生成、帧协议、队列、进程取消及 fake-camera 测试，以及上述明确授权的本地虚拟相机合成输出测试；QQ 视频端到端结果由实际通话验收单独记录。
