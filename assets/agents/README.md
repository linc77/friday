# Agent 品牌资源

用于任务模型选择器的品牌识别；商标归各自所有者所有，不表示 Friday 获得官方背书。

- `openai.svg`：提取自 [OpenAI 开发者网站](https://developers.openai.com/) 的官方页首标识，保留原始路径和 viewBox。使用约定见 [OpenAI 品牌指南](https://openai.com/brand/)。
- `claude.svg`：来自 [Anthropic 官方媒体资源包](https://www.anthropic.com/press-kit) 的 `Claude Spark - Clay.svg`，保留原始路径和颜色。
- 资源获取日期：2026-10-07。透明 PNG 以 128 × 128 导出，覆盖当前最大 22 pt 在 3× 屏幕上的需求；由 Swift Package 资源包提供给 macOS 和 iOS。

从仓库根目录重新导出（需要 librsvg）：

```sh
rsvg-convert -w 128 -h 128 assets/agents/openai.svg -o apps/apple/Sources/FridayKit/Resources/AgentCodex.png
rsvg-convert -w 128 -h 128 assets/agents/claude.svg -o apps/apple/Sources/FridayKit/Resources/AgentClaude.png
```
