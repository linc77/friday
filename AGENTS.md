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

## 图标与动效

- 所有产品界面图标统一使用 Apple [SF Symbols](https://developer.apple.com/sf-symbols/)，通过 `Image(systemName:)`、`Label(..., systemImage:)` 等系统 API 调用。不要使用 emoji、第三方图标库或自绘 SVG/位图代替界面图标。
- 图标默认采用单色、细线或常规字重，保持同一层级的尺寸与视觉重量一致。
- 图标动效优先使用原生 `symbolEffect`，只用于交互反馈和真实状态变化；静止状态不循环播放。历史任务在打开、切换或刷新时不要重播完成动画。
- 遵循系统“减少动态效果”设置；应用处于后台时停止持续动效。新动效必须检查系统版本，并为最低支持版本提供降级。
