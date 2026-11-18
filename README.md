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

本次交互测试使用独立端口 4311：在项目目录的 PowerShell 中运行 `$env:PORT = '4311'`，然后运行 `node --watch server/index.js`，打开 <http://127.0.0.1:4311/>。`node --watch` 会在服务代码变化时自动重启，因此关闭它时应在**启动它的终端**按 Ctrl+C；仅结束监听端口的子进程会被 watch 进程重新拉起。若启动终端已不可用，先核对监听进程的父进程确为本项目的 `node --watch server/index.js`，再结束该进程树。

Browse 使用系统的 Windows 文件夹窗口，窗口显示在前面；首次使用会把项目内的辅助程序编译到被 Git 忽略的 `work/native/`，不修改 PowerShell 的执行策略。

找不到 CLI 时，可在同一 PowerShell 中指定 `$env:CODEX_BIN = 'C:\path\to\codex.exe'`。每次规划前，应用通过 app-server 的 `model/list` 读取模型目录，选择其中 `isDefault` 的模型（没有标记时选第一个可见模型），并在会话与任务中显式传入；推理强度使用该模型返回的默认值，不再继承本机 Codex 的全局模型配置。也可设置 `$env:CODEX_MODEL = '可用模型 ID'`；不在目录中的值会在推理前报错。`npm run check:codex` 会列出模型、目录默认值及环境变量覆盖值；目录不代表账户权限保证，仍以实际规划请求成功为准。取消覆盖可运行 `Remove-Item Env:CODEX_MODEL -ErrorAction SilentlyContinue`，再重启服务。端口通过 `$env:PORT = '4311'` 修改。不自动加载 `.env` 文件。

## 演示

1. **Only organize files directly in this folder** 默认勾选，只扫描第一层；取消勾选后扫描各级子目录。切换范围会使旧选择失效并重新扫描；任务提交后该选项锁定，完成或取消后可调整。
2. 点击 **Browse** 选择本地目录，查看路径、文件数、跳过项与未扫描范围。扫描期间可点击 **Cancel selection / scan**。默认限制：200 个文件、8 层子目录、1,000 个目录、10,000 个目录项、30 秒遍历；Windows 离线属性检查另有 10 秒上限。超过限制或目录不可读时阻止规划，请缩小范围重新扫描。
3. 输入偏好并点击 **Make a plan**。Codex 只收到相对路径、名称和大小；文件内容留在本地，流式 SHA-256 用于校验。每个文件返回移动、保留或待检查，以及现有分类可沿用／重新分类／不确定的判断。
4. 预览按类别分组，展示源相对路径、完整目标路径及改名原因。可以选择 **Move / Keep / Review**、修改类别或目标名，然后点击 **Update preview** 重新计算最终去向；待检查和阻塞项解决前不能批准。
5. 两种范围均汇总到 `所选目录/Organized/类别/文件名`，不保留原来源子目录。相同类别中的同名文件按源相对路径固定排序，全部从 ` 1` 起编号；已有文件、目录和本批次的原名都参与占用检查。保留 `.tar.gz`、`.tar.bz2`、`.tar.xz`、`.tar.zst`、`.user.js` 复合扩展名，其余使用最后一个后缀；无后缀时在名称末尾加编号。不会去重、覆盖或截断名称。
6. 点击 **Approve & organize** 才移动文件；服务再次检查扫描范围、父目录身份、文件哈希和目标占用。确认后新增冲突会使方案失效，不临时改用另一个编号。全部保留时可 **Finish without moving**。
7. 完成后 **Rescan folder**。输出目录通过身份标记跨重启识别，并从来源排除。已有但归属不明的 `Organized` 会阻止扫描。原来的空目录保留。
8. 失败查看 **Move report**。每批操作的日志保存在 `Organized/.records/`；下次扫描会核对未完成记录中的源和目标，展示实际状态，不自动重放。存在需要检查两个位置的文件时阻止新方案，先人工核对磁盘。
9. **Try sample files** 每次生成独立 sample：单层模式处理 6 个文件，递归模式额外纳入两个子目录内的 `IELTS Reading.txt`，可演示编号。日程和邮件尚未接入。

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

服务只监听回环地址，写入接口校验来源和会话令牌。只接受系统选择器返回的会话内选择 ID，不接受 HTTP 直接提交任意路径。移动前检查目录身份、文件状态和流式 SHA-256，拒绝未知路径、重复文件、链接路径和目标重名。使用同卷独占硬链接后移除源路径（本地 NTFS 支持），不覆盖目标，也不复制整个大文件。不支持硬链接的磁盘（例如 FAT/exFAT）会失败并保留源文件。不要在整理期间让其他程序编辑这些文件。断电、强制退出或恶意并发替换不提供事务保证；任务历史在内存中；实际移动另有逐步刷盘的执行记录，异常退出后仍需根据核对报告处理不明确的两个位置。

## 结构与验证

- `public/`：GUI、样式和 SSE 事件展示。
- `server/index.js`：HTTP 接口、静态文件、来源校验。
- `server/tasks.js`：任务状态、业务确认和权限生命周期。
- `server/codex.js`：app-server stdio、请求关联与连接管理。
- `server/files.js`：范围扫描、目录身份、流式校验。
- `server/organization.js`：分类计划、稳定编号、输出归属、独占移动与持久记录。
- `server/windows-attributes.js`：只读查询 Windows 离线／云端占位属性，避免为校验下载文件。
- `server/folders.js` + `scripts/ChooseFolder.cs`：Windows 系统选择器、会话内路径能力和重新扫描。
- `test/`：文件与协议测试；`scripts/`：真实连接诊断。
- `work/runs/`：本地生成文件，Git 已忽略。

```powershell
npm test
npm run check:codex
```

app-server 立即退出时，确认启动环境可访问本机 Codex 配置与认证目录；受限开发沙箱可能不允许启动，应在普通终端运行。项目不修改用户全局权限。未登录或模型不可用时，在终端完成 Codex 登录并重新生成方案。页面保留真实错误，不退回模拟成功。

关闭浏览器不会取消后台任务。文件校验最多等待两分钟；连接与创建会话各最多三十秒；模型规划最多三分钟。超时会展示失败原因并关闭本应用的 Codex 连接。点击取消立即显示 Cancelling；五秒内未收到结束确认时关闭该连接并完成取消。等待业务确认不受规划超时限制。停止服务会关闭 app-server 子进程。

协议来源：[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)。已核对本机 CLI `0.167.0-alpha.3.2` 生成类型，升级后应重跑验证。

真实文件夹扩展的测试与验收记录见 [outputs/real_folder_verification.md](outputs/real_folder_verification.md)。

多层整理的边界：已识别的代码项目标记（如 `.git`、`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`.sln`）整组排除；HTML/CSS/JS 文件及 `_files`、`_assets` 资源目录保守排除。不能识别所有文件依赖。名称或目标完整路径过长会在预览标为阻塞（目标路径保守上限 240 字符），可改目标名／类别或排除。云文件依据系统离线与 recall 属性跳过；无法查询属性时安全失败，不修改权限。
