# Friday logo

干净的浅灰磨砂玻璃底，搭配直立粗笔画、圆润端头与转角的石墨色 F。无竖纹、无青绿色强调色。`friday-logo.png` 是完整、不透明的方形母版；`friday-mac-icon.png` 是带圆角和安全留白的 macOS 预览。

母版通过内置 imagegen 生成，参考用户提供的 Arc 图标的简洁玻璃底。修改母版后，在仓库根目录执行 `swift scripts/build-icons.swift`，仅导出图标素材。

脚本使用 macOS AppKit 和 `iconutil` 导出：

- `apps/apple/Assets/Friday.icns`：macOS 多尺寸应用图标。
- `apps/apple/Sources/FridayKit/Resources/FridayLogo.png`：应用内标识，通过 Swift Package 资源加载。
- `apps/ios/Friday/Assets.xcassets/AppIcon.appiconset`：iPhone、iPad 和 App Store 图标，保持不透明、无预制圆角，由系统裁切。

导出只做尺寸、平台遮罩和文件格式适配。macOS 构建脚本已配置图标和 FridayKit 资源包的复制，无需在每次构建时重新生成图片。

最终提示词（内置 imagegen 编辑模式）：

> Use case: logo-brand, precise letter-shape edit.
> Image 1 is the current Friday icon MASTER and the edit target. Image 2 is the user's reference for the F LETTER ONLY.
> Change only the F in image 1: replace the leaning curved F with the upright, bold, broad-stroke uppercase F structure shown in image 2, but make it noticeably more rounded and soft. Keep a straight vertical stem, a horizontal longer top arm, and a horizontal shorter middle arm. No leaning, no italic slant, no swooping or waving arms. Round every outer corner and inner junction generously. Use broad pill-like terminals and a softly rounded bottom of the stem, with corner radii roughly half the stroke thickness, much rounder than the small corner rounding in image 2. The result is a confident friendly rounded F, clean, compact, and immediately readable, not an irregular blob.
> Match the graphite/charcoal glass-metal surface and restrained silver edge highlights in image 2; keep a soft subtle bevel rather than deep extrusion. Preserve the centered placement, visual scale, and generous margins from image 1.
> CRITICAL: Preserve the clean smooth light-gray background from image 1. DO NOT copy the striped/fluted/ribbed background from image 2. No stripes, ribs, visible texture, noise, cloud patterns, or complex reflections. Neutral grayscale only, no teal or colored accents.
> Output one finished square full-bleed opaque master artwork, same dimensions and framing as image 1. No outer rounded-square tile, no border, no transparent margin, no outer shadow or mockup. Only the rounded upright F on the existing clean gray frosted-glass field.
