# QQ 摄像头采集与发布协议取证

以下结论来自 QQ Linux 3.2.34-53644 的官方 GUI 字节码和本地原生库静态检查。
ARM64 `libAVSDKPlugin.so` 的 SHA-256 为
`07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c`。
命令参数与地址也记录在 `bridge/qq/video-native-evidence.json`；x64 的独立取证在
`bridge/qq/video-linux-x64-evidence.json`。这些静态结论不代替远端真实画面验收。

## 摄像头存在三个独立阶段

1. `47 StartCameraCapture([deviceId, true, true])` 请求打开摄像头。
2. `48 StartTransformLocalCameraData([])` 允许 CameraCore 输出采集数据。
3. `30 GoOnStage([])` 开启会话中的摄像头发布。

只有前两步时，远端可能仍显示“未开启摄像头”。发布成功后，如果采集没有实际产生帧，
远端仍可能一直加载。摄像头开启通知、写入虚拟设备成功、对端收到画面是三个不同的事实。

官方 GUI 的 `VideoStore.openCamera`（字节码 5696）先执行 47、48，再通过
`handleGoOnStage`（5708）调用 `goOnStage`（5870）。其中本地
`changeMyCameraStatus` 仅修改界面状态，不能代替命令 30。`NotifyPeerChatStates`
用于终端切换恢复，不能作为普通摄像头开启通知使用。

停止时需要分别执行 `31 GoOffStage([])` 停止发布和 `49 StopCameraCapture([])`
释放采集。不能省略 49：已有 CameraCore 时，47 会沿用原设备而忽略新设备 ID。
49 返回 `[-1, "No Existing Camera capture"]` 的精确分支表示已经没有采集对象，
可以视为幂等清理完成；不能把所有负返回值都当成功。

## 47 有两次回执

ARM64 `StartCameraCapture`（`0x4ea068`）会首先返回：

```json
[0, "Start camera capture success!"]
```

这只表示异步任务已提交。`DeviceOpen` 的主线程回调（`0x4fa72c`）随后再次使用
命令 47 和保存的请求 ID 返回：

```json
[0, ""]
```

或：

```json
[-1, "OpenCamera fail"]
```

因此请求管理器不能在第一条排队回执到达时销毁待处理请求。最终成功仍不等于视频帧
已交付到远端。设备成功打开时的原生日志为
`avsdk output(wrapper): camera DeviceOpen success`。

## 发布回执与异步结果不能混淆

30、31 的同步回执只有一个整数，没有第二个错误字符串。MAV 场景 2–7 中，
`[1]` 表示已接受，`[0]` 表示拒绝；30 最终调用 `StartVideoSend`，31 调用
`StopVideoSend`。ARM64 对应 `0x71bc60`、`0x71bccc`，x64 对应 `0x8136b0`、
`0x813710`。

普通私聊 DAV 场景 1 的返回约定相反：`[0]` 表示底层任务正常入队。该路径调用
`NtrtcVideoImpl::Start/Stop`，正常返回 0，未初始化返回 -6，服务层却把 `ret != 0`
转换为布尔值。因此场景 1 不能照搬 MAV 的 `[1]` 成功判定，也不能等待 MAV 的
20026/20027：官方 converter 749/775 在 `isC2C` 时直接等待 30/31 同步回执，
仅在其他场景先订阅 20026/20027。两种场景的回执均不是远端画面交付证明。

30 的异步结果是 `20026 OnGoOnStageResult([state])`。官方枚举为：

| 值 | 名称 |
| --- | --- |
| 1 | ForBid |
| 2 | EnterAudio |
| 3 | SitSuccess |
| 4 | SitFail |
| 5 | ExitSuccess |
| 7 | VisitorFail |
| 8 | MeetingControl |
| 9 | SingleMic0ff |

官方 GUI 5870 实际将 `3`、`0`、`1` 都作为兼容成功结果，其余结果进入失败处理，
5708 会停止采集。这里只记录官方行为，不把 `ACK [1]` 与异步状态 `1` 混为一谈。

摄像头丢失通过 `20053` 通知，`id=0`、`value=[]`。原生 `DeviceLost` 回调先停止
采集再发送此通知；桥接层应结束当前摄像头输出状态，而不是继续统计帧已提交。

## Linux 设备诊断

`broadcast-core.so` 中的 `CameraCapture_CaptureCamera` 直接使用 V4L2，
不需要独立摄像头 helper 进程。`is_id=true` 匹配 `VIDIOC_QUERYCAP.bus_info`，
`false` 匹配 `card`，不是文件路径。原生枚举找不到指定 ID 时可能回退到首个设备，
所以桥接层必须先确认指定 ID 仍在实际枚举结果中。

