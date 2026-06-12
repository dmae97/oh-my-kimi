# Session tree architecture (current)

Reference: [session.md](../docs/session.md)

This document describes how session tree navigation works today: in-memory tree model, leaf movement rules, branching behavior, and extension/event integration.

## What this subsystem is

The session is stored as an append-only entry log, but runtime behavior is tree-based:

- Every non-header entry has `id` and `parentId`.
- The active position is `leafId` in `SessionManager`.
- Appending an entry always creates a child of the current leaf.
- Branching does **not** rewrite history; it only changes where the leaf points before the next append.

Key files:

- `src/session/session-manager.ts` — tree data model, traversal, leaf movement, branch/session extraction
- `src/session/agent-session.ts` — `/tree` navigation flow, summarization, hook/event emission
- `src/modes/components/tree-selector.ts` — interactive tree UI behavior and filtering
- `src/modes/controllers/selector-controller.ts` — selector orchestration for `/tree` and `/branch`
- `src/slash-commands/builtin-registry.ts` — command routing (`/tree`, `/branch`)
- `src/modes/controllers/input-controller.ts` — double-escape behavior and `app.session.tree`/`app.session.fork` keybinding wiring
- `src/session/messages.ts` — conversion of `branch_summary`, `compaction`, and `custom_message` entries into LLM context messages

## Tree data model in `SessionManager`

Runtime indices:

- `#byId: Map<string, SessionEntry>` — fast lookup for any entry
- `#leafId: string | null` — current position in the tree
- `#labelsById: Map<string, string>` — resolved labels by target entry id

Tree APIs:

- `getBranch(fromId?)` walks parent links to root and returns root→node path
- `getTree()` returns `SessionTreeNode[]` (`entry`, `children`, `label`)
  - parent links become children arrays
  - entries with missing parents are treated as roots
  - children are sorted oldest→newest by timestamp
- `getChildren(parentId)` returns direct children
- `getLabel(id)` resolves current label from `labelsById`

`getTree()` is a runtime projection; persistence remains append-only JSONL entries.

## Leaf movement semantics

There are three leaf movement primitives:

1. `branch(entryId)`
   - Validates entry exists
   - Sets `leafId = entryId`
   - No new entry is written

2. `resetLeaf()`
   - Sets `leafId = null`
   - Next append creates a new root entry (`parentId = null`)

3. `branchWithSummary(branchFromId, summary, details?, fromExtension?)`
   - Accepts `branchFromId: string | null`
   - Sets `leafId = branchFromId`
   - Appends a `branch_summary` entry as child of that leaf
   - When `branchFromId` is `null`, `fromId` is persisted as `"root"`

## `/tree` navigation behavior (same session file)

`AgentSession.navigateTree()` is navigation, not file forking.

Flow:

1. Validate target and compute abandoned path (`collectEntriesForBranchSummary`)
2. Emit `session_before_tree` with `TreePreparation`
3. Optionally summarize abandoned entries (hook-provided summary or built-in summarizer)
4. Compute new leaf target:
   - selecting a **user** message: leaf moves to its parent, and message text is returned for editor prefill
   - selecting a **custom_message**: same rule as user message (leaf = parent, text prefills editor)
   - selecting any other entry: leaf = selected entry id
5. Apply leaf move:
   - with summary: `branchWithSummary(newLeafId, ...)`
   - without summary and `newLeafId === null`: `resetLeaf()`
   - otherwise: `branch(newLeafId)`
6. Rebuild agent context from new leaf and emit `session_tree`

Important: summary entries are attached at the **new navigation position**, not on the abandoned branch tail.

## `/branch` behavior (new session file)

`/branch` and `/tree` are intentionally different:

- `/tree` navigates within the current session file.
- `/branch` creates a new session branch file (or in-memory replacement for non-persistent mode).

User-facing `/branch` flow (`SelectorController.showUserMessageSelector` → `AgentSession.branch`):

- Branch source must be a **user message**.
- Selected user text is extracted for editor prefill.
- If selected user message is root (`parentId === null`): start a new session via `newSession({ parentSession: previousSessionFile })`.
- Otherwise: `createBranchedSession(selectedEntry.parentId)` to fork history up to the selected prompt boundary.

`SessionManager.createBranchedSession(leafId)` specifics:

- Builds root→leaf path via `getBranch(leafId)`; throws if missing.
- Excludes existing `label` entries from copied path.
- Rebuilds fresh label entries from resolved `labelsById` for entries that remain in path.
- Persistent mode: writes new JSONL file and switches manager to it; returns new file path.
- In-memory mode: replaces in-memory entries; returns `undefined`.

## Context reconstruction and summary/custom integration

`buildSessionContext()` (in `session-manager.ts`) resolves the active root→leaf path and builds effective LLM context state:

