# 兼容性

这个插件靠 DeepSeek Harness 的公开插件接口工作，没有打进宿主内部。接口一改就可能失效，所以这里记清楚「靠哪些接口」「在哪些版本上验证过」。

## DSH 版本

| DSH 版本 | 状态 | 说明 |
| --- | --- | --- |
| 0.2.2-rc.5 | ✅ 完整验证 | 开发与全部测试都在这个版本上做的：四个 harness 全绿，提问/授权/完成三类通知与「从通知直接答题」都在真机上跑通过。 |
| 0.2.2-rc.5 之前 | ⚠️ 未验证 | 插件用到的 `session/event` 审计事件（`approval/asked`、`tool/call`）与 `plugins.bundle.config` 槽位在更早的 rc 上是否齐全没有确认过，装之前请先看本文件末尾的「怎么自己验一遍」。 |

`package.json` 里声明了 `engines.dsh = ">=0.2.2-rc.5"` 与 `dsh.compatibility.dshReleases`，安装时会按这个校验。

## 用到的宿主接口

| 用途 | 接口 | 位置 |
| --- | --- | --- |
| 一轮结束 | `agent/status`（`running` → `idle`） | 宿主侧事件 |
| 第几轮、结束原因、摘要 | `session/event`：`turn/start`、`turn/end`、`assistant/message` | 宿主侧事件 |
| 提问 | `session/event` 的 `tool/call`（`name === 'ask_user_question'`） | 宿主侧事件 |
| 授权 | `session/event` 的 `approval/asked` | 宿主侧事件 |
| goal 抑制 | `session/event` 的 `goal/change` | 宿主侧事件 |
| 会话标题 | `ctx.sessionTitle.get(session).title` | 宿主服务 |
| 自己起 HTTP 路由 | `ctx.webServer.register({ kind: 'prefix', path })` | 宿主服务 |
| 读/改设置、领取待办、请示音效 | 插件自己的 `/settings`、`/pending`、`/decide`、`/inbox`、`/sound` 路由 | 插件内 |
| 设置面板 | `plugins.bundle.config`、`settings.section`、`settings.section.icon` | 客户端槽位 |
| 当前在看哪个会话 | `conversation.session.header.utilities`（session 作用域槽位，注入 `sessionId`） | 客户端槽位 |
| 从通知答题/审批 | `uiSession.sessionStatus` 快照里的 `pendingInteraction`，调 `pending.answer(...)` | 客户端服务 |
| 点通知跳回会话 | `ctx.uiWorkspace.openSession(sessionId)` | 客户端服务 |

## 平台

| 平台 | 状态 | 能力 |
| --- | --- | --- |
| Windows 10 / 11 | ✅ 完整 | WinRT Toast（三行文字 + 最多 3 个按钮）、MCI 播 mp3/wav（含音量）、`FlashWindowEx` 任务栏闪烁、`dsh-session-toast:` 协议点击回调。 |
| macOS 14+ | 🧪 beta | 只做简单提醒：通知由页面用系统 `Notification` 显示、页面不在时退回 `osascript`；声音走 `/System/Library/Sounds/*.aiff` 与 `afplay`；**没有按钮、没有任务栏闪烁**。代码写完了、逻辑在 harness 里跑过，但没有在真 Mac 上验证过，功能可能不正常。 |
| Linux | ❌ 未实现 | 宿主本身能跑，但插件里的通知、音频、协议注册全是 Windows/macOS 的实现。 |

## 怎么自己验一遍

在一台装了目标 DSH 版本的机器上：

1. 装插件，重启或刷新页面，让宿主侧与页面侧的代码都是新的。
2. 打开 设置 → 弹窗提醒，把「会话完成时弹窗」打开，静音时段关掉，完成提示音选一个自带音效，点「试听」——能听到声音说明音频链路通。
3. 让它跑完一轮对话——右下角应出现三行通知（状态·标题 / 耗时·目录 / 结尾摘要）。
4. 触发一次提问（让 Agent 问你一个问题）——通知上应出现选项按钮，点一个，应用里的卡片应自动被作答。
5. 触发一次工具授权——通知上应有「允许一次 / 拒绝」两个按钮（和卡片一致）。

第 4、5 步失败但第 3 步正常，通常是宿主的审计事件改名或审计覆盖范围变了；这时打开 `cordis.patch.yml` 里的 `debug: true`，日志会写到 `%TEMP%\dsh-session-toast.log`，里面每次 `notify` 都会打印它看到的事件与生成的文本。
