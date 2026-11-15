# 会话内交互 HTML

Friday 的任务 MCP `friday_tasks` 提供 `html_render`。Agent 生成自包含 HTML 后调用工具；服务将页面和本地图片保存到 Pi Durable 文档，并原子写入当前轮次的时间线事件。macOS / iOS 会话使用现有 `TaskWorkspaceDocumentView` / WKWebView 展示独立卡片，支持初始高度、内容高度适配、展开、加载失败重试。

```json
{
  "html": "<style>body{font-family:system-ui}img{width:120px}</style><img src=\"friday-image:mascot\"><button onclick=\"this.textContent='已点击'\">试试</button>",
  "title": "吉祥物交互预览",
  "height": 420,
  "images": [{ "name": "mascot", "path": "assets/welcome.webp" }]
}
```

- `html`、`title` 必填，`height` 默认 480，范围 180–1200；内嵌视图适配高度范围 180–900，超出部分在页面内滚动。
- `images` 可选，最多 8 张；用 `friday-image:name` 引用。路径在服务主机解析，沿用已有媒体读取策略，拒绝 Friday 私有运行数据和 Git 内部路径。图片转为 data URL 后保存，不依赖原目录继续存在。
- HTML 源码最多 512,000 UTF-8 字节，单张图片最多 2 MiB，展开后页面总计最多 8 MiB。图片重复引用也计入展开大小。
- 页面使用内联 CSS / JavaScript，可包含内嵌 SVG、Canvas 和 data URL 图片、媒体、字体。禁止网络请求、远程脚本／素材、嵌套页面、表单提交和访问 Friday API。需要图表库时将所需代码内嵌；远程 CDN 不会加载。
- 同一任务轮次的相同页面快照只发布一次；修改页面再次调用会生成新卡片。源码保存在独立持久文档，普通消息快照和工具回执只有引用，不重复传输页面正文。
- 卡片按会话历史分页载入；重启和工作目录清理不会丢失页面。回退轮次后不能继续为被撤回的产物读取内容；继承该事件的分支可以查看同一快照。
- 预览链接由已认证客户端申请，有效期一小时，绑定设备与会话事件；设备撤销、事件撤回或任务删除后拒绝读取。WebView 不携带应用凭证，使用非持久存储和不允许同源访问的 sandbox。
- 页面只向可信外层发送高度提示，没有可调用 Friday 的 JS bridge。离开视图或应用进入后台时卸载预览；重新进入、手动重载及展开会重新运行页面，页面内部输入状态不持久化。

此功能参考 T3 的“明确发布 → 会话附件 → 独立预览行”结构，复用 Friday 的 MCP、历史事件、Pi Durable 和 WebView。当前提供的是 `html_render`，没有引入 T3 的无头浏览器截图工具 `html_preview`；工具成功仅表示产物已保存并可展示，不代表视觉验收完成。现有 HTML 文件面板继续保留原有行为。

最小服务验证：`pnpm exec tsx --test server/test/task-html.test.ts server/test/task-file-assets.test.ts`；接口变化运行 `pnpm typecheck`。客户端测试位于 `TaskHtmlTests.swift`，按项目约定待用户明确要求构建时运行，不自动打开应用或模拟器。
