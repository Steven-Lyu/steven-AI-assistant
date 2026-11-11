# Personal AI · Personal Assistant

界面已更新为英文，采用精简的任务工作台与状态动画。视觉规范见 `DESIGN.md`，行为约定见 `UX-CONTRACT.md`，浏览器验证记录见 `outputs/ui-verification.md`。

Milestone 1 最小版：浏览器 GUI → Node 应用服务 → 本地 Codex app-server → 用户选中的本地文件夹（也保留 sample 演示）。

## 启动

需要 Windows（含 .NET Framework 4.x 编译器，用于首次构建文件夹选择窗口）、Node.js 22+、可在终端运行的 Codex CLI、已登录且能使用模型的 Codex 账户。没有第三方 npm 运行依赖，不用另填 API Key。

```powershell
npm run check:codex
npm start
```

打开 <http://127.0.0.1:4310>。Ctrl+C 停止服务。`npm run dev` 在服务代码修改后重启。

找不到 CLI 时，可在同一 PowerShell 中指定 `$env:CODEX_BIN = 'C:\path\to\codex.exe'`。默认模型沿用本机 Codex 配置，也可设置 `$env:CODEX_MODEL = '可用模型 ID'`；连接诊断会列出模型。端口通过 `$env:PORT = '4311'` 修改。不自动加载 `.env` 文件。

## 演示

1. 点击 **Browse**，在 Windows 系统窗口中选择本地文件夹。查看路径、文件数量、体积和 **Preview files**。取消选择不会创建任务；空目录不能生成方案。
2. 首版只整理第一层普通文件，最多 200 个；子目录、链接/junction、硬链接和点文件会列为跳过。分类目录位于所选目录内，仍为 Study / Work / Life / Other。
3. 输入偏好，点击 **Make a plan**。Codex 只收到文件名和大小，正文不发送；本地流式哈希用于检测文件变化。模型工作目录与所选目录分离。
4. 审查文件、分类理由和完整源/目标根路径；此时文件尚未移动。点击 **Approve & organize** 后，服务重新校验全部源文件和目标冲突，再真实移动。
5. 完成后使用 **Rescan folder** 更新清单。若文件在规划期间发生变化，或存在目标重名，先处理提示再重新扫描/规划。
6. 失败时查看 **Move report**：Moved 已移动，Not moved 未移动，Check both locations 需要检查源与目标。已完成操作会保留，不自动回滚。
7. **Try sample files** 保留旧演示：每次在 `work/runs/<任务 ID>/Inbox` 生成六份测试文件。Browse 可切换回真实目录。
8. 日程和邮件仍未接入；Reduce motion 和系统减少动态效果设置仍生效。

刷新页面能查看同一服务进程的任务，但需重新选择文件夹以发起新任务。服务重启后内存中的历史与选择失效，磁盘文件保留。

## 实现范围

| 功能 | 当前状态 |
| --- | --- |
| 文件整理 | 真实 Codex 分类、结构化校验、业务确认、实际移动 |
| GUI | 提交、运行、权限审批、业务确认、完成、失败、取消和会话内历史 |
| 动画 | 运行提示、文件卡片出现、完成归位，支持Reduce motion |
| Codex 权限 | 命令、文件更改、额外权限的审批卡片和真实 RPC 回应；处理 resolved、取消、完成、断线 |
| 日程、邮件 | 预留入口，明确未接入，不读取或更改外部数据 |
| 数据 | 用户通过系统窗口选中的真实目录；可切换独立 sample 演示 |
| multi-agent | 后续方向，当前未实现 |

普通分类仅需文本推理，**不一定触发真实权限请求**。卡片只在 app-server 实际请求时出现；协议测试夹具不能当作真实审批演示。当前尚未完成真实模型触发审批的专项人工验收。批准权限与确认文件整理独立；已解决的请求不能重复批准。不支持的 MCP 表单和工具追问明确返回协议错误，不自动批准。

服务只监听回环地址，写入接口校验来源和会话令牌。只接受系统选择器返回的会话内选择 ID，不接受 HTTP 直接提交任意路径。移动前检查目录身份、文件状态和流式 SHA-256，拒绝未知路径、重复文件、链接路径和目标重名。使用同卷独占硬链接后移除源路径（本地 NTFS 支持），不覆盖目标，也不复制整个大文件。不支持硬链接的磁盘（例如 FAT/exFAT）会失败并保留源文件。不要在整理期间让其他程序编辑这些文件。断电、强制退出或恶意并发替换不提供事务保证；历史和报告目前只在内存中，异常退出后应检查源与目标位置。

## 结构与验证

- `public/`：GUI、样式和 SSE 事件展示。
- `server/index.js`：HTTP 接口、静态文件、来源校验。
- `server/tasks.js`：任务状态、业务确认和权限生命周期。
- `server/codex.js`：app-server stdio、请求关联与连接管理。
- `server/files.js`：扫描、流式校验、独占移动和失败报告。
- `server/folders.js` + `scripts/ChooseFolder.cs`：Windows 系统选择器、会话内路径能力和重新扫描。
- `test/`：文件与协议测试；`scripts/`：真实连接诊断。
- `work/runs/`：本地生成文件，Git 已忽略。

```powershell
npm test
npm run check:codex
```

app-server 立即退出时，确认启动环境可访问本机 Codex 配置与认证目录；受限开发沙箱可能不允许启动，应在普通终端运行。项目不修改用户全局权限。未登录或模型不可用时，在终端完成 Codex 登录并重新生成方案。页面保留真实错误，不退回模拟成功。

关闭浏览器不会取消后台任务。执行超过十分钟自动请求中断；等待业务确认不受此限制。停止服务会关闭 app-server 子进程。

协议来源：[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)。已核对本机 CLI `0.167.0-alpha.3.2` 生成类型，升级后应重跑验证。

真实文件夹扩展的测试与验收记录见 [outputs/real_folder_verification.md](outputs/real_folder_verification.md)。
