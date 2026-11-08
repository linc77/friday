# Friday 对话头像

根据用户在 2026-11-08 提供的小蓝截图重建，保持圆形球体、椭圆眼睛与圆角领结的比例。当前球体、眼睛和领结由 SwiftUI 绘制，颜色可在“外观”中分别设置为纯色；此角色只用于对话头像，应用图标仍使用 V 母版。

- 早期球体素材：[FridayAvatarBody.png](../../apps/apple/Sources/FridayKit/Resources/FridayAvatarBody.png)。使用内置 imagegen 从用户参考图制作，RGBA 透明背景，1254 × 1254；当前头像不再加载这张图片。
- 完整生成提示：[conversation-avatar.prompt.txt](conversation-avatar.prompt.txt)。仅提取球体并移除 UI、眼睛与领结，以便表情独立动画。
- 当前实现：[FridayMark.swift](../../apps/apple/Sources/FridayKit/FridayMark.swift)。眼睛宽／高为头像尺寸的 0.088／0.136；领结宽／高为 0.475／0.195。球体直径为头像尺寸的 92%，所有填充均精确使用所选颜色，仅最新可见头像的眼睛和领结参与已有表情动效。
- 图像按参考重建；原生表情不是 Codex 的 3D 运行时，也不将生成结果描述为与原图逐像素一致。
