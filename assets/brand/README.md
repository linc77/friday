# Friday logo

当前图标为纯黑底（`#000000`）、柔和灰白 F（`#E6E6E6`）。F 保持直立粗笔画、圆润端头与转角，采用平面双色图形。

- `friday-logo.png`：内置 imagegen 编辑得到的黑底白 F 方形母版，供 macOS、iOS 和应用内标识统一使用；导出时将 F 映射为当前的灰白色。
- `friday-mac-icon.png`：最终 macOS 图标预览。底板完全不透明；1024 画布中的底板宽度仍为 800、圆角半径为 176，外部留白透明。
- `friday-glass.png`、`friday-glass-dark.png`：保留的旧版玻璃素材，当前导出流程不再使用。

导出时裁去母版周围 5.5% 的留白，保持 F 与底板的比例。对接近黑色和白色的像素做色阶归一化，再通过 `glyphLevel = 230` 将 F 统一映射为 `#E6E6E6`，同时保留轮廓抗锯齿。旧版玻璃底的 30% 透明度不再应用。

灰白色取自用户提供的 Dock 图标截图对比：第一个图标为银灰渐变，主体中位值约 `#CCCCCC`～`#E2E2E2`；第二个图标的浅色线条从上方约 `#FAFAFA` 渐变到下方约 `#E4E4E4`。这些是截图转为 sRGB 后的近似取样值，不是原始图标的色值定义。当前 F 使用接近这些浅色区域的固定灰白色，降低纯白在黑底上的视觉冲击。

在仓库根目录执行 `swift scripts/build-icons.swift`，仅导出图标素材。脚本使用 macOS AppKit 和 `iconutil` 生成：

- `apps/apple/Assets/Friday.icns`：macOS 多尺寸应用图标。
- `apps/apple/Sources/FridayKit/Resources/FridayLogo.png`：应用内标识。
- `apps/ios/Friday/Assets.xcassets/AppIcon.appiconset`：iPhone、iPad 和 App Store 图标，保持不透明、无预制圆角，由系统裁切。

macOS 构建脚本将图标和 FridayKit 资源包复制到应用中，应用启动时主动加载图标。

黑白版本提示词（内置 imagegen 编辑模式，以上一版 macOS 图标为输入）：

> Use case: precise-object-edit, logo-brand. The attached image is the current Friday app icon to edit. Change the palette to a perfectly solid pure black background (#000000) and a pure white (#FFFFFF) capital F. Preserve the approved F silhouette exactly: upright broad strokes, deeply rounded pill-like terminals and rounded inside corners, same proportions, not a generic font. Convert the F into a clean flat white silhouette, with no gray shading, bevel, chrome, glow, shadow, outline, glass texture or reflections. The black background must be completely uniform, opaque and featureless. Asset preparation: remove ONLY the transparent outer canvas margin and the external rounded-square clipping so the original rounded-square tile's design becomes a FULL-BLEED SQUARE MASTER. The original F occupies about 48% of the tile width and 66% of the tile height; preserve this visual size and centered position relative to the black tile. The output must be a square image with solid black extending to all four edges and corners. A downstream native exporter will apply the macOS rounded-square mask and exact Dock margins. Do not draw a second tile, border or surrounding margin. No teal, extra symbols, text other than the single F, texture, decoration or mockup. Crisp high quality edges, flat two-color black and white.
