# macOS 个人测试版发布

首版支持 Apple Silicon、macOS 14 或以上。安装包内含 SwiftUI 客户端、Node 24.21.0、编译后的 TypeScript 服务、生产依赖、Skills 和 Sparkle 2.10.0。无需安装 Node、pnpm 或 Xcode 即可运行 Friday；调用外部编码工具仍需单独安装、登录对应工具。

此渠道是未公证的个人测试版，App 使用 ad-hoc 签名，更新 ZIP 使用 Sparkle Ed25519 签名。尚未接入 Developer ID、公证或无人值守 CI 签名，不应称为正式公证版本。

## 安装与服务

1. 打开 DMG，把 Friday 拖入 Applications，再从应用程序目录启动。
2. 如果 macOS 阻止未公证测试版，在系统设置 → 隐私与安全性中允许这次打开；不要关闭系统安全保护。
3. 在系统登录项中允许 Friday 后台运行。菜单「Friday → 软件更新与后台服务」提供服务状态、启停和更新入口。

个人测试版通过用户级 LaunchAgent 注册 `dev.friday.app.server`，plist 位于 `~/Library/LaunchAgents`，程序位于 App 内。测试签名下的 SMAppService 遇到了系统启动约束，因此该路径留待 Developer ID 版本验证后接入。退出客户端不会停止后台服务。通过上述窗口停止服务会保留全部数据，并记住停止状态。

数据沿用 `~/Library/Application Support/Friday`。首次安装会检测旧 `dev.friday.server` 服务，在没有活动任务时停止旧服务、保存原 LaunchAgent 配置并备份数据库，再启用内置服务。旧 `runtime` 目录保留，不随 App 更新覆盖。

开发时继续使用 `pnpm dev` 和 `pnpm mac:build`。要与安装版并行，设置独立的 `FRIDAY_DATA_DIR`、`FRIDAY_PORT` 和客户端 `FRIDAY_SERVER_URL`。指定开发连接的客户端不会接管后台服务。

## 构建与发布

版本、递增整数 build、固定运行时校验值和更新公钥由 `release/macos.json` 管理。每次发布增加 version 和 build；保持 Bundle Identifier、更新公钥和数据目录不变。

更新私钥只存在当前 Mac 钥匙串的 `dev.friday.mac.updates` Sparkle account，不能提交 Git。换电脑发布时需要安全迁移该密钥。公钥允许公开。

```sh
pnpm install --frozen-lockfile
pnpm mac:release
node scripts/test-mac-release.mjs
```

产物在 `dist/releases/`：DMG 用于首次安装，ZIP 用于 Sparkle 更新，另有 `appcast.xml` 和 `SHA256SUMS.txt`。制作包时验证 Node 校验值、包内符号链接、App 代码签名和更新包签名。

发布时把对应源码提交打上 `v<version>` 标签，将 DMG、ZIP、校验文件附在 GitHub prerelease。确认下载可用后，更新 `updates` 分支的 `appcast.xml`。App 的固定 feed 地址是 `https://raw.githubusercontent.com/linc77/friday/updates/appcast.xml`。不得先发布指向缺失安装包的 feed，也不得覆盖已经发布的版本文件。

完成检查并提交发布源码、重新构建后，执行 `pnpm mac:publish` 会按顺序快进推送 main、创建带附件的草稿、检查附件大小、发布 prerelease，最后推送更新 feed。不会强制推送，也不会覆盖已经存在的版本。

## 更新保护与验证边界

安装更新时客户端申请 owner 专用的写入屏障，等待已经进入的写入完成，检查没有 queued/running/waiting 任务，然后停止服务。等 HTTP 关闭且 SQLite 单实例锁释放后，数据库冷备份保存到 `backups/pre-update-*`，再允许 Sparkle 替换 App。无法安全停止时取消退出，并恢复服务。屏障有两分钟超时，失败或放弃更新不会永久锁住写入。

首版不会强制中断正在运行或等待用户审批的任务；先完成或停止这些任务，再重试安装。数据库备份不是自动降级承诺，发生不兼容的数据迁移时不能直接用旧程序打开新数据库。

发布需要验证：服务与 Apple 协议检查、无开发环境启动、凭据和数据重启持久化、owner 更新权限、真实窗口、LaunchAgent 注册及退出、旧版到新版 Sparkle 下载与替换。iOS 模拟器不参与本流程。
