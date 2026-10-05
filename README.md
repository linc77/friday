# Friday

Friday 是你的个人 Agent：随手收集想法、关联项目、布置任务，再从任意已连接的设备查看进展和成果。

目前是可运行的 **0.1 开发版**：独立 TypeScript 常驻服务、Pi Durable + SQLite 持久化、原生 SwiftUI Mac 客户端、iOS 客户端与分享扩展源码。Codex 是首个执行工具；Claude Code、Hermes、Pi Coding Agent 目前只检测安装状态。

## 本机运行

需要 Node.js 22.19+、pnpm、macOS 14+、Swift 5.10+，以及已经安装并登录的 Codex CLI。当前已在 Node 26.10 / Swift 6.2.3 / Apple Silicon 上验证。

```sh
pnpm install --frozen-lockfile
pnpm service:install
pnpm mac:build
pnpm mac:open
```

打开后直接在“对话”中输入需求并发送，无需选择任务类型或执行工具。“想法”中的“交给 Friday”会直接开始同一段对话，不再弹出表单。只想记录时，可以在“想法”中保存，或对 Friday 说“先记下，不要执行”。

普通问答和调研直接处理。新对话尚未选择项目时采用只读执行；确实需要本地项目时，Friday 会在对话中请你选择已有项目或主机目录。选好后沿用原会话继续；等待选目录的对话不占用执行队列。后续消息继承这个目录，不再重复询问。内部执行工具、目录和会话 ID 收在“执行详情”中。

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
- Codex 自己保存原生会话；Friday 记录对应 thread / turn ID。

关闭客户端不影响执行。重启服务后，尚未开始的任务继续排队；对曾启动的外部调用保守地标记“待恢复”，由用户检查后明确继续。无法确认的外部操作不会自动重放；取消也不会撤销已经发生的改动。

备份时先停止服务，再复制整个数据目录。如果需要保留 Codex 后续续聊能力，也应按其原生方式保留本地会话。不要只复制一个正在写入的 SQLite 文件。

开发环境可以设置 `FRIDAY_DATA_DIR`、`FRIDAY_PORT`、`FRIDAY_HOST`；客户端本机默认端口为 4317。

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