静态检查确认支持 `YUYV`、`NV12`、`NV21`、`YU12`、`YV12`。
`V4l2_GetMaxSize` 同时要求可枚举帧尺寸与对应的帧间隔；仅有像素格式不够。
实际采集经过打开设备、`VIDIOC_S_FMT`、`VIDIOC_REQBUFS`、`mmap`、`VIDIOC_QBUF`、
`VIDIOC_S_PARM`、`VIDIOC_STREAMON`。中途失败会关闭设备，因此没有持续 reader
并不说明从未尝试打开，应结合第二次 47 回执和具体系统调用错误定位。

CameraCore 的帧入口是 `DataCallBack`（`0x4bbad4`）。另一个
`OnVideoFrameOut`（`0x509864`）属于媒体播放器接口，不能直接当成摄像头首帧证据。

## 53644 Linux 包的 I420 shader 缺失

2026-10-06 的真实测试中，设备已成功完成 buffer 映射、帧率设置和 `STREAMON`，
日志到达 `CameraCapture.c(340) select fmt type: 4` 后，第二次 47 返回
`OpenCamera fail`。

静态检查确认 `type=4` 对应 `YU12/I420`。随后 `CameraCapture_CaptureCamera`
（`0x5859c`）会加载 `VertexShader.glsl` 与 `I420toRGB_ps.glsl`。但原始 Linux
ARM64 53644 安装包只有 `I420toRGB_r8_ps.glsl`，缺少前者所要求的普通
`I420toRGB_ps.glsl`。`GL_InitShader`（`0x5a198`）直接打开 DLL 目录下的
`Shader/<filename>`；`fopen` 失败后返回 `0x80070057`，没有 `_r8` 回退，也不打印
专门的文件读取失败日志。

因此这类故障不能用“47 首次 ACK 成功”掩盖，也不能归因于视频写入接口。
可优先让虚拟摄像头提供安装包已有 shader 的格式（例如 `NV12` 或 `YUYV`），
然后重新验收异步设备打开和远端实际画面。不能仅重命名 `_r8` shader，两个路径的
纹理布局是否相同必须另外验证。

## NV12 页尾填充被误判为每行填充

另一个原生兼容问题位于 `CameraCapture_ThreadProc`（`0x5874c..0x58888`）：
NV12/NV21 的 `VIDIOC_QUERYBUF.length` 大于有效画面字节数时，代码用整个映射
buffer 长度反推每行跨度，没有使用驱动提供的 `bytesperline`，也没有区分页尾填充。

例如 640×360 的紧凑 NV12 数据为 345600 字节，4096 字节页对齐后映射长度为
348160 字节。QQ 反推 `348160 * 2 / (360 * 3) = 644`，把每行错误地按 644
字节递进，再复制其中 640 字节；亮度逐行斜切，后面的 UV 平面也错位。这与
驱动返回 `bytesperline=640` 完全不符。

不修改 QQ 原生库的规避办法是选择有效 NV12 字节数本身已按系统页大小对齐的
虚拟设备尺寸，让该错误分支不触发。4096 字节页下，512×288、1024×576 均保持
16:9 并满足要求；640×384 也可使用，但原画面需等比留边。输出分辨率应由虚拟
设备层确定，上游 JPEG 的尺寸与比例不应受这个 QQ 兼容限制影响。

## 停止采集时仍须保持生产者送帧

53644 的 `CameraCapture_ThreadProc` 在 `0x586dc` 检查运行标志，随后以
`poll(fd, 1, -1)` 无限等待下一帧。`GraphicsCapture_Release` 在 `0x3a9fc`
只将运行标志清零，接着直接调用 `XWaitThread`，最终进入 `pthread_join`
（`0x4c418`），没有主动唤醒设备的 poll。

更关键的是，`CameraCapture_Release` 要等这个 join 返回后，才在 `0x5802c`
执行 `VIDIOC_STREAMOFF`、`0x58034` 关闭设备。因此先停止虚拟摄像头生产者，
或生产者只在收到新图片时写一次，都可能使命令 49 卡在等待下一帧的位置。

虚拟摄像头应按配置帧率持续输出最近一帧，直到停止采集的 49 最终回执到达，
再关闭生产者。定时重复输出不代表上游又提交了一幅新画面，不应重复发送公共
`writeVideo` 提交回执或推进输入 sequence。停止超时则应保留“结果未知”的状态，
不能宣称摄像头已关闭。
