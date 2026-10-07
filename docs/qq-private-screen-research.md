# QQ 私聊视频与屏幕共享：协议研究记录

本记录区分协议证据与实际验收。依据为腾讯官方 Linux QQ `3.2.34-53644` 的 GUI bytecode 与 AVSDK 静态反汇编，各架构证据在下文分别标明；静态研究过程没有发起或变更通话。Linux ARM64 群通话、普通私聊视频与私聊屏幕共享的逐项真实结果见[测试记录](testing.md#历史记录与当前边界)，不能将其中已通过的画面验证扩展为所有生命周期或其他架构均已验收。

## 结论

普通私聊 `SceneFriend=1` 使用 DAV 路径；私聊屏幕共享使用 `SceneFriendShare=2`。官方 GUI 将两者之间的切换实现为带特定原因的新邀请与旧会话退出，不能在现有 scene 1 上直接调用屏幕发送命令 35/36 替代。

摄像头视频与屏幕共享不同：DAV 的 `NtrtcVideoCallbackImpl::OnDecFrame` 会产生 camera sourceType=1 的 QRTCVideoFrame；原始摄像头输入可走 `NtrtcVideo.InputVideoData`。所以 scene 1 的摄像头路径不应套用 MAV-only 的远端视频订阅命令 33。

## 官方 GUI 转换链

1. `isC2cTransformToScreenShare`（GUI object 14824）先调用 `qrtc.checkPeerC2CToDoubleMeetingEnable(peerUid)`，对应原生命令 43。返回 false 时退出；成功后打开来源选择器，携带 `inviteOriginal=P2PShareScreen=5`。
2. `AvPage.handleOpenParams`（object 19574，bytecode `0x0303..0x0335`）在 `transform` 分支执行 `callStore.startCall({ inviteOriginal, inviteReason: QRTCRecvInviteReasonDoubleNormalToDoubleMeeting })`。这个 inviteReason 的官方枚举值为 3。
3. `getsceneinfo`（object 4465）在非群聊且 `type === 'screenShare'` 时选择 `SceneFriendShare=2`；普通非群聊选择 `SceneFriend=1`。
4. `startC2CCall`（object 11710）在屏幕共享分支设置 `closeC2CCall=true`、保存 `inviteUid`、启动 15 秒超时，再调用 `qrtc.startCall(getStartCallParams(...))`。
5. 对端 `isC2CTransformToScreenShare`（object 12856）要求收到的 `inviteOriginal===5`、`recvInviteReason===3`、`scene===2` 同时成立。`onReceiveInvite`（object 12743）才进入转换处理。
6. 对端 `transformToScreenShare`（object 12886）保存旧摄像头与麦克风状态，`await callStore.quit()`，随后初始化新邀请、设置 connecting、`await callStore.accept()`，再恢复原本的摄像头/麦克风状态。
7. 屏幕共享可用性响应（object 11136）要求 result 为 0，才调用 `qrtc.startScreenShare()`；失败会取消转换标记并进入错误处理。

实现时需要明确会话转换授权，等待新邀请和连接结果，处理拒绝、超时、旧会话清理及所有权变化。不能只更改本地 scene 数字后把旧通话标为已升级，也不能照搬官方 GUI 自动恢复物理设备的行为；插件的摄像头与音频必须继续绑定消费方明确选择的来源。

### 通话中开启屏幕共享

补充追踪找到了发送端关闭旧 DAV 的确切步骤：object 19574 的 `0x0223`
等待 `handleGroupSwitchToScreenShare`。该函数的 SFI 19546 指向 object 19538；
其无 groupCode 分支在 `0x0060` 调用
`callStore.quit({ closeReason: QRTCSelfCloseReasonSwitchMeeting })`，随后
`0x008c..0x009d` 等待 2000 毫秒。枚举 object 2913 的 `0x0040..0x0043`
确定该 self close reason 为 **8**，因此是命令 10 `[1, peerUid, 8]`，
然后才发送 scene 2、original 5、reason 3 的转换邀请。

接收端 edge handler object 12292 在 `OnChatClosed` reason **29** 时记录
`isClosedBySwitchToMeeting`，退出旧传输，等待最长 5 秒的新邀请；reason 29
来自 converter object 2433 的 `0x0178..0x017b`。object 12743 只在这一标记
已成立时自动接听转换邀请。发送端 object 11719 的 15 秒超时针对被邀请者未加入；
object 11250 收到该 UID 入房后才清除标记。`closeC2CCall` 本身是超时标记，
不能误当成一个隐含的本地关闭动作。

当前实现对已审计的 Linux ARM64 构建开放这一流程：连接中的 scene 1 调用
`POST /v1/video/send`，明确选择 `kind: "screen"` 与来源后进行转换。
先验证来源和原生服务，再停止旧视频、提交官方转换协议。逻辑 `callId` 和消费方
所有权保持不变；`call.mediaTransition` 和视频状态明确展示转换阶段。
原生音频约有 2 秒以上的中断，不宣称无缝切换。新 MAV 本端连接、目标 UID 入房
以及指定来源发布均确认后，发送请求才成功返回；旧摄像头只恢复此前明确选择且
正在发送的来源，不选择默认物理摄像头。转换等待期间不接受 PCM 写入。

`POST /v1/video/cancel` 使用 `{callId, requestId, targetRequestId}` 取消指定发送请求
尚未完成的转换；迟到的取消不能作用于后续转换。此接口供消费者
退出及停止按钮绕过长发送队列使用；没有转换时它不会停止已在工作的摄像头或屏幕。
取消早于对应发送到达时，仍为当前通话保留有界的请求取消记录，防止迟到发送重新开启
转换；不会因淘汰取消记录而复活请求。失败或取消状态中的 `audioReady` 只在未关闭旧
DAV，或已确认新 MAV 与对端均连接时为 true，供上层恢复语音而不是按状态名猜测。
正常挂断、远端关闭或 Host 代际变化同样取消延迟邀请。未知提交不重复；跨过关闭边界
后协商失败会保留需清理的状态，不假称原 DAV 已恢复。如果新 MAV 已确实连接而只是
视频发布失败，则保留语音通话。端到端等待预算为 40 秒，外层发送 RPC 为 45 秒。

ARM64 的 `DavClose` @ `0x6af5a0` 原样传入关闭原因；Ntrtc 异步 Close 的 reason 8
分支 @ `0x9818b4` 使用内部 reason 26 并停止旧视频聊天。`OnCloseSession`
@ `0x6b12e0..0x6b1454` 不转发 reason 26；接收端的 reason 29 不能据此推成发送端
同样会收到的回调。实现不吞掉任意 `20022`，真正关闭会中止转换。
静态协议与离线状态机回归不代替真实热切换验收；未审计构建仍不能直接在 DAV 调用 35。

## 原生侧证据

- `QRTCService::StartShareSend` @ `0x6957e8` 和 `StopShareSend` @ `0x6958e4` 仅在 scene 2–7 且存在 engine 时继续；否则返回 false。
- `MAVEngineImpl::StartShareSend` @ `0x71bd38` / `StopShareSend` @ `0x71bd8c` 向工作线程 Post 后返回 true。原生命令 35/36 的回执 1 只表示本地请求已提交，不是远端画面开始或停止的证明。
- `NtrtcVideoCallbackImpl::OnDecFrame` @ `0x6b037c` 设置 camera sourceType=1，向 observer vtable+232 发送帧；对应 wrapper `OnRecvVideoFrame`。
- `QRTCService::VideoInData` @ `0x6950f8` 的私聊分支 @ `0x69522c` 调用 Ntrtc 视频输入；但 PPAPI 命令 32 的 wrapper @ `0x4e6f80` 仅有 `ret`，不能用它注入帧。

上述地址仅适用 SHA-256 为 `07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c` 的官方 ARM64 `libAVSDKPlugin.so`。

## 显式新建私聊屏幕共享

控制接口 `POST /v1/control/dial` 支持 `media: "audio" | "video" | "screen"`，省略时保持普通语音。`video` 是普通私聊 DAV 视频邀请，`screen` 是一通新的私聊 MAV 屏幕共享会话；存在其他活动通话时拒绝请求，不自动挂断、升级或重拨。**邀请类型不会自动选择或开启摄像头、桌面来源。** 音频继续使用预先明确配置的路由；发送画面仍须通过视频接口明确选择来源，发出视频邀请也不表示已经发出视频帧。

新建邀请参数为 `scene_id=2`、`sub_business_type=3`、`invite_original=5`、`invite_reason=0`，且只邀请解析出的目标 UID。依据：GUI object 11851 在 ScreenShare 分支取 `uQ.Share` 和 `P2PShareScreen`；`gui-business-enum.txt` object 246 的 `0x0026..0x0029` 定义 Share=3。`gui-startcall-json-converter.txt` 的 `0x002d..0x0041` 在未传 inviteReason 时取 Normal=0；它不会自行添加转换原因 3。

拨号前原生命令 43 接收 `[peerUid]`。ARM64 wrapper `0x4ef184` 的同步回执为命令 43、原请求 ID、`[boolInt, ""]`；这里 **1 表示支持，0 表示不支持**，不能套用其他命令的 ret=0 成功规则。控制层等待匹配请求的真实回执，超时、格式错误或进程变化均不发出拨号命令；异步检查期间出现的其他来电也不会被取代。

尽管官方方法名带有 Peer，ARM64 service @ `0x696d1c` 实际检查本地 `this+144`
服务指针是否存在，没有向 peerUid 发起远端能力协商。返回 1 只证明本地转换入口
可用，对方是否支持、接受或加入必须由后续真实结果判断。

Linux x64 同版本命令 43 另行核验：wrapper `0x55d3c0`，`0x55d3f9` 保存原请求 ID，`0x55d481` 将 bool 转为 int，`0x55d511..0x55d559` 构造 boolInt 和空字符串，`0x55d5c8..0x55d5d1` 以命令 43 和原请求 ID 返回。对应 SHA-256 为 `c143c4e8ac94c20bcefb037e7062fbeccd0528bd746108d6bf1f0ae8e1710a8b`；这项静态核验允许该构建启用能力检查，并不等于 x64 已完成通话验收。

Scene 2 仍以 private 暴露，保留 scene 2 的会话和成员关联；官方 GUI object 11801 的 `isScreenShare` 分支使用 `quit({ sceneId, reason: QRTCQuitReasonNone })`，所以挂断使用命令 8 `[2, 0]`，而普通 Scene 1 使用命令 10 Close。退出回执只表示受理；结束由生命周期事件或下述独立本端空闲查询确认。`private.screenDial` 仅在具有对应原生审计证据的构建启用；静态能力门控不表示真实通话验收。

### 普通私聊视频邀请

`video` 使用 `scene_id=1`、`sub_business_type=2`、`invite_original=0`、`invite_reason=0`。`relation_id` 是已核验的对端 QQ 号，`invite_uids` 是该号码对应的唯一 UID，`invite_count=1`；其余字段沿用普通私聊。它不使用 `AudioVideo=4`，不需要屏幕共享命令 43 的检查，也不切换到 scene 2。

证据链：GUI `getStartCallParams` object 11851 的 `0x0043..0x0059` 在 Video 分支选择 `uQ.Video`，枚举 object 246 的 `0x0019..0x001c` 明确 `Video=2`；非群默认 `inviteOriginal=Normal=0`，只有 ScreenShare 分支才改为 `P2PShareScreen=5`。object 4465 的 `0x0055..0x0077` 为普通私聊选择 SceneFriend，并从 `peerMember.uin` 取 relationId。JSON converter object 2665 在没有额外转换原因时填 Normal=0。

官方 `startC2CCall` object 11710 先调用 `qrtc.startCall(getStartCallParams(...))`（`0x00e3..0x0103`），随后在视频分支调用 `videoStore.openCamera`（`0x0141..0x015a`）；后者 object 5696 执行摄像头捕获 47、帧转送 48，并在 isC2C 分支直接调用发布 30。插件仍要求消费方明确指定来源，可以在连接建立后才开启摄像头。

同一个 `openCamera` 在 `0x0143..0x0174` 明确处理原类型为 audio 的情况，调用
`avStore.switchType(Video)`；object 5156 的这个方法只更新类型、窗口和布局，
`setAVType` object 4789 的 8 字节正文只有属性赋值。它不额外调用原生
`SwitchToVideoMode`，所以连接中的普通私聊语音同样使用 47/48/30 开启摄像头。
此静态路径不能替代语音起呼后热开摄像头的实际画面验收。

DAV 的命令 30/31 正常回执是单元素 `[0]`，表示本地任务已提交，与 MAV 的 `[1]` 不同。DAV 不等待 MAV 的 20026/20027 发布结果。捕获 47 的首次 `Start camera capture success!` 只表示排队，必须再等相关的实际 DeviceOpen 回执；只有捕获、转送和发布请求成功，仍不能替代对端收到画面的证据。接收采用 DAV 自身的 camera sourceType=1，布局使用 54，不能调用 MAV-only 的 33/34。详见[摄像头捕获研究](qq-camera-capture-research.md)。

DAV 不一定提供群房间式成员名单。控制层只在 scene 1 进入 connected 后，将已核验的拨号目标或原生来电 UID 一次性加入参与者，标注 `membershipSource=direct-peer` 与实际身份来源，保持 `participantsKnown=false`。明确离开事件或后续有效空名单仍会撤销它；视频事件不能自行添加未知成员。Host 只为当前会话已授权的对端保留提前到达的解码元数据，等订阅后才捕获像素。20031 与 20049 分别记录首帧通知和解码帧尺寸变化证据；20049 不能冒充首帧通知，清理会话后不继承旧证据。

## 原生渲染缓存与跨通话首帧

2026-10-06 从普通私聊 DAV 切到私聊屏幕共享 scene 2 后，远端已开启相机，Host 收到
`20025 available=true` 与 `20049 [uid,1,270,480]`，却没有新的 20031，导致只认
20031 的接收端一直返回零帧。

ARM64 精确 SDK 的 `GLRender::UpdateCallBack`（`0x4c2e88`）使用 `%s@%d`
组成 **UID + sourceType** 的纹理缓存键，键里没有 callId 或 scene。`0x4c3234`
读取缓存中的旧宽度；只有旧宽度为零时，`0x4c32ac` 才调用
`NotifyFirstFrame` 发出 20031。它不是“每次通话的第一帧”保证。

20049 的唯一原生调用点是同一 `UpdateCallBack` 的 `0x4c32c8`：真实帧的宽高或
角度变化后调用 `NotifySizeChange`（`0x4bfe34`）。此路径由
`OnRecvVideoFrame` 在 `OutputNormal/OutputGpu` 成功后送入 GLRender；它不是
群成员宣告的分辨率。20031 与 20049 都先通知，再创建/更新纹理。因此二者都必须
结合当前会话成员授权、当前订阅和随后的渲染截图，不能只凭通知声称已取得 JPEG。

Host 保留 `firstFrameAt` 专门表示 20031，以 `decodedFrameAt` 表示当前会话中
任一种解码回调。通过 20049 开始接收时，帧证据明确为
`native-decoded-size-change-and-render-capture`；20031 则沿用
`native-first-frame-and-render-capture`。仅有 20025 可用状态仍不能开始截帧。

更关键的是清理缓存：命令 34 仅停止 MAV 订阅，不能删除上述 GL 缓存。同一对端、
相同尺寸的下一次通话甚至可能没有 20049。现清理会话或移除最后订阅时发送命令 54
的空布局 `[0,[],[],[],640,640,100]`。已审计的 `GLRender::MoveRect`
（`0x4c14ec`）会删除不在新布局内的 TexInfo 与哈希项（`0x4c19c8..0x4c1a58`），
让下一次订阅重新等待新的解码证据。每次取消订阅同时清除应用层旧图像和解码证据；
旧截图异步完成时仍受会话 generation 与布局版本约束。`DeleteAllTextures` 只删除
GL 对象而保留尺寸，不能代替空布局。

### 接听参数和房间身份修正

官方 converter objects 1339/1348 将接听转换为 `[scene, selfUid, inviteUids, subBusinessType, relationId, useNtrtcDsp, ntrtcAIDenoiseUpdateModel]`。GUI object 12785 `0x0061..0x0095` 在分支之前统一取原邀请的 scene、subBusinessType、relationId 和 `[inviter]`。Scene 1 和 Scene 2 共用这个接听转换；没有将 callerUid 作为 selfUid 的特殊分支。

原代码沿用参考实现，将第二项传成了 inviter。修正后从已登录账号读取 selfUid，而邀请列表仍是 `[inviter]`。x64 native Accept `0x54c3d7` 保存数组第二项，`0x54c536..0x54c59a` 将它写到 QRTCParams 首字段；service `0x786a05..0x786a1f` 将此字段保存为自身 UID。数组第五项 relationId 另行解析为 uint64，位于 params+0x38；MAV Accept 的 `0x786a97..0x786aae` 分支使用它，所以该值必须来自原邀请，不能用 callerUin 替换。

ARM64 也独立确认了相同参数布局：`0x4df9c0` 保存 x3（数组第二项），`0x4dfacc` 开始构造该字符串，`0x4dfb20` 写 QRTCParams 首字段；inviteUids 写 params+0x18，relationId 在 `0x4dfb4c` 转为 uint64、`0x4dfb64` 写 params+0x38。静态输出保存在 `/tmp/qq-native-accept-arm64.asm`。

控制层同步修正了来电 `nativeRoom`：使用原邀请的 scene 和 relationId，后续 UID→UIN 查询只补充人物身份。测试特意让邀请 relationId 等于本账号 QQ 号、callerUin 为另一个 QQ 号，以确认身份解析不会覆盖房间关联。接听请求校验 relationId 的 uint64 格式，避免原生数值转换收到任意文本。

## 可复查材料

本机 `/tmp/qq-avsdk-static-nuqq4iv7/` 中保存原始 `cache-objects-gui.json`、`disassemble-cache.py`、`gui-sceneinfo-decoded.txt`、`gui-startc2c-decoded.txt`、`gui-invitereason-enum.txt` 和 `gui-inviteoriginal-enum.txt`。本次额外解码输出为 `/tmp/rtc-private-screen-{14824,19574,12886,12743,12785,11136,11250}.txt`；可按文中 object ID 重新生成。Windows/macOS 未据此声明验收成功。

新增复核材料：`/tmp/rtc-private-screen-accept1348.txt`、`/tmp/rtc-private-screen-accept11748.txt`、`/tmp/qq-x64-static-ao0otabi/video-cmd43-peer-enable.asm`、`/tmp/qq-x64-static-ao0otabi/native-accept-review.asm`。

## 主动结束的本端空闲确认

Scene 1 主动挂断提交 Close 10 `[1, peerUid, 0]`；Scene 2 提交 Quit 8 `[2, 0]`。两者的控制回执与通话最终状态分开：`receipt.status=confirmed`、`nativeResult=0` 只确认该原生命令被受理，不能单独将通话变成 `ended`。本轮实测曾出现对端已确认挂断、控制层仍等待 20022 的情况；以下修复的离线验证不替代重新进行真实关闭验收。

ARM64 Close 的实际调用链为 wrapper `0x4e0d1c` → `QRTCService::Close` `0x692ecc` → `DavClose` `0x6af5a0` → `NtrtcSessionImpl::Close` `0x97fe48`。后者在 `0x97ff80` 向 thread 101 调用 `NTThreadMgr::PostTask`，随后在 `0x980070` 返回 0；所以命令 10 的 ACK 发生时，异步关闭任务不保证已执行。任务入口 `0x981644` 才会调用 `SharpAV::stopVideoChat` `0x8ab838`，经 `clearIO` `0x89cf80` 删除本端 session。

不能假设每次本端 CloseReasonDefault=0 都会收到 20022。`NtrtcSessionCallbackImpl::OnCloseSession` 的 `0x6b12e0..0x6b1454` 只将部分 reason 转给 `OnChatClosed`，当收到 reason 0 时直接返回，不发送该回调。此处证明存在没有 20022 的结束路径，不表示所有 reason 0 的运行情况都已实测。20013 的 wrapper `0x4c8db8` 明确为 `OnOtherTerminalChatChange(uint64 roomId, state, uid)`，其三字段是房间号字符串、状态整数、UID 字符串；不能将它当作本端结束。GUI groupstate object 469 对 `RoomDestroy=14`、`destroyReason=1` 还检查 `peerUid` 和保存的 `roomId`，清理的是 `callData`；一般 S2C 通知或字段形状不构成当前通话的结束证据。

独立只读命令 **GetChattingRoomId 14** 不带参数，使用原请求 ID 返回三元素数组。ARM64 与 x64 的官方完整库分别审计如下：

| 固定构建 | wrapper / service 地址 | 返回布局与边界 |
| --- | --- | --- |
| Linux ARM64 `3.2.34-53644` | `0x4e1938` / `0x692f88` | `[0, "", roomId十进制字符串]`；service 不存在为 `[0, "", ""]`；scene 0 为 `[0, "", "0"]`。 |
| Linux x64 `3.2.34-53644` | `0x54e6f0` / `0x786ea0` | 相同布局；`0x54ea2e..0x54ea36` 以命令 14 和原请求 ID 返回；空 service 分支 `0x54eaa5`，scene 0 分支 `0x54ec3f`、字符串 `"0"` 构造于 `0x54ed07`。 |

对应库指纹为本文前述 ARM64 / x64 SHA-256。ARM64 service 根据 scene 选择 DAV 当前 peer 的房间或 MAV 当前房间；因此 Scene 1、Scene 2 及群 Scene 3 都可以查询，但其他平台未据此开启 `roomIdleQuery`。x64 反汇编材料为 `/tmp/qq-x64-static-ao0otabi/command14-roomid.asm`。

控制层在相关 Close 10 / Quit 8 成功 ACK 后查询；已经确认接通过的通话，即使关闭 ACK 超时或提交回执丢失，也会执行这项核验。未确认建立的通话不能把初始空闲房间当作关闭完成。最多查询 6 次，每次等待 2 秒，重查间隔 250 ms；迟到 ACK 不重置当前预算。重复的是只读命令 14，绝不自动重复 Close、Quit 或拨号。只有当前查询返回严格的 `[0, "", "0"]` 才将通话置为 `ended`，记录 `nativeEndEvent=native.roomIdle`、`nativeCloseCheck` 和 **`remoteEndedConfirmed=false`**：这证明本端 SDK 已无当前房间，允许释放本地通话资源；不表示已经验证对方界面、网络通知或音视频播放均已停止，也不表示对方仍然在通话。

非零 uint64 房间保持 `ending`；空字符串、格式错误、超时或传输失败都不能当作 0。预算用完后设置 `nativeTeardownUnknown=true` 和可读的 `nativeError`，保留明确操作清理的路径。原有原生结束事件、群成员离房确认仍然有效，不强制等待查询完成。

每轮查询绑定 `requestId`、`callId`、本次关闭请求 ID、登录 generation 和已观察的 Host boot ID。原生结束、Host 重启、controller 停止或新的显式关闭都会取消旧计时器；超时后旧查询的 `"0"` 结果与旧 HTTP 失败不会作用于新一轮查询。离线回归还覆盖原生结果先到、HTTP 提交回执后到的顺序。当前代码通过这些协议测试，实际两端关闭结果仍按[测试记录](testing.md)逐项登记。
