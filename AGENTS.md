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
