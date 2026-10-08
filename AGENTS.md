# Friday

Friday is a personal agent with a resident TypeScript service and native Swift clients. Local coding agents are execution tools; Friday owns the user's ideas, projects, tasks, approvals, memory, and artifacts.

- Keep the service independent from client windows and connection lifetimes.
- Use Pi Durable for persistent execution. Do not replace it with a home-grown workflow engine.
- Persist external session IDs before starting work. Never blindly replay an uncertain external side effect.
- Codex is the first execution integration. Discover other installed agents without claiming unsupported execution or session takeover.
- Keep Session Memory, SQLite Long-term Memory, and file-based Skill Memory distinct.
- Native Apple UI uses SwiftUI with AppKit/UIKit where needed. Reference Telegram interaction patterns; do not copy its code or assets.
- Run the smallest relevant checks. Run TypeScript checks when types or public interfaces change. For cross-module changes, `pnpm check` is appropriate; explain expansion first.
- Never put credentials, local runtime state, or transcripts in Git.

## iOS 模拟器

- 只有用户主动明确要求打开 iOS 模拟器查看效果时，才可以打开；不得为了 UI 验证、截图或查看效果而自行启动模拟器。

## 图标与动效

- 新增或修改产品界面图标、动效时，必须遵循[图标与动效规范](docs/icon-motion.md)。具体偏好与约定统一维护在该文档中。
- macOS 产品界面所有可点击控件在启用时统一使用小手光标；复用通用交互样式，具体范围与兼容规则见上述规范。

## 界面验收

- UI 改动完成后只做差异检查、编译并打开当前工作区构建的应用，由用户亲自检查效果。
- 不主动采集窗口、截图、读取无障碍树或执行自动界面复核；只有用户明确要求时才进行。此约定优先于此前的一次真实窗口检查要求。

## 开发构建命名

- 用户经常在多个 worktree 中并行改动和查看应用，macOS 开发构建必须在应用名及窗口标题中标明工作区：主检出为 `Friday · main`，Codex worktree 例如 `Friday · 449d`，其他 worktree 使用目录名。标识基于目录，不随分支切换或提交变化。
- 使用 `pnpm mac:build` 和 `pnpm mac:open` 构建并打开当前工作区；它们通过 `scripts/mac-app-identity.mjs` 统一解析名称、应用包路径和工作区独立的 Bundle Identifier。不要用固定的 `dist/Friday.app` 打开开发构建。
- `--standalone` 发布构建继续使用 `Friday.app` 和 `dev.friday.mac`。
