# Friday logo

直立粗笔画、圆润端头与转角的石墨色 F，搭配干净的中性玻璃底。无竖纹、无青绿色强调色。

- `friday-logo.png`：不透明方形母版，用于 iOS 和应用内标识。
- `friday-glass.png`：内置 imagegen 生成的 macOS 半透明素材，玻璃区域约 50% 不透明，F 约 99% 不透明。
- `friday-mac-icon.png`：最终 macOS 图标预览，玻璃底为 70% 透明（30% 不透明），F 保持接近完全不透明。1024 画布中的底板宽度为 800，相比旧版 896 缩小约 11%，与常规 Dock 图标保持接近的视觉尺寸。

导出时裁去玻璃源图周围 5.5% 的生成留白，再施加统一圆角；不铺白色底层。这里是静态图片的半透明效果，壁纸颜色可以透出，不执行实时背景模糊。

透明度由导出脚本中的 `glassOpacity = 0.30` 数值控制。源图保持不变；导出时调整玻璃区域的 alpha，并平滑过渡到保留原有不透明度的 F，重算预乘 RGB 以保留颜色。

修改母版后，在仓库根目录执行 `swift scripts/build-icons.swift`，仅导出图标素材。脚本使用 macOS AppKit 和 `iconutil` 生成：

- `apps/apple/Assets/Friday.icns`：macOS 多尺寸应用图标，保留底板的部分透明度。
- `apps/apple/Sources/FridayKit/Resources/FridayLogo.png`：应用内标识。
- `apps/ios/Friday/Assets.xcassets/AppIcon.appiconset`：iPhone、iPad 和 App Store 图标，保持不透明、无预制圆角，由系统裁切。

macOS 构建脚本将图标和 FridayKit 资源包复制到应用中，应用启动时主动加载图标。

半透明素材生成提示词（内置 imagegen 编辑模式）：

> Use case: logo-brand, transparency/material correction.
> Image 1 is the current Friday icon master to edit. Image 2 is the user's Dock screenshot; the leftmost Arc icon is the reference for a translucent frosted-glass backing and restrained visual weight.
> Preserve EXACTLY the upright, bold, rounded graphite F from image 1: same outline, position, proportions, soft silver edge highlight and dark contrast. Do not redesign or rotate the F.
> Change only the background material: replace the solid opaque gray field with a genuinely SEMI-TRANSPARENT, exceptionally smooth frosted-glass field. This needs real partial alpha in the PNG, not painted fake transparency: neutral pearl-white glass at roughly 35–45% opacity throughout the open background areas, allowing any wallpaper placed behind the PNG to show clearly through. The F itself remains opaque and readable. Keep the glass clean and quiet like Arc's backing, with only very restrained smooth edge lighting.
> Deliver a square RGBA PNG. The glass field extends full bleed to the square edges, but is partially transparent, not opaque. Do NOT pre-mask a rounded square or add outside margins; the native export will apply the rounded tile and a smaller Dock footprint. Do NOT paint a checkerboard, photograph, wallpaper, shadowed room, vertical ribs, stripes, wavy reflection, noise, grain, white opaque tile, colored tint, text, or mockup. There is no solid background behind the semi-transparent glass. Preserve the final F glyph precisely.
