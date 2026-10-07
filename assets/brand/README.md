# Friday logo

当前图标为纯黑底（`#000000`）、柔和灰白 V（`#E6E6E6`）。V 表示罗马数字 5，呼应 Friday／周五。字形参考用户提供的 X 图标：几何直线、平直端头、尖角底部，左笔画镂空、右笔画实心，采用平面双色图形。

- `friday-logo.svg`：唯一的矢量母版，白色 V 外轮廓与黑色镂空各由一个闭合多边形定义。所有边缘均为直线；同向斜边严格平行，各条笔画与镂空等宽。字形不使用曲线、图片生成或位图描摹。
- `friday-logo.png`：由 SVG 导出的 1024 × 1024 黑底白 V 预览，不作为平台图标的输入。
- `friday-mac-icon.png`：最终 macOS 图标预览。底板完全不透明；1024 画布中的底板宽度为 800、圆角半径为 176，外部留白透明。
- `friday-glass.png`、`friday-glass-dark.png`：保留的旧版 F 玻璃素材，当前导出流程不再使用。

矢量母版的坐标空间为 1024 × 1024。左右斜边的 `Δx/Δy` 分别为 `+9/16`、`−9/16`；黑色镂空的斜边使用相同角度，底部收口延续右笔画的角度。两个顶部端头在同一水平线上，底尖位于画布中轴。沿平行斜边之间测量，左侧两条白边各为 40.5 坐标单位的水平宽度，黑色通道为 81 单位，右侧实心笔画为 99 单位；这些宽度沿笔画保持不变，尖角交汇处按多边形相交收口。

平台导出保留原有 5.5% 留白裁切比例，将白色映射为 `#E6E6E6`。每个尺寸直接填充矢量路径，再由系统抗锯齿生成像素，避免缩放生成图片造成的轮廓误差。

在仓库根目录执行 `swift scripts/build-icons.swift`。脚本用 macOS AppKit / Core Graphics 读取母版中的多边形，并使用 `iconutil` 生成：

- `assets/brand/friday-logo.png`：全幅、纯白字形的母版预览。
- `assets/brand/friday-mac-icon.png`：macOS 图标预览。
- `apps/apple/Assets/Friday.icns`：macOS 多尺寸应用图标。
- `apps/apple/Sources/FridayKit/Resources/FridayLogo.png`：应用内标识。
- `apps/ios/Friday/Assets.xcassets/AppIcon.appiconset`：iPhone、iPad 和 App Store 图标，保持不透明、无预制圆角，由系统裁切。

macOS 构建脚本将图标和 FridayKit 资源包复制到应用中，应用启动时主动加载图标。
