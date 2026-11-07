# Connections

Friday 的多端模型是一个在线 Mac 主机、多个客户端。Mac 保存数据并运行 Pi Durable；手机通过普通 HTTPS 提交命令和接收 SSE 状态。手机无需安装 VPN 或维护代理分流规则。Mac 休眠、关机或网络不可达时，远程执行不可用。

## 单一远程入口

```text
iPhone / iPad → 固定 HTTPS 地址 → Cloudflare Tunnel → Mac cloudflared → 127.0.0.1:4317
Mac 客户端 ────────────────────────────────────────────────────────────→ Friday
```

使用 Cloudflare 固定隧道，Mac 主动建立出站连接。Mac 是数据主机和 Agent 运行时；Cloudflare 负责转发，不运行 Friday Agent，也不保存 Friday 业务数据库。cloudflared 负责网络重连，launchd 负责进程退出后的恢复；Friday 继续负责设备配对和数据授权。连接器不依赖客户端窗口或当前源码目录。

固定 HTTPS 地址对应一个主机。客户端凭据按完整地址保存在钥匙串中，更换域名需重新配对；本次没有增加多地址发现或地址间凭据迁移。

## 首次配置

需要 Cloudflare 账号和托管在该账号下的可用域名。先启动 Friday 常驻服务，确认 `http://127.0.0.1:4317/health` 返回 Friday。

1. 安装官方连接器：`brew install cloudflared`。已安装时无需重复安装。
2. 在 Cloudflare 控制台创建一条固定隧道，为专用子域名（例如 `friday.example.com`）配置公开应用路由：服务类型 HTTP，目标 `127.0.0.1:4317`。自定义 Friday 端口时相应调整。不要把其他本机服务加入这条隧道。
3. 将该隧道的 token 保存在本机仓库之外的私有文件中（权限 0600）。只保存 token 本身；不要将控制台的整行安装命令粘贴进文件，不要提交到 Git 或写入 shell 历史。不启用包含请求头的 debug 日志。
4. 注册 Friday 专用的后台连接器：

   ```sh
   pnpm remote:install https://friday.example.com /绝对路径/隧道token文件
   pnpm remote:status
   ```

安装脚本将 token 复制到 `~/Library/Application Support/Friday/remote/tunnel-token`（目录 0700，文件 0600），launchd 参数只包含文件路径。`FRIDAY_DATA_DIR` 可以指定数据目录；`FRIDAY_CLOUDFLARED` 可以指定连接器绝对路径。安装脚本管理本机连接器，不会创建云端隧道或修改 DNS。首次设置后，登录 macOS 会自动启动；退出 Friday 窗口不影响连接器。

使用固定隧道，不使用临时 `trycloudflare.com` 地址：[Quick Tunnel 不支持 SSE，且每次启动地址会变化](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations)。

该 HTTPS 主机不要配置需要交互式网页登录的 Access 页面或浏览器挑战；原生客户端使用 Friday 自身的设备凭据。Cloudflare 会终止公网 TLS 并转发应用流量，这是选择该入口的信任边界。

## 配对与授权

1. 在手机 Safari 打开 `https://friday.example.com/health`。它只证明健康检查能到达主机。
2. 在 Mac Friday 的“设置 → 设备管理”生成一次性配对码。
3. 在 iPhone Friday 输入同一 HTTPS 根地址、设备名称和配对码。
4. 实际发送消息并确认收到回复，再检查从 Mac 发起的更新是否到达手机。

| 接口 | 作用 |
| --- | --- |
| `GET /health` | 公开健康检查，不包含用户状态 |
| `POST /pair` | 兑换 5 分钟内有效的单次配对码；限制尝试次数 |
| `POST /api/pairing` | 仅本机 owner 可以生成配对码 |
| `GET /api/state` | 凭设备 Bearer token 获取完整状态 |
| `GET /api/overview/events` | 凭设备 token 订阅概览状态；任务内容使用独立订阅 |
| `GET /api/events` | 旧主机兼容的 SSE 状态接口 |
| `DELETE /api/devices/:id` | owner 撤销设备访问权限 |

公网可达不代表获得数据权限。`/api/*` 保持 Bearer 鉴权，服务端只保存设备 token 的哈希，撤销权限也会终止 SSE。隧道 token 与 Friday 设备 token 分别管理。保留 loopback 监听，不为远程访问把 Friday 改为监听 `0.0.0.0`，不关闭 TLS 验证。

## 管理与迁移

```sh
pnpm remote:status
pnpm remote:stop
```

`status` 说明配置和进程是否加载，不声称公网可用；日志位于数据目录的 `remote/tunnel.log`。`stop` 停止并移除 Friday 专用 LaunchAgent，保留主机数据及私有隧道凭据。它不会修改其他隧道。要撤销连接器凭据，在 Cloudflare 控制台轮换 token，再用新 token 文件重新安装。维护 cloudflared 版本使用 `brew upgrade cloudflared`，然后重新执行安装命令。

迁移时先验证新域名并在手机重新配对。确认新入口能收发真实消息后，再停用旧的 Friday 网络转发及手机专用分流；其他应用的网络配置不属于本项目清理范围。

## 验证边界

连接器改动只运行 `pnpm remote:test` 和 `git diff --check`；客户端逻辑改动另选对应的最小检查。脚本测试覆盖私有凭据文件、launchd 配置、重复安装/停止，以及错误输入不停止现有连接器。

云端隧道和实际设备需另行完成以下验证，历史连接测试不能代替这次验收：

- 未配对请求 `/api/state` 返回 401；配对后能获取状态。
- 手机使用 5G、正常使用代理时，提交消息并收到回复，SSE 持续更新。
- Wi-Fi 与 5G 切换、锁屏后回到前台，可以恢复状态。
- 重启 Mac 并登录后，连接器恢复，同一 HTTPS 地址继续可用。
- 撤销测试设备后，其请求被拒绝、已有订阅结束。

此次替换只改变网络入口，不改动既有快照、概览/任务 SSE、离线想法和请求去重。旧主机的协议兼容路径也属于同步能力，不是旧网络方案的残留。消息请求超时不等于主机未接受；更换隧道不能代替提交回执、断线恢复及真实收发的验收。

## 参考

- [Cloudflare Tunnel 设置](https://developers.cloudflare.com/tunnel/get-started/)
- [隧道 token 与 token 文件](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)