- Tracks latest thinking/model/service-tier/mode/TTSR/MCP-selection state on path.
- Handles latest compaction on path:
  - emits compaction summary first
  - replays kept messages from `firstKeptEntryId` to compaction point
  - then replays post-compaction messages
- Includes `branch_summary` and `custom_message` entries as `AgentMessage` objects.

`session/messages.ts` then maps these message types for model input:

- `branchSummary` and `compactionSummary` become user-role templated context messages
- `custom`/`hookMessage` become developer-role content messages (via agent-core's `convertMessageToLlm`)

So tree movement changes context by changing the active leaf path, not by mutating old entries.

## Labels and tree UI behavior

Label persistence:

- `appendLabelChange(targetId, label?)` writes `label` entries on the current leaf chain.
- `labelsById` is updated immediately (set or delete).
- `getTree()` resolves current label onto each returned node.

Tree selector behavior (`tree-selector.ts`):

- Flattens tree for navigation, keeps active-path highlighting, and prioritizes displaying the active branch first.
- Supports filter modes: `default`, `no-tools`, `user-only`, `labeled-only`, `all`.
  - `default` suppresses `label`, `custom`, `model_change`, and `thinking_level_change`; it is not a complete "hide all internal entries" filter.
- Supports free-text search over rendered semantic content.
- `Shift+L` opens inline label editing and writes via `appendLabelChange`.

Command routing:

- `/tree` always opens tree selector.
- `/branch` opens user-message selector unless `doubleEscapeAction=tree`, in which case it also uses tree selector UX.

## Extension and hook touchpoints for tree operations

Command-time extension API (`ExtensionCommandContext`):

- `branch(entryId)` — create branched session file
- `navigateTree(targetId, { summarize? })` — move within current tree/file

Events around tree navigation:

- `session_before_tree`
  - receives `TreePreparation`:
    - `targetId`
    - `oldLeafId`
    - `commonAncestorId`
    - `entriesToSummarize`
    - `userWantsSummary`
  - may cancel navigation
  - may provide summary payload used instead of built-in summarizer
  - receives abort `signal` (Escape cancellation path)
- `session_tree`
  - emits `newLeafId`, `oldLeafId`
  - includes `summaryEntry` when a summary was created
  - `fromExtension` indicates summary origin

Adjacent but related lifecycle hooks:

- `session_before_branch` / `session_branch` for `/branch` flow
- `session_before_compact`, `session.compacting`, `session_compact` for compaction entries that later affect tree-context reconstruction

## Real constraints and edge conditions

- `branch()` cannot target `null`; use `resetLeaf()` for root-before-first-entry state.
- `branchWithSummary()` supports `null` target and records `fromId: "root"`.
- Selecting current leaf in tree selector is a no-op.
- Summarization requires an active model; if absent, summarize navigation fails fast.
- If summarization is aborted, navigation is cancelled and leaf is unchanged.
- In-memory sessions never return a branch file path from `createBranchedSession`.
- Tree context reconstruction includes service-tier and MCP tool-selection state, but those entries do not become LLM messages.

## Plan approval session naming

When a user approves a plan from plan mode (`InteractiveMode.#approvePlan`), the approval handler seeds the session name from the plan's title so the resulting (fresh or compacted) session does not stay unnamed.

Trigger:

- Plan approval reaches `#approvePlan(...)` with `options.title` populated from the plan-approval details.
- This runs for every approval choice (`Approve and execute`, `Approve and compact context`, plain `Approve`); the synthetic `plan-approved` prompt is what otherwise bypasses the input-controller's title-generation path.

Naming source:

- The normalized plan title is humanized via `humanizePlanTitle(title)` (`packages/coding-agent/src/plan-mode/approved-plan.ts`):
  - replaces runs of `-`/`_` with a single space
  - trims whitespace
  - capitalizes the first character
  - returns `""` for whitespace-only / separator-only input
- The humanized name is applied only when the current session has no name (`!sessionManager.getSessionName()`). It then calls `sessionManager.setSessionName(name, "auto")`, which also refuses to overwrite user-named sessions.
- On successful apply, the terminal title (`setSessionTerminalTitle`) and the editor border color are refreshed to reflect the new name.

Examples (from `humanizePlanTitle`):

- `migrate-mcp-loader` → `Migrate mcp loader`
- `fix_session_naming` → `Fix session naming`
- `foo--bar__baz` → `Foo bar baz`
- `RefactorRouter` → `RefactorRouter` (no separators to expand)
- `""` / `"---"` → `""` (no name applied)

## Legacy compatibility still present

Session migrations still run on load:

- v1→v2 adds `id`/`parentId` and converts compaction index anchor to id anchor
- v2→v3 migrates legacy `hookMessage` role to `custom`

Current runtime behavior is version-3 tree semantics after migration.
