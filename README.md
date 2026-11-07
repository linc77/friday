# Friday

<img src="assets/brand/friday-mac-icon.png" alt="Friday：黑底灰白几何 V，罗马数字 5 对应周五" width="96" />

Friday 是你的个人 Agent：随手收集想法、关联项目、布置任务，再从任意已连接的设备查看进展和成果。

目前是可运行的 **0.1 开发版**：独立 TypeScript 常驻服务、Pi Durable + SQLite 持久化、原生 SwiftUI Mac 客户端、iOS 客户端与分享扩展源码。Friday 通过 DeepSeek API 直连模型，使用 Pi Durable 的模型与工具循环。主会话始终是 Friday。Codex 是任务中的可选执行工具，Friday 委派前需单独批准；Claude Code、Hermes、Pi Coding Agent 目前只检测安装状态。

## macOS 个人测试版

[下载 Friday 0.1.0-beta.2（DMG）](https://github.com/linc77/friday/releases/download/v0.1.0-beta.2/Friday-0.1.0-beta.2-macOS-arm64.dmg) · [版本说明](https://github.com/linc77/friday/releases/tag/v0.1.0-beta.2)

适用于 Apple Silicon Mac，要求 macOS 14 或更新版本。打开 DMG，按安装包窗口中的提示安装并启动 Friday；已内置 Node.js 和常驻服务，无需安装开发工具。后续版本可在 Friday 菜单中点击“检查更新…”。

这是尚未经过 Apple 公证的个人测试版，首次打开可能需要在“系统设置 → 隐私与安全性”中允许打开。安装、后台服务和后续发版步骤见 [macOS 发布指南](docs/macos-release.md)。

## 本机运行

需要 Node.js 22.19+、pnpm、macOS 14+、Swift 5.10+，以及DeepSeek API Key。只有调用可选编码工具时才需要安装并登录 Codex CLI。当前已在 Node 26.10 / Swift 6.2.3 / Apple Silicon 上验证。

```sh
pnpm install --frozen-lockfile
pnpm service:install
pnpm mac:build
pnpm mac:open
```

开发预览使用 Debug 构建，复用定向原生测试的增量编译缓存；`--standalone` 发布构建使用 Release 优化。相关功能完成后统一检查和打包，开发中只运行受影响的测试。

macOS 开发构建会自动标明当前工作区：主检出显示 `Friday · main`，Codex worktree 例如 `Friday · 449d`，其他 worktree 使用目录名。应用包相应为 `dist/Friday-main.app`、`dist/Friday-449d.app` 等，窗口标题同步使用这个名称；每个检出目录有独立的 Bundle Identifier，可以同时打开。继续使用 `pnpm mac:build` / `pnpm mac:open` 即可，名称不随分支或提交变化。独立应用标识也使各工作区的客户端偏好分别保存；服务和数据仍按原连接配置使用，隔离服务时另设 `FRIDAY_DATA_DIR`、`FRIDAY_PORT` 和 `FRIDAY_SERVER_URL`。`--standalone` 发布构建仍使用 `Friday.app`。

任务网页面板的本机模式使用系统 WebKit。手机或远端 Mac 访问主机 `localhost` 时，会连接常驻服务中的主机浏览器；公网网页也可从菜单选择“在主机浏览器中打开”。这一模式要求服务主机已安装 Chrome／Chromium，或通过 `FRIDAY_BROWSER_EXECUTABLE` 指定绝对可执行路径。浏览器使用独立私有配置和沙盒，不使用日常 Chrome 配置；断开客户端保留页面，关闭任务标签或删除任务释放页面。主机模式已支持文件上传／下载与文字剪贴板；主机截图／录屏及浮动／独立／画中画预览已接通；网页批注、开发工具、音频与完整配置管理等仍在对齐中，详见 [任务对齐清单](docs/t3code-task-parity.md)。

启动后先进入“设置 → Providers → Friday”，填入 [DeepSeek API Key](https://platform.deepseek.com/api_keys)，点击“验证并保存”。Friday 会向官方接口发送一次简短测试请求（产生少量 API 用量），成功后才保存密钥；失败不会覆盖已有密钥。默认模型为 `deepseek-flash`，主机启动时可用 `FRIDAY_MODEL_ID=deepseek-v4-pro` 选择 Pro。模型和工具调用使用 [DeepSeek 官方 Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)，由 Pi Durable 驱动。续聊会保留历史，并使用当前配置的模型。

打开后直接在“对话”中输入需求并发送，无需选择任务类型或执行工具。“想法”中的“交给 Friday”会直接开始同一段对话，不再弹出表单。只想记录时，可以在“想法”中保存，或对 Friday 说“先记下，不要执行”。

普通问答直接处理。新对话尚未选择项目时不允许访问本地项目文件；确实需要本地项目时，Friday 会在对话中请你选择已有项目或主机目录。选好后沿用原会话继续；等待选目录的对话不占用执行队列。后续消息继承这个目录，不再重复询问。内部执行工具、目录和会话 ID 收在“执行详情”中。

Friday 自己读取想法和显式记忆，可以保存想法与 Markdown 笔记；只有用户明确要求才写入长期记忆。选定项目后，文件写入需核对内容并批准；调用 Codex 也需单独批准。健康摘要同步和每日主动分享可以在设置中开启；尚未接入网页搜索、邮件、日历和任意定时提醒。

Mac 本机客户端从私有文件读取主机凭据；配对设备的凭据保存在系统钥匙串。应用默认仅连接 `http://127.0.0.1:4317`。

常驻服务安装为当前用户的 `dev.friday.server` LaunchAgent，登录后启动，与客户端窗口独立。机器休眠或关机时无法执行任务。“常驻”不表示能在系统休眠时持续运行。

```sh
pnpm service:status
node scripts/service.mjs restart
pnpm service:stop
```

`service:stop` 卸载自动启动项并保留数据。服务运行文件会复制到 Application Support；修改服务代码后需要重新执行 `pnpm service:install`。开发时可以先停止已安装服务，再用 `pnpm dev`。同一数据目录只允许一个服务进程。

## 数据与恢复

默认数据位置：`~/Library/Application Support/Friday/`。

- `friday.sqlite`：Pi Durable 的状态、任务、想法、项目及显式记忆。
- 笔记和任务上传的图片原始字节也保存在 `friday.sqlite` 的独立 BLOB 表，按 SHA-256 去重；状态快照只携带引用。首次运行新版会校验并迁入旧 `idea-images/`，原文件保留。该目录随后只供本地 Agent 使用，文件缺失或被修改会按数据库原图重建。
- `artifacts/`：任务成果 Markdown。
- `access.sqlite` / `owner-token`：设备授权及本机凭据，勿加入 Git 或公开分享。
- `runtime/`：已安装的服务和依赖；`service*.log`：启动日志。
- Friday 自己的模型消息、工具结果和会话存入 `friday.sqlite`；客户端只投影最近 100 条文本消息。
- `model-auth.json`：Friday 独立保存的 DeepSeek API Key，权限 0600，不进入客户端快照或 Git。只有主机所有者可修改；配对设备看不到密钥。历史 OpenAI 凭据及注册文件保留，但当前运行层不读取、不刷新，也不提供 OpenAI 登录入口。
- 只有调用可选 Codex 工具或继续旧 Codex 任务时，才记录其 thread / turn ID。

关闭客户端不影响执行。重启服务后，Friday 模型会话由 Pi Durable 接续；读取和幂等内部操作可恢复。文件写入、保存笔记和 Codex 调用为不可安全重放工具，中断后会向模型返回 interrupted，要求先核对当前状态。旧 Codex 任务仍保留原先的“待恢复”策略。取消不会撤销已经发生的改动。

Pi Durable 已固定为 1.5.0（pi-ai、Chord 同步为 1.5.0）。首次打开旧库时由官方存储适配器自动将 SQLite schema v1 迁移到 v2；搜索 Worker 只读兼容两版，不负责迁移。**升级前先停止服务并备份整个数据目录；迁移后不能用 1.3.0 及更早版本打开，回退必须恢复升级前备份。** 新版还会迁移内置会话/任务文档，不能只改回 schema 版本号。

备份时先停止服务，再复制整个数据目录。如果需要保留 Codex 后续续聊能力，也应按其原生方式保留本地会话。不要只复制一个正在写入的 SQLite 文件。

单独备份已经同步的笔记正文与图片，可在主机运行期间执行 `pnpm notes:backup /绝对路径/notes-backup.sqlite`（可用 `FRIDAY_DATA_DIR` 指定数据目录）。此命令使用 SQLite Backup API 导出一致快照，验证数据库、图片哈希和引用完整性后才发布备份文件，并拒绝覆盖已有文件。快照包含主数据库中的其他 Friday 状态；完整恢复 Friday 仍需上面的整个数据目录及原生 Agent 会话。图片迁移完成前不会生成这种单库备份。

Apple 客户端将待同步笔记及本地图片保存到同一个私有 `notes.sqlite`，成功提交后才更新草稿状态；旧 UserDefaults 草稿及图片按需迁移，迁移失败保留原数据。已在主机保存、尚未下载到设备的图片作为显式远端引用保留。本机图片也供任务草稿使用，因此当前不会自动清理客户端原图。

开发环境可以设置 `FRIDAY_DATA_DIR`、`FRIDAY_PORT`、`FRIDAY_HOST`；客户端本机默认端口为 4317。

服务启动时优先使用 `HTTP_PROXY` / `HTTPS_PROXY`（兼容小写及 `ALL_PROXY`），没有显式配置时读取 macOS 当前的 HTTP/HTTPS 系统代理；本机地址始终直连，`NO_PROXY` 可补充绕过地址。服务安装会保留这些环境变量，系统代理变化后需重启服务。

## iPhone 与多端连接

固定 HTTPS 入口、设备配对、连接器管理、排障与验收边界见 [Connections 模块指南](docs/connections.md)。

用完整 Xcode 打开 `apps/ios/Friday.xcodeproj`，选择 Friday scheme。为 Friday 和 FridayShare 配置同一个开发团队，并设置可用的 `FRIDAY_BUNDLE_PREFIX` 与 `FRIDAY_APP_GROUP`，在两个 target 上启用相同 App Group。App Group 的真机签名依赖你的 Apple 开发者配置。

只有普通 Apple 账号时，选择 **FridayPersonal** scheme，并仅为 FridayPersonal target 选择自己的 Personal Team 和可用的 Bundle Identifier。这个 target 不包含分享扩展，也不申请 App Group；对话、想法、任务和主机配对使用同一套 FridayKit。普通账号的个人安装需要按 Apple 的签名期限重新安装。

也可以在 `apps/ios/FridayPersonal.local.xcconfig` 保存本机的签名配置，FridayPersonal 的 Debug / Release 会自动读取；这个文件已被 Git 忽略。设置 `DEVELOPMENT_TEAM = 你的团队ID` 和 `FRIDAY_BUNDLE_PREFIX = 你的应用标识前缀`，实际 Bundle Identifier 为此前缀加 `.standalone`。更新已安装的版本时，沿用原来的团队与 Bundle Identifier，在 Xcode 中选择 FridayPersonal 和自己的 iPhone，按 ⌘R 编译并覆盖安装，无需先删除 App。服务端代码更新后手机重新连接即可使用；客户端代码更新需要重新安装。

FridayPersonal 曾使用 Xcode 27.0 和 iOS 27.0 SDK 完成签名编译、iPhone 真机安装、主机配对和双向想法同步验收。这是历史版本记录，新入口的蜂窝网络收发和切网恢复需单独验收。首次启动需要在手机上信任开发者。包含分享扩展的 Friday scheme 尚未完成 iOS 编译或真机验收。

1. 使用 Cloudflare 固定隧道，将 HTTPS 主机地址转发到 `http://127.0.0.1:4317`。按 [Connections 模块指南](docs/connections.md) 配置后，用 `pnpm remote:install <https://主机地址> <本机token文件>` 注册后台连接器。手机通过普通 HTTPS 连接，不需要 VPN 或代理分流规则。
2. 在主机的“设置 → 设备管理”里生成配对码，在 iPhone 的“设置 → 连接与设备”填入 HTTPS 地址、设备名称与配对码。配对码 5 分钟内单次有效。
3. iOS 支持保存想法、任务控制和成果查看。分享扩展保存文字/链接到 App Group；**打开 Friday 后**导入并同步。离线想法保留在设备，任务必须在线提交。

HTTPS 入口需要在主机上配置，且主机需要保持在线。对话在前台通过 SSE 更新，回到前台后重新连接。健康数据通过独立的 HealthKit 后台回调和离线队列同步；每日分享可选择 APNs 通知。远程连接要求 HTTPS，不把凭据发到明文局域网地址。

### 健康与主动分享（开发中，待真机验收）

在 iPhone 的「我的 Friday → 健康与主动分享」开启健康同步，并在系统授权页选择允许读取的指标。客户端读取最近 14 天的睡眠、步数、活动能量、静息心率和 Apple 运动分钟；每次完整重算这个窗口，替换旧摘要，也反映近期样本删除或修正。睡眠按前一天中午至当天中午归档，重叠区间只计一次。没有样本的指标保持未知，不能通过空结果判断读取权限是否被拒绝。

设置每天的分享时间和时区，保存后 Friday 会持续执行这个约定；也可以直接在对话中要求「每天九点分享健康情况」或「暂停健康分享」，Friday 使用持久化工具调整约定，不会自动授予模型分析权限。「现在分享一次」可以立即检查完整链路。消息保存在「健康与作息」对话，可继续回复。默认由本机整理固定的可用数字；单独开启「允许当前模型分析健康摘要」后，每日健康对话及你主动询问健康时读取的摘要会发送给当前模型服务。关注内容用于模型的个性化分析。普通对话不会自动注入健康数字，编码工具不接入健康摘要。关闭模型分析授权后，曾读取健康数据的对话会停止模型续聊，避免继续发送已有健康历史；可新开普通对话。

FridayPersonal 支持 HealthKit，不包含原生推送能力。使用付费开发者团队签名的 Friday target 支持 APNs：配置 App Group、HealthKit、后台健康数据和 Push Notifications，并在 iPhone 点击「允许手机通知」。Mac 主机的「健康与主动分享 → 主机推送配置」可选择 APNs `.p8` 密钥，填写 Key ID、Team ID 和签名 iOS App 的 Bundle Identifier。服务验证 P-256 私钥格式后，以 0600 权限原子保存到数据目录中的 `apns-auth.json`，无需重新启动服务；配置不会返回密钥给手机、模型或普通状态快照。已保存的配置会跨客户端关闭和主机服务重启保留。保存成功只证明本机格式和持久化通过，实际 APNs 权限与送达仍需手机验证。

开发时也可通过 `FRIDAY_APNS_KEY_PATH`（本机 `.p8` 文件）、`FRIDAY_APNS_KEY_ID`、`FRIDAY_APNS_TEAM_ID`、`FRIDAY_APNS_TOPIC` 配置。主机保存的配置优先；移除后仍会沿用环境变量配置。通过 `pnpm service:install` 安装的服务会保留这些变量。密钥不加入仓库。手机注册的开发／生产环境决定 APNs 入口。

未配置 APNs 时，分享仍会保存在对话中，通知等待配置，四小时后过期。锁屏通知只提示有新分享，不包含健康数字。Apple 接受通知不等于用户已收到或阅读；发送结果不确定时不自动重复发送。

系统决定 iOS 后台唤醒，锁屏可能使健康数据库不可读；前台、解锁后的健康回调和再次连接会补同步。Mac 休眠或关机时无法工作，恢复后只补处理四小时内的每日分享。停止手机同步会暂停相关分享并清除该设备的主机摘要；已有健康对话仍保留。后台稳定性、真实健康授权、蜂窝同步与 APNs 送达需要真机验收，编译和服务端测试不能替代这一步。

## 验证

```sh
pnpm check
pnpm apple:check
pnpm mac:build
git diff --check
```

后台测试覆盖 Durable 排队与重启恢复、继续旧任务的顺序、幂等提交、单实例持有、设备授权、SSE 更新与撤销、Codex 双向协议、文件授权预览、按需选择目录和仅保存想法。Apple 检查覆盖 SSE 空行处理、旧任务兼容与多轮回复显示，可在不包含 XCTest 的 Command Line Tools 环境运行。

首次验收已使用真实 Codex 完成纯文本任务、隔离目录中的文件写入/读取、以及重启后的原会话续聊验证。测试任务与“Friday 验证项目”保留在应用中，便于查看真实记录。

完整能力边界与后续方向见 [第一版交付](docs/first-delivery.md) 和 [架构](docs/architecture.md)。

## 当前运行层验证

自动测试使用 Pi 的 faux provider 覆盖真实 Durable 模型/工具循环、无 Codex 环境、会话续聊、问题等待恢复、文件路径边界、写入审批及凭据保存。DeepSeek 协议测试通过本地模拟 HTTP 响应覆盖密钥验证、失败重试、流式回复、工具调用和旧模型会话迁移；它不代表真实 DeepSeek 账户可用。真实链路需要填入 API Key 并完成“验证并保存”后验收。

可以用 `FRIDAY_DATA_DIR`、`FRIDAY_PORT` 启动独立服务；Mac 客户端另支持 `FRIDAY_SERVER_URL` 环境变量，用于隔离预览，不修改已保存的连接地址。

## 本地 Agent 任务

主对话始终由 Friday 的 Pi Durable 模型与工具循环处理。想法交办也进入 Friday；本地 Codex 不作为 Friday 的主会话模型。

“设置 → Providers → Codex”提供 T3 Code 式 Codex 运行配置：账号、版本、可执行文件、CODEX_HOME、独立账号目录、启动参数、隐藏值的环境变量，以及默认模型与推理强度。配置以 0600 权限原子保存，只有主机 owner 可以修改；正在执行的 Codex 任务会阻止修改配置。独立账号目录共享配置与会话，账号凭据独立保存，不复制或覆盖已有凭据。

“任务 → 新任务”选择项目，输入任务要求，并选择模型、推理强度。每个任务有独立的 Codex thread、消息、审批和成果；后续消息继续同一个任务会话。主对话与本地任务使用各自的 Durable 排队依赖，本地任务运行时仍可与 Friday 对话。Friday 经批准委派 Codex 时也创建独立任务，在主会话显示任务入口，完成后由 Friday 汇报。Claude Code 等工具仅检测安装状态，尚未提供执行。
