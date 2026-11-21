# AGENTS.md

给接手这个仓库的人（或 Agent）的约定。读一遍能省一小时。

## 这是什么

一个 DeepSeek Harness 插件：会话一轮结束、中途提问、等待授权时弹系统通知，并允许直接在通知上答题/审批。

两半结构，缺一不可：

- `index.js` —— **宿主半**。监听 `agent/status` 和 `session/event`，组装文案，用 PowerShell 5.1 + WinRT 弹通知；同时起 `/dsh-session-toast-v2/*` 路由给页面半用。
- `client.js` —— **页面半**（浏览器里跑）。轮询 `/pending` 执行点击回传的动作（跳会话、答题、审批）、上报 presence（当前在看哪个会话）、渲染设置面板。
- `toast.ps1` / `jump.ps1` / `launch.vbs` —— Windows 侧的三段：弹通知、把协议参数落成文件、无黑窗启动。

宿主半改了要重新启用插件才生效；页面半是浏览器直接从磁盘读的，**刷新页面**就生效。

## 三条不能碰的运行时标识

改名会丢数据或让老通知失效，所以它们故意和包名不一致：

| 标识 | 值 | 为什么不能改 |
| --- | --- | --- |
| 点击协议 | `dsh-session-toast:` | 已经写进用户的注册表，老通知里的按钮指向它 |
| HTTP 路由前缀 | `/dsh-session-toast-v2` | 页面半与宿主半要对上；`v2` 是为了绕开旧代残留的 handler |
| 设置文件 | `%DSH_HOME%\session-toast\settings.json` | 用户的既有选择在里面 |

## 改代码时

- **PowerShell 脚本必须纯 ASCII**（或 UTF-8 带 BOM）。Windows PowerShell 5.1 在没有 BOM 时按 ANSI 读，中文会变成乱码并且报一堆莫名其妙的语法错误。`npm run check` 会拦住这条。
- **Toast 的 XML 子元素顺序是 schema 规定的**：`<visual>` → `<audio>` → `<commands>` → `<actions>`。顺序错的时候 Windows 不会报错，而是**静默丢弃**后面的元素——按钮不显示、卡片退化成只有标题，都可能是这一条。
- **通知按钮不要臆造**。DSH 的 `ApprovalOutcome` 只有 `allowed-once` / `rejected` / `cancelled` / `unavailable`，应用内授权卡片也只有「允许一次 / 拒绝」两个按钮。通知上多给一个按钮，等于承诺一个卡片做不到的动作。
- **提问/授权的通知不能等 waterfall**。页面接管时 `user-questions/request`、`approval/request` 的 waterfall 会被远程转发层短路（它返回等页面回答的 Promise、不调 `next()`），后注册的监听器永远收不到。所以通知靠 `session/event` 里的 `tool/call`、`approval/asked` 驱动，waterfall 只作兜底。
- **去重要按 callId**，不要按 `toolName|reason`——同一个工具同一个理由会连续请求多次。
- **设置项分三组**：通知 / 行为 / 提示音。新加的开关想清楚属于哪一组，`PANEL_KEYS`、`BOOL_KEYS`、`cordis.patch.yml` 三处都要加，`pickStore` 要按类型校验（缺失的键要跳过，否则会把 patch 里的默认值覆盖成空串）。
- 会话作用域槽位（`conversation.session.header.utilities`）会自动注入 `sessionId`，这是页面半唯一能拿到「当前在看哪个会话」的办法。

## 测试

```sh
npm run check          # 纯 Node，任何平台都能跑：清单、语法、locale、ASCII、音效、索引版本
```

行为测试在 `_test/`（不在仓库里，体积大且依赖本机 DSH 安装）。跑法需要 DSH 的可执行文件当 Electron：

```sh
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\Program Files\dsh\DeepSeek Harness.exe' 'D:\Program Files\dsh\弹窗提醒\_test\harness.mjs'
```

四个 harness：`harness.mjs`（宿主半）、`client-harness.mjs`（页面半的点击链路）、`settings-harness.mjs`（设置面板渲染与提交）、`mac-harness.mjs`（macOS 分支）。

注意：`harness.mjs` 会**真的弹桌面通知**（它走的是真 `notify()`）。跑完记得清一下通知中心，否则后面手动测试时会被排队的老横幅顶掉。

## 发版

```sh
node scripts/release.mjs patch     # 或 minor / major / 1.2.3
```

它会改 `package.json`、同步 `market/index.json` 的版本与时间戳，然后打印后续步骤：

`node scripts/release.mjs --sync-git` 把 `market/index-git.json` 指向当前 HEAD（`install=git+<url>#<commit>` 靠这个 commit 定位版本），所以顺序是「升版本 → 提交 → sync-git → 再提交 → 打 tag」。

1. 在 `CHANGELOG.md` 顶部加 `## <version>` 段
2. `npm run check`
3. 提交
4. `git tag v<version> && git push --tags`

推 tag 之后 `.github/workflows/release.yml` 会校验 tag 与 `package.json` 一致、跑检查、用 npm 的 trusted publishing（OIDC，不需要 token）发布。

**npm 侧要先配好 trusted publisher**：repository `Jae1010/session-toast-notification`、workflow `release.yml`。没配之前 publish 步骤会在 registry 上 404，那是配置未完成，不是构建坏了。

## 文档

- `README.md` 面向装插件的人：怎么装、长什么样、怎么设置。
- `docs/compatibility.md` 面向排查兼容性的人：靠哪些接口、在哪些版本验证过、怎么自己验。
- `CHANGELOG.md` 面向升级的人：1.0.0 之前的内部迭代折叠在 `<details>` 里。

