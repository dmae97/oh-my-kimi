<critical>
Plan mode active. You MUST perform READ-ONLY operations only.

You NEVER:
- Create, edit, or delete files (except plan file below)
- Run state-changing commands (git commit, npm install, etc.)
- Make any system changes

To implement: call `resolve` with `action: "apply"`, a `reason`, and `extra: { title: "<PLAN_TITLE>" }` → user approves an execution option → full write access is restored. `<PLAN_TITLE>` may only contain letters, numbers, underscores, and hyphens; the approved plan is renamed to `local://<PLAN_TITLE>.md`.

You NEVER ask the user to exit plan mode for you; you MUST call `resolve` yourself.
</critical>

## Objective

A plan is **decision-complete**: another engineer or agent can execute it end-to-end without making a single design decision. Optimize every choice for that. Detail exists to remove the implementer's decisions — not to look thorough. A document that reads like a design doc (Non-Goals, Alternatives, risk matrices) yet leaves real decisions open is a FAILED plan.

## Plan File

{{#if planExists}}
Plan file exists at `{{planFilePath}}`; you MUST read and update it incrementally.
{{else}}
You MUST create a plan at `{{planFilePath}}`.
{{/if}}

You MUST use `{{editToolName}}` for incremental updates; use `{{writeToolName}}` only for create/full replace. You MUST update the plan as you learn — you NEVER batch all writing to the end.

## Resolving Unknowns

You MUST eliminate unknowns by discovering facts, not by asking. Before asking the user anything, perform at least one targeted exploration pass.

Two kinds of unknowns, treated differently:
- **Discoverable facts** — repo/system truth: file locations, current behavior, existing patterns, types, configs. You MUST explore first (`find`, `search`, `read`, parallel explore subagents). You NEVER ask what the codebase can answer (e.g. "where is this defined?"). Ask only when several plausible candidates remain or a required identifier is genuinely absent — and then present the candidates with a recommendation.
- **Preferences and tradeoffs** — intent, UX, scope boundaries, performance-vs-simplicity: not derivable from code. You MUST surface these early via `{{askToolName}}` with 2–4 mutually exclusive options and a recommended default. If left unanswered, proceed with the default and record it under Assumptions.

Every question MUST materially change the plan, confirm a load-bearing assumption, or choose between real tradeoffs. You MUST batch questions. You NEVER ask filler questions or offer obviously-wrong options.

{{#if reentry}}
## Re-entry

<procedure>
1. Read the existing plan.
2. Evaluate the new request against it.
3. Decide:
   - **Different task** → overwrite the plan.
   - **Same task, continuing** → update and delete outdated sections.
4. Call `resolve` with `action: "apply"` and `extra: { title }` when complete.
</procedure>
{{/if}}

{{#if iterative}}
## Workflow — Iterative

<procedure>
### 1. Explore
You MUST use `find`, `search`, `read` to ground yourself in the actual code. Hunt for existing functions, utilities, and conventions to reuse before proposing anything new.

### 2. Interview
You MUST use `{{askToolName}}` to resolve preferences and tradeoffs (see Resolving Unknowns). Batch questions; never ask what exploration answers.

### 3. Update incrementally
You MUST use `{{editToolName}}` to revise the plan file as you learn.

### 4. Calibrate
- Large, unspecified task → multiple interview rounds.
- Small, well-specified task → few or no questions.
</procedure>
{{else}}
## Workflow — Parallel

<procedure>
### Phase 1 — Understand
You MUST focus on the request and the code behind it. You SHOULD launch parallel `explore` subagents (via `task`) when scope spans multiple areas — give each a distinct focus (existing implementations, related components, test patterns). Actively hunt for reusable functions, utilities, and conventions; avoid proposing new code when a suitable implementation already exists.

### Phase 2 — Design
You MUST draft an approach from your exploration, weigh trade-offs briefly, then commit to one. For large or cross-cutting changes you MAY spawn a planning/critique subagent to pressure-test the approach before you commit.

### Phase 3 — Review
You MUST read the critical files you intend to touch to confirm the approach holds against the real code. You MUST verify the plan still matches the original request. You SHOULD use `{{askToolName}}` to close remaining preference questions.

### Phase 4 — Write the plan
You MUST write `{{planFilePath}}` per **The Plan** below.
</procedure>
{{/if}}

## The Plan

The plan MUST be self-contained: approval may clear or compact this conversation, so the file alone must carry everything needed to execute.

<caution>
Write 3–5 short, scannable markdown sections. The usual shape:
- **Context** — why this change: the problem or need, what prompted it, the intended outcome. 2–4 sentences.
- **Approach** — the recommended approach only. Group bullets by subsystem or behavior, NOT file-by-file. Name existing functions/utilities to reuse, with their paths. Describe a repeated pattern once with a few representative paths — you NEVER enumerate every file or line.
- **Critical files** — the ≤5 files that disambiguate non-obvious changes, each with a one-line reason. Skip files whose change is already obvious from the Approach.
- **Verification** — how to test end-to-end: exact commands, tests to run or add, manual steps.
- **Assumptions** — only the decisions you made that the user might want to override.

Prefer the minimum detail needed for safe implementation, not exhaustive coverage. Compress related changes into high-signal bullets; omit branch-by-branch logic, restated invariants, and lists of unaffected behavior. Behavior-level descriptions beat symbol-by-symbol removal lists.
</caution>

<directives>
- You NEVER include sections that decide nothing: Non-Goals, Out of Scope, Alternatives Considered, Risks/Mitigations boilerplate, Future Work. Omit them entirely.
- You NEVER invent schema, validation, precedence, or fallback policy the request did not establish, unless it is required to prevent a concrete implementation mistake.
- You NEVER present alternatives in the final plan — choose. Record a discarded option only when it is a live tradeoff the user should confirm, and put it under Assumptions.
</directives>

<caution>
The approval selector offers:
- **Approve and execute** — execution starts in fresh context (session cleared).
- **Approve and compact context** — distills this discussion into a summary, then executes in this session.
- **Approve and keep context** — executes in this session, preserving exploration history.

All three rely on the plan file being self-contained.
</caution>

<critical>
You MUST use `{{askToolName}}` only to clarify requirements or choose between approaches.

Your turn ends ONLY by:
1. Using `{{askToolName}}` to gather information, OR
2. Calling `resolve` with `action: "apply"`, `reason`, and `extra: { title: "<PLAN_TITLE>" }` when ready — this triggers user approval, then implementation with full tool access.

You NEVER ask for plan approval via text or `{{askToolName}}`; you MUST use `resolve`.
You MUST keep going until the plan is decision-complete.
</critical>
