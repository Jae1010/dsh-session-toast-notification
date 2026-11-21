# 会话事件弹窗提醒

[简体中文](README.md) · [English](README_en.md)

[![npm version](https://img.shields.io/npm/v/session-toast-notification)](https://www.npmjs.com/package/session-toast-notification)
[![GitHub stars](https://img.shields.io/github/stars/Jae1010/dsh-session-toast-notification?style=social)](https://github.com/Jae1010/dsh-session-toast-notification)
[![license](https://img.shields.io/npm/l/session-toast-notification)](LICENSE)

**给 [DeepSeek Harness](https://www.deepseek.com/harness/) 用的会话通知插件：跑完一轮、中途提问、等待授权时弹系统通知，并且能直接在通知上答题、审批、跳回会话。**

会话跑完一轮、或者中途停下来等你回答时，在系统通知中心弹一条通知，告诉你「哪个会话在等你」。Windows 走通知中心，macOS 走页面里的系统通知（**macOS 目前是 beta 版，功能可能不正常**）。

同时开多个会话（多个任务并行）时，通知里带会话标题、工作目录、耗时和内容摘要，一眼就能分辨是哪一条。点一下通知直接跳回那个会话。

## 安装 / 更新

要求 DSH 0.2.2-rc.5 及以上（`package.json` 的 `engines.dsh` 会在安装时校验）；Windows 10/11 功能完整，macOS 为 beta（见下面「macOS」一节）。

### 在 DSH 里装

**插件 → 添加插件（Add plugin）**，搜 `session-toast-notification`，点安装。装完刷新一次页面（Ctrl+R），插件页的开关和提示音下拉才会出现。

### 用 dsh CLI 装

```sh
dsh plugin --profile web add session-toast-notification
```

更新：

```sh
dsh plugin --profile web update session-toast-notification@latest
```

### 从源码链接（开发用）

把仓库目录链接进 profile（`plugin_manager` 的 `install_bundle`，或 `dsh plugin --profile <profile> add <本地目录>`）。宿主半（`index.js`）改完要重新启用插件，页面半（`client.js`）改完刷新页面即可。

### 从插件市场的索引源装

插件 → 发现（Discover）→ 索引源，加上下面任意一个地址，再搜 `session-toast-notification` 安装：

```
https://cdn.jsdelivr.net/gh/Jae1010/dsh-session-toast-notification@main/market/index-git.json   # 从 GitHub 源码装，不依赖 npm
https://cdn.jsdelivr.net/gh/Jae1010/dsh-session-toast-notification@main/market/index.json       # 从 npm 装（包发布后可用）
```

（jsDelivr 打不开时可以换成 `https://raw.githubusercontent.com/Jae1010/dsh-session-toast-notification/main/market/index-git.json`。）

## 通知长什么样

一轮结束：

```
✅ 会话完成 · 弹窗提醒插件开发
耗时 4 分 12 秒 · 目录 dsh\弹窗提醒
插件已经装好并验证通过，弹窗会带上会话标题、耗时和目录……
```

中途提问：

```
❓ 需要回答 · 弹窗提醒插件开发
目录 dsh\弹窗提醒
细节 · 弹窗里要不要也显示 token 用量？
```

等待授权：

```
🔐 等待授权 · 弹窗提醒插件开发
目录 dsh\弹窗提醒
bash · 要删除构建产物目录
```

- 第一行：状态 + 会话标题（没有标题时退化为第一条提问的开头）
- 第二行：本轮耗时 + 工作目录末两级，用来区分同名的并发会话（提问类通知只有目录）
- 第三行：内容摘要——结束时是本轮最终回复的开头，提问时是问题本身，授权时是待批准的操作

状态标记：`✅ 会话完成`、`⏹ 会话已中止`、`⏸️ 会话已阻塞`、`❌ 会话出错`、`⚠️ 已到输出上限`、`🔌 会话被中断`、`🎯 目标完成`、`⛔ 目标受阻`、`❓ 需要回答`、`🔐 等待授权`。

## 行为

- 结束通知：`agent/status` 变为 `idle`，即一轮对话真正结束、等你下一条输入的时候
- 提问通知：读会话日志里的 `ask_user_question` 工具调用；授权通知：读审计事件 `approval/asked`。DSH 的 web 转发层会先接管这两个 waterfall 请求（转给页面等回答），所以插件不靠拦截请求来发现它们，只在这两个请求没被页面接管时才顺带挂住、给通知加按钮
- 标题优先用会话自动标题；标题还没生成时退化为第一条提问的开头
- 只统计真正跑过的轮次：没有观察到“开始运行”的会话不会弹结束通知
- 默认跳过子代理会话，避免一次多代理任务弹出一堆通知
- 点通知（点正文，不是侧边的小箭头）→ 拉起 DeepSeek Harness 窗口 → 页面切到该会话
- 你正看着某个会话（窗口在前台、该会话是当前显示的会话）时，它的结束 / 提问 / 授权通知不弹；其他会话照常弹。判断依据是页面自己上报的“当前会话 + 是否聚焦”，120 秒内有效
- 提问通知带选项按钮（单个问题时，按第一题的选项，最多 3 个），点一下等于在页面那张卡片里选了它，agent 立刻拿到答案，不用回到 DSH。**连问也能点**：一张卡片里有多个问题（1/3、2/3…）时，通知会一道一道问下来——点完第一道，紧接着弹第二道（标题带「第 2/3 题」），最后一道点完才把整组答案一起提交。只要有一道题需要打字，通知就只提醒，回答回会话里做
- 授权通知的按钮和卡片一致：卡片只有「允许一次 / 拒绝」，通知也只有这两个（DSH 里普通工具审批本来就没有会话级授权，通知不替你多造一个）。`approvalTimeoutMs`（默认 180 秒）内没点、或请求被取消，就交回 DSH 自己的授权界面，不会把 agent 卡住。点这些按钮不会把 DSH 窗口拉到前台
- goal 模式（自动连续多轮）只在最后一轮（目标完成 / 受阻）弹一次，中间每轮都弹就是刷屏
- 音量与静音时段按「完成 / 提问 / 授权」三类分别设置：音量 0 或落在静音时段内时，该通知只显示不发声
- 弹窗的同时闪烁任务栏图标（`flashTaskbar`，默认开）：用 `FlashWindowEx` 让任务栏按钮一直闪，切到窗口就停；窗口本来在前台时不闪，闪烁失败也不影响通知
- 通知归属 DeepSeek Harness：受系统免打扰（Windows 专注助手 / macOS 专注模式）和「按应用通知设置」控制；被系统静音时插件不会重试
- 同一会话的后续通知共用一个 Tag（会话 id 前 64 位），不会无限堆叠

## 在插件页面里设置

两个入口，改的是同一份设置：

- **插件页面**（本页）：设置 → 插件 → 找到「会话事件弹窗提醒」，描述下方就是完整的开关与说明
- **设置页面**：设置 → 左侧导航「弹窗提醒」（铃铛图标）——只有开关和提示音，方便平时调；想读说明就回插件页面

打开 设置 → 插件 → 找到「会话事件弹窗提醒」，页面上（描述下方）直接有开关，不用改配置文件：

| 开关 | 作用 |
| --- | --- |
| 会话完成时弹窗 | 关掉后一轮结束不再提醒 |
| 中途提问时弹窗 | agent 用 `ask_user_question` 问你时是否提醒 |
| 等待授权时弹窗 | 工具调用需要你批准时是否提醒 |
| 任务栏图标闪烁 | **仅 Windows**：弹窗同时让 DSH 的任务栏按钮闪烁，直到窗口切到前台；窗口本来就在前台时不闪。在 macOS 上这条开关是禁用状态 |
| 弹窗内回复 | 一个开关管「通知里能不能直接回」：开时提问正文和它的选项进通知、授权通知带「允许一次 / 拒绝」两个按钮（与卡片一致）；关掉后通知只提示，回会话里再回 |
| 点击通知返回该会话 | 关掉后通知只是提示，点了不跳转 |
| 正在看的会话不打扰 | 你正盯着某个会话时不弹它的通知；其他会话照弹 |
| goal 模式只提醒最后一轮 | 自动连续多轮时中间不弹，只在目标完成 / 受阻时弹一次 |
| 完成 / 提问 / 授权提示音 | 三个分别下拉选择，旁边「试听」立刻播放一次 |
| 音量 | 三类各自 0–100%，0 等于静音 |
| 静音时段 | 三类各一个开关：打开就用默认的 22:00 → 08:00，想换就改两个时间下拉（15 分钟一档）；关掉即不静音，跨午夜（起 > 止）也支持 |
| 自定义提示音 | 选一个 `.wav`/`.mp3` 并命名，它就会出现在上面三个下拉里（`自定义：<名字>`） |

面板里分三组：「通知」放弹不弹，「行为」放怎么回（弹窗内回复、点击跳转、前台不打扰、goal 抑制），「提示音」放三个提示音，下面再分「音量」和「静音时段」两块。

改动立即生效（下一轮、下一次提问就用新设置），不需要重启，也不需要刷新页面。选择保存在 `%DSH_HOME%\session-toast\settings.json`（默认 `D:\dsh\home\session-toast\settings.json`）；这里的值会覆盖 `cordis.patch.yml` 里的同名项，想彻底回到配置默认值就删掉这个文件。

## 提示音

下拉里的顺序是：3 个系统通知音 → `无声` → 8 个包内自带音效 → 你添加的自定义音。

| 下拉里的名字 | 配置文件里的值 | 来源 |
| --- | --- | --- |
| 默认 / 提醒 / 邮件 | `default` / `reminder` / `mail` | Windows 系统通知音（走通知 API 播放） |
| 无声 | `silent` | 不响 |
| 终端响铃 | `terminal-bell` | `sounds/terminal-bell.mp3`，Claude Code 那种终端 bell 的手感 |
| 编辑撤回 | `edits-undone` | `sounds/edits-undone.mp3` |
| ZCode 弹窗 | `zcode-pop` | `sounds/zcode-pop.mp3` |
| 苹果短信 | `apple-sms` | `sounds/apple-sms.mp3` |
| 苹果来信 | `apple-received` | `sounds/apple-received.mp3` |
| 苹果发送 | `apple-sent` | `sounds/apple-sent.mp3` |
| 成功 | `success` | `sounds/success.mp3` |
| 任务完成 | `task-completed` | `sounds/task-completed.mp3` |

自带音效是 mp3，用 Windows 的 MCI（`mciSendString`）播放，最长截到 6 秒；播放时通知本身是静音的，声音由文件提供，所以开「勿扰」时通知不弹、声音仍会响。

## 自定义提示音

系统只提供那几声通知音，桌面上的 `Codex`/`OpenCode`/`ZCode` 本体也不带音频（Claude Code 只有终端响铃，Codex 的 `turn-ended` 只发事件，OpenCode 没有声音代码），所以想要专属音效就自己加：

1. 准备一个 `.wav` 或 `.mp3`
2. 插件页面「自定义提示音」里点「选择文件」，选好后填个名字（比如 `Codex`），点「添加」
3. 上面三个下拉里就会出现「自定义：Codex」，选它即用；旁边「试听」可以先听

每条自定义提示音都能单独「试听」「删除」；最多 12 条。

## 配置

配置文件（`cordis.patch.yml`）里的项仍然有用，尤其是插件页面没暴露的几项：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `appId` | `com.deepseek.dsh` | 通知归属的 AppUserModelID，决定通知显示在哪个应用名下 |
| `language` | `auto` | 通知文案语言，`auto` / `zh` / `en` |
| `includeSubagents` | `false` | 是否为子代理会话也弹窗 |
| `snippet` | `true` | 是否在通知里显示内容摘要（约 110 字） |
| `notifyTurn` | `true` | 是否在一轮结束时弹窗（插件页面也有开关） |
| `soundComplete` | `default` | 一轮结束时的提示音（插件页面也有下拉） |
| `soundQuestion` | `reminder` | 中途提问时的提示音（插件页面也有下拉） |
| `soundApproval` | `reminder` | 等待授权时的提示音（插件页面也有下拉） |
| `notifyQuestions` | `true` | 是否在 agent 中途提问时弹窗（插件页面也有开关） |
| `notifyApprovals` | `true` | 是否在工具调用需要授权时弹窗（插件页面也有开关） |
| `flashTaskbar` | `true` | 弹窗时是否顺带闪烁任务栏图标（插件页面也有开关；闪烁会持续到窗口被切到前台） |
| `replyInToast` | `true` | 弹窗内回复：提问正文与选项进通知、授权通知带「允许一次 / 拒绝」两个按钮（插件页面也有开关；关掉则通知只提示） |
| `customSounds` | `{}` | 自定义提示音表 `{ 名字: "D:\\sounds\\x.mp3" }`（插件页面上增删） |
| `clickToOpen` | `true` | 是否支持点通知跳回该会话（插件页面也有开关） |
| `respectFocus` | `true` | 你正看着某个会话时不弹它的通知，其他会话照弹（插件页面也有开关） |
| `approvalTimeoutMs` | `180000` | 通知上按钮的有效期；超时后交回 DSH 自己的授权界面 |
| `suppressWhileGoal` | `true` | goal 自动连续多轮时只在目标完成 / 受阻那一轮提醒（插件页面也有开关） |
| `volumeComplete` / `volumeQuestion` / `volumeApproval` | `100` | 三类提示各自的音量 0–100（插件页面也有滑块） |
| `quietComplete` / `quietQuestion` / `quietApproval` | `''` | 三类提示各自的静音时段 `"22:00-08:00"`；空字符串表示关着，插件页面上打开开关会直接写入 `"22:00-08:00"`（之后可用两个时间下拉改） |
| `minDurationMs` | `0` | 短于该耗时的轮次不弹结束通知，用来过滤秒回的小任务 |
| `debug` | `false` | 打开后把触发与跳转链路写入日志 |
| `platform` | 运行平台 | 通知后端：`win32` 走 Windows 通知，`darwin` 走 macOS 那套。一般不用改，留着是为了让测试脚本能在 Windows 上跑 macOS 分支 |

提示音取值：`default`、`reminder`、`mail`（系统通知音）、`silent`，8 个自带音效的 id（见上表），`custom:<名字>` 指向自定义文件，也可以直接写 `ms-winsoundevent:Notification.Xxx` 或音频文件路径。旧配置里的 `sms`/`im`/`alarm` 仍能解析（下拉里不再显示），`sound: false` 相当于三个音都设为 `silent`。

`debug` 的日志位置：`%TEMP%\dsh-session-toast.log`（可用 `debugLog` 指定别处）。

## macOS（beta，功能可能不正常）

> **这一节是 beta 能力：代码写完了、逻辑也在测试里跑过，但没有在真 Mac 上验证过。** 通知能不能弹、声音能不能响、点通知能不能跳回来，都属于「可能正常、也可能不正常」，别把它当成 Windows 版的等价物。

macOS 上用的是另一条链路，因为普通进程没法像 Windows 那样直接弹一条「属于 DSH 应用」的通知：

1. Host 半把通知塞进队列（`GET …/inbox`），并等 5 秒
2. 页面里的浏览器半每 1.5 秒来领（`POST …/inbox/claim`），领到就用系统 `Notification` 显示——**归属是 DSH 自己的应用身份**，点通知会切到对应会话
3. 5 秒内没人领（比如 DSH 窗口关了），Host 半退回 `osascript -e 'display notification …'`；这时通知归属是「脚本编辑器/osascript」，也没有点击动作
4. 声音：三个系统音映射到 `/System/Library/Sounds/`（Glass / Ping / Submarine），自带 mp3 与自定义文件用 `afplay -v <0-1>` 播放；页面在跑时改为页面按音量播放（音频字节从 `GET …/sound?name=` 取）

**macOS 只做简单提醒，不做「在通知上操作」。** 逐项能力：

| 能力 | Windows | macOS |
| --- | --- | --- |
| 弹通知（标题 + 正文 + 摘要） | 是 | 是（页面在跑时用系统通知，页面关着用 osascript） |
| 点通知切到对应会话 | 是 | 仅页面在跑时（用 osascript 兜底的那条点不了） |
| 通知上的按钮（允许一次 / 拒绝、选项答案） | 是 | **否**——浏览器通知没有按钮，macOS 要按钮必须走 `UNUserNotificationCenter` 加一个签名的辅助 app |
| 任务栏/程序坞闪烁 | 是 | 否（见下） |
| 内置音效、自定义音频、音量、静音时段 | 是 | 是（`afplay -v`） |
| 前台不打扰、goal 抑制、子代理去重 | 是 | 是 |

差异与限制：

- **macOS 上授权请求不再被插件接管**：没有按钮可点，插件只提醒并把请求原样交回应用内卡片，不会白等 180 秒
- **「弹窗内回复」这条开关在 macOS 上禁用**，并提示仅 Windows 支持
- **任务栏闪烁不做**：macOS 不允许一个进程去闪别的应用的窗口，`flashTaskbar` 在 macOS 上无效果；设置面板里这条开关会显示为禁用，并提示仅 Windows 支持
- **点击跳会话依赖页面在跑**：窗口关着时只有 osascript 通知，点它不会切会话
- **通知权限**：第一次用到时 macOS 会问一次；在「系统设置 → 通知」里把 DSH 关掉后就没有通知了
- **未在真机上验证过**：这段是在 Windows 上按 AppleScript / `afplay` / Web Notifications 的行为写的，只用测试脚本跑过队列、领取、声音路由与静音逻辑；真机上如果有偏差，把 `debug` 打开后的日志发我

## 实现说明

- 一个插件包两半：Host 半（`index.js`）负责事件、文案和弹窗；浏览器半（`client.js`）负责“点通知之后把页面切到那个会话”
- 弹窗走 Windows PowerShell 5.1 + WinRT（PowerShell 7 加载不到通知类型），脚本 `toast.ps1` 以 base64 传入 JSON 载荷，用 DOM API 建 XML，不拼字符串
- 会话标题取自 `ctx.sessionTitle`，耗时来自 `running → idle` 的时间差，结束状态与摘要来自 `session/event` 里的 `turn/end` 与 `assistant/message` 缓存
- 点通知的链路：通知带 `activationType="protocol"` + `launch="dsh-session-toast:?session=<id>"` → 协议注册指向 `wscript.exe //B //Nologo launch.vbs "%1"`（插件激活时用 `reg.exe` 写注册表；`wscript` 是 GUI 进程，从它启动 PowerShell 才不会闪黑窗），`launch.vbs` 隐藏启动 `jump.ps1` → `jump.ps1` 把会话 id 写进 `%TEMP%\dsh-session-toast-pending.txt` 并拉起 `dsh://open` → 页面里的 `client.js` 每 1.5 秒问一次 `GET /dsh-session-toast-v2/pending` → 取到 id 就调 `ctx.uiWorkspace.openSession(id)` → `POST /dsh-session-toast-v2/ack` 回报成败（只在 debug 日志里可见）
- 路由路径带版本号：升级插件时旧代码代仍会占着自己的路由，直到 DSH 重启，所以新代码用新路径，浏览器半先探新路径再回落旧路径
- 插件页面的开关走同一条路由：`GET/POST /dsh-session-toast-v2/settings` 读写设置，「试听」走 `POST …/preview`，「选择文件」走 `POST …/pick`（宿主进程里拉起 PowerShell 的原生文件框）；面板注册在 `plugins.bundle.config` 槽位（key 为包名 `session-toast-notification`），用平台自带的 `react` 手写渲染，不依赖其它插件
- “你在看哪个会话”来自浏览器半：它注册一个渲染 `null` 的小组件到会话作用域的 `conversation.session.header.utilities` 槽位，拿到当前会话 id 后，在窗口聚焦 / 失焦 / 标签页可见性变化时 `POST /dsh-session-toast-v2/presence` 上报 `{sessionId, focused, visible}`；宿主侧记录最近一次上报（120 秒内有效）
- 授权通知上的按钮：宿主先把 `approval/request` 挂起（这是 waterfall 事件，返回结果即接管、调 `next()` 才交回应用内），按钮用 `activationType="protocol"` 指向 `dsh-session-toast:?action=allow|deny&call=<id>`，点击后 `jump.ps1` 写 pending 文件（带 action 时不拉起窗口），页面轮询取到就 `POST /dsh-session-toast-v2/decide`；超时或请求被取消则自动 `next()`，按钮不会让 agent 卡死
- 音量：Windows 的系统通知音无法带音量，所以 `toast.ps1` 把三个系统音映射到 `%WINDIR%\Media\Windows Notify *.wav`，与自带 mp3、自定义文件统一用 MCI 播放，并在 `volume < 100` 时发 `setaudio <alias> volume to <volume*10>`
- 自定义音效：宿主把 `custom:<名字>` 或自带音效 id 解析成 `file:<路径>` 交给 `toast.ps1`，脚本把通知音频设为静音后用 MCI（`winmm.mciSendString`）播放，播放完才退出，所以短促的提示音不会被截断
- goal 模式：在 `session/event` 里跟 `goal/change` 事件拿到该会话的 phase，`active` 期间不弹，`complete` / `blocked` 那一轮把标题换成「🎯 目标完成」/「⛔ 目标受阻」

## 限制

- 只在 Windows 与 macOS 上工作：Windows 用 WinRT 通知（`toast.ps1`）+ `winmm` 播放 + `FlashWindowEx` 闪任务栏；macOS 走页面系统通知 + `osascript` 兜底 + `afplay`（见上一节）。Linux 上没有实现，不会弹窗（也不报错）。macOS 为 beta：功能可能不正常，问题按 beta 处理
- 通知内容由 Windows 排版，正文长度有限，过长的标题与摘要会被系统截断
- 系统「勿扰」或按应用关闭通知时不会显示；插件侧无法绕过
- 提示音文件支持 `.wav` 与 `.mp3`；超过 6 秒的部分会被截断
- 授权通知的按钮与卡片一一对应（普通工具审批就是「允许一次 / 拒绝」两个）。点下去是替你回答页面上那张正在等的授权卡片：请求被页面接管时由页面结算，没有页面连接时由插件自己结算，两种都能生效；过了 `approvalTimeoutMs`（默认 180 秒）或通知被划掉，就回应用里自己点。点按钮不会把 DSH 窗口拉到前台。旧版插件留在通知中心里的「本次会话允许」按钮仍然可点（插件自己记的那条会话授权），新通知不再出现这个按钮
- 点通知依赖浏览器半（`client.js`，跑在 DSH 页面里的那一半代码，负责轮询“刚才点了哪个会话”并切过去）：装好插件后需要**刷新一次页面或重启 DSH**，已打开的旧页面才会开始轮询；未刷新时点通知只会把窗口拉到前台，不会切换会话

## 兼容性

插件用到的宿主接口、各 DSH 版本的验证状态、平台能力差异，以及「换一个新版本之后怎么自己验一遍」，都写在 [docs/compatibility.md](docs/compatibility.md)。摘要：

- **DSH 0.2.2-rc.5**：完整验证（四个测试脚本全绿，三类通知与「从通知直接答题」都在真机上跑通）
- 更早的 rc：未验证
- **Windows 10/11**：完整能力；**macOS 14+**：beta，只做简单提醒（没有按钮、没有任务栏闪烁）；**Linux**：未实现

## 开发

```sh
npm run check      # 清单、语法、locale、PowerShell 纯 ASCII、内置音效、市场索引版本
node scripts/release.mjs patch   # 升版本 + 同步 market/index.json
```

仓库结构、不能改的运行时标识、Toast XML 的元素顺序、为什么通知不能靠 waterfall、怎么发版——都在 [AGENTS.md](AGENTS.md)。行为测试（`_test/` 下的四个 harness）需要本机的 DSH 与 Windows，不进仓库。

## 喜欢它？

如果它让你不用一直盯着终端，欢迎在 [GitHub](https://github.com/Jae1010/dsh-session-toast-notification) 点亮 ⭐，也欢迎提 issue / PR。

## 许可证

[MIT](LICENSE)
