# 功能图标资源

## Worktree

- 使用 Microsoft [VS Code Codicons 的 `worktree`](https://github.com/microsoft/vscode-codicons/blob/main/src/icons/worktree.svg)，由用户于 2026-10-09 选定。
- 原始 SVG 保存于 `codicons/worktree.svg`，保持原始路径与 16 × 16 viewBox。版权归 Microsoft 及贡献者；图标采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，原始许可随附于 `codicons/LICENSE`。
- 从 SVG 导出透明 128 × 128 PNG，供 macOS 和 iOS 共用的 Swift Package 资源包加载。除尺寸与格式转换外未修改图形；运行时以模板图片继承前景色，适配明暗主题。
- 应用资源包随附 `Codicons-NOTICE.txt`，记录作者、原始资源、许可链接与格式转换说明。
- 任务列表标记与 New Worktree 按钮复用 `WorktreeIcon`，保持静态。具体界面约定见 [图标与动效规范](../../docs/icon-motion.md)。

从仓库根目录重新导出（需要 librsvg）：

```sh
rsvg-convert -w 128 -h 128 assets/icons/codicons/worktree.svg -o apps/apple/Sources/FridayKit/Resources/Worktree.png
```

## Git commit

- Mac 任务顶部 Git 入口使用 Paseo `packages/app/src/git/action-icons.tsx` 中的 Lucide **`git-commit-horizontal`**。
- 来源固定为 Paseo 锁文件中的 `lucide-react-native@1.50.0`，下载时按该锁文件的 SHA-512 integrity 校验。原始图标定义保存于 `lucide/git-commit-horizontal.mjs`，原始节点转为 `lucide/git-commit-horizontal.svg`，保持 24 × 24 viewBox、2 pt 描边与圆端点。
- Lucide Icons and Contributors，ISC 许可，原始许可随附于 `lucide/LICENSE`；应用包内包含 `Lucide-NOTICE.txt`。该 SVG 仅转换格式与分辨率，未修改几何形状。
- 使用静态模板图片继承正文色，显示为 16 pt；不套用 SF Symbols 动效。

```sh
rsvg-convert -w 128 -h 128 assets/icons/lucide/git-commit-horizontal.svg -o apps/apple/Sources/FridayKit/Resources/GitCommitHorizontal.png
```
