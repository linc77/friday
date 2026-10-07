# Friday

<img src="assets/brand/friday-mac-icon.png" alt="Friday：浅灰磨砂玻璃底上的圆润石墨色 F" width="96" />

Friday 是你的个人 Agent：随手收集想法、关联项目、布置任务，再从任意已连接的设备查看进展和成果。

目前是可运行的 **0.1 开发版**：独立 TypeScript 常驻服务、Pi Durable + SQLite 持久化、原生 SwiftUI Mac 客户端、iOS 客户端与分享扩展源码。Friday 通过 DeepSeek API 直连模型，使用 Pi Durable 的模型与工具循环。主会话始终是 Friday。Codex 是任务中的可选执行工具，Friday 委派前需单独批准；Claude Code、Hermes、Pi Coding Agent 目前只检测安装状态。

## 本机运行

需要 Node.js 22.19+、pnpm、macOS 14+、Swift 5.10+，以及DeepSeek API Key。只有调用可选编码工具时才需要安装并登录 Codex CLI。当前已在 Node 26.10 / Swift 6.2.3 / Apple Silicon 上验证。

```sh
pnpm install --frozen-lockfile
pnpm service:install
pnpm mac:build
pnpm mac:open
```

启动后先进入“设置 → Providers → Friday”，填入 [DeepSeek API Key](https://platform.deepseek.com/api_keys)，点击“验证并保存”。Friday 会向官方接口发送一次简短测试请求（产生少量 API 用量），成功后才保存密钥；失败不会覆盖已有密钥。默认模型为 `deepseek-flash`，主机启动时可用 `FRIDAY_MODEL_ID=deepseek-v4-pro` 选择 Pro。模型和工具调用使用 [DeepSeek 官方 Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)，由 Pi Durable 驱动。续聊会保留历史，并使用当前配置的模型。

打开后直接在“对话”中输入需求并发送，无需选择任务类型或执行工具。“想法”中的“交给 Friday”会直接开始同一段对话，不再弹出表单。只想记录时，可以在“想法”中保存，或对 Friday 说“先记下，不要执行”。

普通问答直接处理。新对话尚未选择项目时不允许访问本地项目文件；确实需要本地项目时，Friday 会在对话中请你选择已有项目或主机目录。选好后沿用原会话继续；等待选目录的对话不占用执行队列。后续消息继承这个目录，不再重复询问。内部执行工具、目录和会话 ID 收在“执行详情”中。

Friday 自己读取想法和显式记忆，可以保存想法与 Markdown 笔记；只有用户明确要求才写入长期记忆。选定项目后，文件写入需核对内容并批准；调用 Codex 也需单独批准。尚未接入网页搜索、邮件、日历和定时提醒。

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
- `artifacts/`：任务成果 Markdown。
- `access.sqlite` / `owner-token`：设备授权及本机凭据，勿加入 Git 或公开分享。
- `runtime/`：已安装的服务和依赖；`service*.log`：启动日志。
- Friday 自己的模型消息、工具结果和会话存入 `friday.sqlite`；客户端只投影最近 100 条文本消息。
- `model-auth.json`：Friday 独立保存的 DeepSeek API Key，权限 0600，不进入客户端快照或 Git。只有主机所有者可修改；配对设备看不到密钥。历史 OpenAI 凭据及注册文件保留，但当前运行层不读取、不刷新，也不提供 OpenAI 登录入口。
- 只有调用可选 Codex 工具或继续旧 Codex 任务时，才记录其 thread / turn ID。

关闭客户端不影响执行。重启服务后，Friday 模型会话由 Pi Durable 接续；读取和幂等内部操作可恢复。文件写入、保存笔记和 Codex 调用为不可安全重放工具，中断后会向模型返回 interrupted，要求先核对当前状态。旧 Codex 任务仍保留原先的“待恢复”策略。取消不会撤销已经发生的改动。

备份时先停止服务，再复制整个数据目录。如果需要保留 Codex 后续续聊能力，也应按其原生方式保留本地会话。不要只复制一个正在写入的 SQLite 文件。

开发环境可以设置 `FRIDAY_DATA_DIR`、`FRIDAY_PORT`、`FRIDAY_HOST`；客户端本机默认端口为 4317。

服务启动时优先使用 `HTTP_PROXY` / `HTTPS_PROXY`（兼容小写及 `ALL_PROXY`），没有显式配置时读取 macOS 当前的 HTTP/HTTPS 系统代理；本机地址始终直连，`NO_PROXY` 可补充绕过地址。服务安装会保留这些环境变量，系统代理变化后需重启服务。

## iPhone 与多端连接

用完整 Xcode 打开 `apps/ios/Friday.xcodeproj`，选择 Friday scheme。为 Friday 和 FridayShare 配置同一个开发团队，并设置可用的 `FRIDAY_BUNDLE_PREFIX` 与 `FRIDAY_APP_GROUP`，在两个 target 上启用相同 App Group。App Group 的真机签名依赖你的 Apple 开发者配置。

当前机器只有 Command Line Tools，尚未完成 iOS 编译、模拟器或真机验收。项目和 plist 已做语法检查，这不等于 iOS 构建通过。

1. 为服务准备设备可访问的 HTTPS 地址。个人使用可用 Tailscale Serve，将私有 HTTPS 入口转发到 `127.0.0.1:4317`；客户端和主机加入同一 tailnet。
2. 在主机的“连接”里生成配对码，在 iPhone 填入 HTTPS 地址、设备名称与配对码。配对码 5 分钟内单次有效。
3. iOS 支持保存想法、任务控制和成果查看。分享扩展保存文字/链接到 App Group；**打开 Friday 后**导入并同步。离线想法保留在设备，任务必须在线提交。

Tailscale 和 HTTPS 入口尚未替你安装或配置。第一版不含 APNs：App 在前台通过 SSE 更新，回到前台后重新连接。远程连接要求 HTTPS，不把凭据发到明文局域网地址。

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
