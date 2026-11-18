# Recursive organization verification — 2026-11-12

Scope: requirements baseline v0.7, now recorded as implemented in v0.8. All filesystem verification used disposable fixtures under project `work/tests/` or generated `work/runs/` samples. No personal source directory was moved.

## Implemented behavior

- Default checked first-level checkbox below the preference input; uncheck for recursive traversal. Scope is bound to the server selection and task. Changing scope invalidates the old selection before rescan; server rejects mismatches and scope changes while a task is active. Reloading an active task reflects its actual scope.
- Scan progress, cancellation, relative paths, skipped groups, explicit unscanned ranges. Incomplete scans block planning. Limits: 8 nested levels, 200 files, 1,000 directories, 10,000 entries, 30 seconds traversal plus a bounded Windows metadata query.
- Codex returns one relative-path disposition per file: move, keep, review; classification assessment is reuse, reclassify or uncertain. No file contents are sent. Category synonyms are a model instruction and can be corrected in review; only case variants are automatically unified by the service.
- Category-grouped review with complete final target paths, rename explanations, totals and native action radios. Category and optional target names are editable. Update preview recalculates destinations and changes the revision; stale confirmations and unresolved rows are rejected.
- Deterministic case-insensitive collision allocation. Reserve available original names before numbering conflicts; account for existing files/directories, other batch original names and already allocated names. Preserve compound suffixes and original numeric name text. No content deduplication, overwrites, truncation or execution-time renumbering.
- Both scopes use `Organized/category/file`. Identity marker survives process restart. Unrecognized outputs, output links, and choosing a managed output or its descendants as the source are blocked.
- Recheck source metadata, hashes, directory identities and destinations before moves. Retain the exclusive hard-link/unlink implementation. Keep source empty directories. Persist and flush execution events; reconcile interrupted records without replay and block ambiguous cases.

## Automated evidence

`npm test`: 40/40 passed on Windows, including actual file moves, single-level isolation, two/three-level relative paths, double IELTS filenames, 3+ duplicates, original numbered names, case variants, existing target files/directories, distinct categories, identical content, Chinese paths, compound suffixes, category/name edits, keep/review, overlong paths, source mutation, parent replacement, output conflicts, post-preview target collision, links/junctions/hard links, project exclusion, depth limits, cancellation, streamed hashing, interrupted journals, locked-file partial failure, scope capabilities, stale confirmations and Codex approval/cancellation regressions.

After adding the direct-managed-output-source guard, `node --test --test-name-pattern='duplicate IELTS|single-level execution|scope defaults' test/files.test.js`: 3/3 passed, including rejection of both Organized and Organized/English as source selections.

`audit_project.py --mode strict`: zero findings. JavaScript syntax and `git diff --check`: passed.

## Browser and real Codex evidence

Local Edge session at port 4311:

1. Scope checkbox starts checked in the required location. Unchecking sample scope changes the count from 6 to 8 files and is disabled throughout planning/review/execution.
2. Real Codex produced English classifications for Course A/IELTS Reading.txt and Course B/IELTS Reading.txt. The preview assigned IELTS Reading 1.txt and IELTS Reading 2.txt. Ambiguous titles were marked Review and disabled approval.
3. Changed Algorithm revision.md's category to Computer Science and AI, target to Algorithm notes.md, and set the two ambiguous sample items to Keep. Update preview reported 6 moves, 3 renames, 2 kept, 0 review and enabled approval.
4. At 375px viewport, the document width and scroll width were both 365px; editing controls stacked and confirmation remained readable. Viewport override was reset after verification.
5. Approved this generated sample plan. UI showed Completed, 6 files organized and All moves confirmed; scope control and Make a plan became available again.
6. Disk verification: numbered IELTS files retained distinct Course A and Course B contents; Algorithm notes.md exists in the selected category; Capstone notes.txt and Team meeting.txt remain in Inbox. A JSONL execution record and output identity marker exist.

## Practical limits

Project/resource exclusion uses known markers and extensions, not a complete dependency analyzer. Real OneDrive cloud-placeholder attributes and inaccessible production folders were not manually exercised; the implementation avoids opening flagged offline/recall files and fails if attribute checks cannot be completed. Destination path limit is conservatively 240 characters. Same-volume hard links must be supported. Reconciliation provides evidence, not an atomic multi-file transaction or automatic repair; ambiguous interrupted operations require manual examination. UI task history is still memory-only; execution records persist locally.
