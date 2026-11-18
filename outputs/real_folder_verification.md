# 真实文件夹扩展：测试与验收记录

> 版本：0.1（2026-11-11）
> 状态：进程内验证完成；真实 Codex 分类、系统选择器、属性文件仍需真机复验。
> 配合：[需求基线](capstone_requirements_brief.md)「真实文件夹扩展」小节、[实施记录](milestone1_implementation.md)、根目录 [README](../README.md)。

## 验证方式与范围

本环境（Windows + Node v24.16.0）缺少 `codex` CLI，且受限沙箱禁止启动子进程（spawn EPERM），无法直接运行 `npm test` 或真实 Codex 分类。因此改用**进程内探针**直接 import `server/files.js`，覆盖「扫描 → 校验 → 计划 → 移动」各阶段；探针写在被忽略的 `work/tests/` 下，不改动源码。

修复前快照已提交为基线 `f1eb05c`，便于回滚对比。

## 已通过的检查

| 检查项 | 结果 |
| --- | --- |
| 中文目录名 / 文件名全流程移动 | 通过，内容一致 |
| 硬链接检测（nlink>1） | 两个条目均标记 Hard-linked file 并跳过 |
| 变化检测（scan 后改写文件） | 抛 Files have changed... |
| junction 作为目标目录 / 扫描根 | 拒绝，消息含 links or junctions（见下） |
| junction 条目标签 | Link or junction（修复前为 Subfolder） |
| 只读文件（chmod 0444） | 写入被拒（EPERM），但 unlink 仍成功，移动不卡住 |

## 发现并修复：junction 检测失效

- **根因**：Windows 的 junction（目录联接，IO_REPARSE_TAG_MOUNT_POINT）在 Node 的 `fs.lstat().isSymbolicLink()` 返回 `false`、`isDirectory()` 返回 `true`；而 `fs.readdir(..., { withFileTypes: true })` 返回的 `Dirent.isSymbolicLink()` 对 junction 与 symlink 均为 `true`。原 `server/files.js` 用 `Stats.isSymbolicLink()` 识别链接，因此 junction 被误判为普通子目录。
- **影响**：`scanFolder` 把 junction 标成 Subfolder（标签错误，但仍安全跳过、不会移动）；`directoryIdentity` 靠 `realpath` 兜底仍能拒绝，但报错消息是 Linked folder paths are not supported.，不含 links or junctions；`test/files.test.js` 的 junction 测试三处断言失败。
- **修复（`server/files.js`）**：
  1. `scanFolder` 改用 `readdir(root, { withFileTypes: true })`，用 `Dirent.isSymbolicLink()` 判断链接。
  2. `directoryIdentity` 的 `realpath` 兜底报错统一为 `Choose a regular folder without links or junctions in its path.`（`realpath` 会把 junction 解析到目标路径，故能拦截路径中的链接）。
- **修复后验证**：junction 目标目录与扫描根均被拒绝且消息含 links or junctions；外部目录内容未被改动；junction 条目标记为 Link or junction；普通目录、硬链接、中文路径回归通过。

## 仍需真机复验

- 真实 Codex app-server 分类与权限审批（本环境无 codex CLI）。
- `scripts/ChooseFolder.cs` 的 csc 编译与 `winexe` 的 stdout 重定向（沙箱禁止 spawn）。
- 用资源管理器标记的只读 / 隐藏 / 系统属性文件的端到端移动。


## Planning / cancellation fix — 2026-11-11

This later check ran in the local Windows environment with the installed Codex CLI (0.167.0-alpha.3.2). The earlier sandbox-only limitations above describe that earlier environment, not the results below.

- Real app-server initialize/account/model checks succeeded. A sample planning probe reached `waiting_confirmation` in about 10 seconds.
- A read-only planning probe against the user's named test directory reached `waiting_confirmation` in about 9 seconds. No confirmation or file moves were performed. The reported indefinite stall could not be reproduced in this run.
- Confirmed implementation gaps: file preparation had no deadline/abort signal; cancellation awaited the interrupt RPC before publishing any status; closing the transport did not immediately reject pending RPCs. The dynamically rebuilt cancel control could also shift or disappear between pointer-down and click during state changes.
- Added visible checking / connecting / session-starting / planning / retrying phases and elapsed time. Deadlines are 120 seconds for inventory checking, 30 seconds for each connection/session stage and 180 seconds for model planning. Expiry reports failure and closes this application's transport.
- Cancellation now publishes `cancelling` immediately, aborts local hashing, waits for the actual interrupted terminal event, and closes the product-owned transport after 5 seconds if acknowledgment stalls. Late events cannot revive the task. The button has a stable position above the streaming task body; mutation responses also carry current task state.
- Retained the user's `target:exe` / hidden-console picker repair and included the compiler mode in the binary cache key so an old winexe is not reused.
- Regression suite: 28/28 pass, including unresponsive interrupt, delayed completion, preparation cancellation, stage deadline, pending-RPC cleanup, retryable/non-retryable model errors, file collisions and partial moves. Static premium audit: zero findings; JS syntax checks pass.
- Browser: real sample planning reached review; cancellation at review succeeded; cancellation during an active real model turn succeeded and re-enabled Make a plan. After cancellation, a new real sample plan reached review. Keyboard Enter cancellation succeeded at 375px; document scroll width was 365px (no horizontal overflow). Screenshot: `ui-cancel-fixed.png`.

Protocol reference: [official app-server documentation](https://learn.chatgpt.com/docs/app-server), including `turn/interrupt`, `turn/completed`, and retryable `error` notifications. Interrupt acknowledgment alone is not treated as a terminal event.

## Foreground folder picker — 2026-11-11

The user observed Browse opening behind other windows. The helper was a hidden console process. A first GUI-subsystem version used an invisible owner form, but the user reported no visible dialog. The revised helper shows the Windows picker directly, then raises its native `#32770` dialog window to the foreground and topmost level. The helper writes its result to a unique file in `work/native/` and the service deletes that file after reading it. This avoids console stdout in a GUI process. The compile-cache key includes the GUI target and source hash so older helpers cannot be reused. Unit tests: 28/28; native compilation passed. The user confirmed that the revised dialog appeared above the other windows during the live browser check. The test dialog was then closed by reloading the page.

## Preference-driven folders — 2026-11-11

The user requested unrestricted category labels after a subject-based preference still produced only `Study` destinations. Removed the four-category JSON Schema enum and service allowlist. The model now chooses folder names from the preference; the service checks each name as a single Windows-compatible child directory and rejects unsafe paths, device names, empty names, and names differing only by case. The UI's default prompt now asks for subject folders, and long destination labels wrap in review cards. No user folder was moved during this verification.

- Unit tests: 29/29 passed, including distinct `Mathematics` and `Computer Science and AI` destination folders, while keeping the original content and requiring business confirmation.
- Strict frontend audit: zero findings; JavaScript syntax and `git diff --check` passed.
- Live sample plan via the local browser and Codex app-server reached `Ready to review` with `Computer Science`, `Capstone Project`, `Shopping`, and `Travel` destinations. The sample plan was not approved; files remained in the sample inbox.
