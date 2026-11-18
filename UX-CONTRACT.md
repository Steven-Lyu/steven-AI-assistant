# Personal AI interaction contract

Evidence: `outputs/capstone_requirements_brief.md`, `AGENTS.md`, and `server/tasks.js` define the task lifecycle and two distinct approvals. The user's 2026-11-10 request defines English UI and less text. Visual tokens are in DESIGN.md.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | public/index.html task-form + public/app.js start | This contract | New plan | Empty input and submit checks |
| Scrollbar | public/style.css global baseline | DESIGN.md | Standard, forced colors | Browser computed styles |
| Toast | public/index.html toast live region | This contract | Informational only | Inline errors remain authoritative |
| CRUD | public/app.js api/render + server/tasks.js | Requirements baseline | Create plan, confirm, cancel | npm test and browser flow |

Native input, checkbox and details owners are used. No table selection, date picker, select or modal is present. The task panel is non-modal. Changes require explicit business confirmation; Codex permissions require their own request-specific decision.

## Behavior

Create: disable duplicate submission, preserve input, display backend state; no success before backend acknowledgment. Confirm: show file paths/categories and explicit Approve & organize. Cancel: request server cancellation, wait for status. No optimistic movement. Failed actions keep persistent inline error and retain the plan. Approval actions disable together while in flight and expire on backend resolution.

Category names follow the user's organizing preference rather than a fixed list. The review cards show the exact validated single-level destination folder names before any move; long names wrap without hiding the destination.

English copy and en-GB local-time formatting throughout. OS paths and external error details are displayed verbatim. No account data or credentials persisted in the browser; only reduce-motion preference is stored. Current-task state and history remain service-memory scoped as documented in README.

Hash navigation preserves the draft and browser back behavior. History initially shows five records with Show more. EventSource reconnect refreshes the session token and state; mutation buttons stay disabled while offline. Streaming deltas do not replace focusable DOM. Screenreader status is separate from the activity list. Native focus rings, skip link and semantic controls remain available at all widths.

After Approve & organize, the actual executing state uses a file-to-folder visualization. Because local file moves may finish in milliseconds, a successful response also plays a short completion visualization while already labeling the task Completed and All moves confirmed. Never slow file operations or delay truthful status to make animation visible. Failed execution shows the error and does not play successful transfer. Opening an old completed task shows static folder totals; details retain exact file names and destinations. Reduced motion suppresses movement while retaining labels and counts.


## Local folder selection (2026-11-11)

Source: requirements baseline §5 and user's explicit choice to create classification folders inside the selected directory. The source selector is owned by `public/index.html` + `public/app.js renderSource/selectFolder`, reusing existing button, panel, details, live-region and inline-error primitives. Browse invokes `server/folders.js` and the project-owned native Windows picker; the platform owns this dialog's geometry and keyboard behavior. No browser alert/confirm/prompt is used.

Browse disables duplicate folder actions while selecting/scanning. Cancel retains the previous selection without creating a task. Preview exposes eligible names/sizes and skipped items/reasons. Empty and expired selections cannot create a plan. Make a plan discloses that names/sizes go to Codex. Rescan creates a fresh selection ID. Service restart clears the selection, while ordinary transient reconnect preserves it. Completed/failed/cancelled real-folder tasks require rescan before reuse. Original paths and output root remain reviewable at business confirmation. Execution failures show a receipt with completed, not moved and ambiguous files; completed moves are retained. The sample mode remains an explicitly labelled alternative.


Planning resilience (2026-11-11): the task body displays actual preparation / connection / session / planning / retry stages and elapsed time. The cancel control lives above the changing task body, retains its DOM identity and does not move when details arrive. Cancellation publishes a server-owned cancelling state before awaiting Codex; confirmation is unavailable while cancelling. Abort signals stop local hashing; bounded transport shutdown handles missing interrupt completion. Stale notifications cannot resume a cancelled task. HTTP mutation results supply authoritative task state alongside SSE. Disconnection replaces the active spinner with an explicit unavailable-state message.


## Scope and recursive review (2026-11-12)

The native scope checkbox sits below the preference input, defaults to checked, and is disabled for an active task. It binds to a server selection capability; changing it invalidates the old selection before scanning. Missing API scope defaults to first-level. Scans expose progress and cancellation; incomplete inventories cannot create a task.

The shared review renderer groups by category and shows relative sources and complete final destinations. Native radio groups own Move / Keep / Review; labelled text inputs own category and optional target-name edits. No select or new dialog owner is introduced. Edits disable confirmation until Update preview completes and issues a new revision. The service rejects old revisions and unresolved review/blocker rows. Approval always applies the displayed paths and names, without runtime renumbering. Empty move plans finish with No files moved and no transfer animation.

Both scopes consolidate into Organized/category/file. Output identity and execution records persist on disk. Recovered records display per-file moved / not moved / check-both status; ambiguous records block another plan. This is reconciliation, not automatic retry or transaction rollback. Recognized dependency groups and output are excluded and labelled. Source folder structures remain on disk after moving their files.
