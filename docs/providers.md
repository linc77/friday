# Claude 和 Codex 配置

在 Friday 的「设置 → Providers」中选择 Claude 或 Codex。

两个配置页都可检测本机 CLI、读取已有认证、列出模型，并设置可执行文件、配置目录、环境变量、默认模型和推理强度。Claude 和 Codex 都可执行独立任务。

## 模型从哪里来

Codex 通过 `codex app-server` 的 `model/list` 分页读取当前账号提供的模型和推理强度。Friday 与 T3 Code 使用相同的接口，模型数量取决于 CLI、账号和配置。Friday 使用默认选择器可见列表。

Claude 通过 Claude Code 的 stream-json 初始化握手读取模型选择项和能力。模型 ID 可能是 `default`、`sonnet` 等别名；配置页同时显示 CLI 返回的实际模型 ID。自定义网关或本机 Claude 设置可以改变别名指向的模型。

重新检测只读取版本、认证和初始化信息，不发送用户对话。Claude 检测禁用 hooks、MCP 和工具，不保存会话。

## 账号和网关

- Codex 默认读取 `~/.codex`；可配置 `CODEX_HOME` 和独立账号目录，也可在页面中登录 ChatGPT。
- Claude 默认读取 `~/.claude`，继承已有 Claude Code 设置。可通过 `CLAUDE_CONFIG_DIR` 指定其他配置目录。在主机运行 `claude auth login` 登录订阅账号，或通过环境变量配置 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`。
- Claude 的启动参数支持 `--model`、`--effort`、`--setting-sources`；检测拒绝对话输入和执行参数。
- 新增变量后点击「保存配置」。主机文件以 `0600` 权限保存，客户端只收到变量名称和已保存状态。已配对设备可读取模型，修改运行配置需要主机身份。

## 模型管理

收藏、显示开关和排序保存在当前设备，并按 Friday 服务地址及 Provider 区分。收藏模型优先显示，隐藏模型从选择器移除；这些偏好不会改变账号权限或主机的默认模型。任务选择器使用同一套偏好，支持搜索、收藏筛选和 Claude／Codex 筛选。

## 在任务中选择

在「任务 → 新任务」选择项目目录，然后点击输入框底部的模型名称。可选择已连接 Claude 或 Codex 的可见模型，以及该模型实际支持的推理强度。已有任务续聊可以更换同一个 Agent 的模型，保留原会话；换 Agent 时应新建任务。

Codex 使用 App Server；Claude 使用官方 Agent SDK 调用已配置的本机 Claude Code。外部会话 ID 在发送任务前写入 Durable 状态，输出、执行记录和授权保存在 Friday；关闭客户端不停止执行。服务中断后保留会话并等待用户明确继续，不自动重放操作。Claude 使用原有配置来源和按需授权，研究模式禁用文件修改和 Bash。

自定义模型保存在主机上，与所有已连接设备共享。添加 ID 不会验证服务是否支持它，也不会解锁模型。Friday 不为自定义 ID 猜测推理能力；使用时由当前账号或网关判断可用性。移除自定义默认模型会恢复为工具默认。

参考：[Codex App Server 模型发现](https://learn.chatgpt.com/docs/app-server#models)、[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)、[T3 Code 的 Codex Provider](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/CodexProvider.ts)。
