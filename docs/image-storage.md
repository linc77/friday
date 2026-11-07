# 笔记与图片存储

主机使用一个 `friday.sqlite` 持久保存 Pi Durable 正文和图片原始字节。`friday_assets` 保存不可变 SHA-256 ID、媒体类型、大小和 BLOB；`friday_asset_refs` 是从 Durable 内容维护的引用索引，名称、显示位置等元数据继续由原正文/消息持有。`friday_asset_uploads` 为未正式关联正文的上传提供七天保留期。

`openFridayStorage` 复用 Pi Durable 公开的 `SqliteDatabase` 适配接口。Durable 提交、图片存在性检查和引用变更在同一条连接、同一个 SQL 事务中完成；异步事务期间其他上传与回收排队。只有 SQL 提交成功才向 Durable Session 返回成功。确定回滚的附件错误使用 `StorageRejected`，回滚失败继续按致命错误处理。WAL、`synchronous=FULL` 和外键约束在主机连接上启用。

图片提前上传后，保存正文只需要检查元数据并关联引用，不重复写 BLOB。普通文字增量位于图片子树之外时，不重建图片引用；路径提示仅在提交成功后更新，缓存只保存有界的路径信息。API、状态快照、请求 ID 和图片 ID 保持兼容，当前每张 10 MiB、每条消息合计 80 MiB 的限制继续生效。

## 回收与执行

删除笔记或图片引用只解除当前文档的使用关系。任务输入、消息、排队内容、回退数据以及 Durable 可回溯文档历史分别保有引用，归档或删除当前展示不能使这些内容中的图片失效。最后一条引用解除后重新计算七天宽限期；未过期的上传租约也阻止删除。回收每小时执行一次，每次最多 100 个对象，并在写事务内核对引用和租约。仍被保留的 Durable 历史不会被本功能清理。

本地 Agent 使用稳定的 `idea-images/<hash>` 路径。执行前从数据库取原图，按需原子生成或修复文件副本；新上传不立即创建文件。为兼容原生会话里已记录的路径，当前不自动删除这些文件副本。数据库原图与文件副本无双向同步关系。

## 迁移与恢复

主机首次升级逐个读取旧图片，检查普通文件、大小、类型和 SHA-256，分批写入 BLOB；保留原文件。中断后重启可以续做，任何校验失败会停止迁移并报告问题。引用回填枚举固定的 Pi Durable 1.0.2 SQLite v1 记录，文档内容由 Durable 自己还原；未知结构拒绝回填。全部完成后标记迁移完成，后续不会把 Agent 文件副本重新当作原图导入。

`pnpm notes:backup <目标.sqlite>` 支持运行期间的一致快照，导出后检查 SQLite 完整性、外键和每张图片的内容哈希，在私有临时目录内完成后才发布到目标路径。已有目标不会被覆盖。恢复演练应在独立数据目录中进行，验证正文、原图读取以及从空图片目录重新生成 Agent 文件。本命令不替代包含授权、项目文件、其他 SQLite 数据库和原生 Agent 会话的整机数据备份。

客户端图片和待同步笔记保存于 Application Support 下按应用 Bundle Identifier 隔离的 `Friday/Clients/<bundle-id>/notes.sqlite`。正文、同步请求 ID、本地图片引用和明确的远端图片引用在一个事务内更新。新图片缺失或数据库写入失败时保留上一次成功保存的草稿。未同步的原图不作为可清理缓存；任务草稿也使用此图片库，暂不启用客户端原图回收。

## 定向检查

- `pnpm exec tsx --test server/test/ideas.test.ts server/test/task-images.test.ts server/test/image-storage.test.ts`
- `bash scripts/test-note-storage.sh`：只编译并运行客户端 SQLite 逻辑测试，不构建或打开应用。
- 修改存储接口后运行 `pnpm typecheck`。

检查覆盖事务回滚与后续重试、共享引用、租约和宽限期、旧文件迁移、图片 ID 去重、历史保留、缓存重建，以及仅从备份数据库恢复正文和图片。
