<system-notice>
The user's message above contains the **workflowz** keyword: drive this task as a deterministic multi-subagent workflow. Use the `task` tool {{#if taskBatch}}for batched fan-out{{else}}once per independent subagent{{/if}} — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before you commit), or to take on scale one context can't hold (audits, migrations, broad sweeps). This overrides any default tendency to do the whole task inline when fanning out would be more thorough.

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before you commit. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline first (list the files, scope the diff, find the call sites) to discover the work list, then fan out over it. Common shapes:
- **Understand** — parallel readers over subsystems → structured map.
- **Design** — independent approaches → scored synthesis.
- **Review** — split dimensions → find per dimension → adversarially verify each finding.
- **Research** — multi-modal sweep → deep-read the hits → synthesize.
- **Migrate** — discover sites → transform each → verify.
</when>

<task-contract>
{{#if taskBatch}}
Call `task` once per independent fan-out batch. Put shared background in `context`, and put each independent work item in `tasks[]`. Do not emulate batching with shell loops or eval helper APIs.

`context` must carry the shared contract:

    # Goal
    What the batch accomplishes.
    # Constraints
    Rules, non-goals, permissions, and verification limits.
    # Contract
    Shared interfaces, output shape, branch/base assumptions, and coordination rules.

Each task assignment must be self-contained:

    # Target
    Exact files, symbols, subsystem, or evidence surface; explicit non-goals.
    # Change
    What to inspect or modify, step by step, including APIs and patterns to reuse.
    # Acceptance
    Observable result, return packet, and local verification. Subagents skip formatters,
    linters, and project-wide tests; the parent runs shared proof once.
{{else}}
Call `task` once per independent subagent. Put the full shared background and the leaf work in that call's `assignment`. Do not pass `context` or `tasks[]`: the flat task schema rejects them when batch calls are disabled.

Each assignment must be self-contained:

    # Target
    Exact files, symbols, subsystem, or evidence surface; explicit non-goals.
    # Change
    Shared background plus what to inspect or modify, step by step, including APIs and patterns to reuse.
    # Acceptance
    Observable result, return packet, and local verification. Subagents skip formatters,
    linters, and project-wide tests; the parent runs shared proof once.
{{/if}}

<structure>
Decompose first, then {{#if taskBatch}}batch the independent leaves{{else}}issue one independent task call per leaf in the same turn{{/if}}:

{{#if taskBatch}}
    task(
      context: "# Goal\nReview the auth diff…\n# Constraints\nRead-only…\n# Contract\nReturn findings as severity/file/line/fix…",
      tasks: [
        { id: "AuthOwner", role: "Auth Storage Reviewer", assignment: "# Target\npackages/ai/src/auth-storage.ts\n# Change\nTrace credential selection…\n# Acceptance\nReturn confirmed findings only…" },
        { id: "PromptOwner", role: "Prompt Contract Reviewer", assignment: "# Target\npackages/coding-agent/src/prompts/**\n# Change\nCheck active-tool guidance…\n# Acceptance\nReturn mismatches and exact prompt lines…" },
      ]
    )
{{else}}
    task(
      role: "Auth Storage Reviewer",
      assignment: "# Target\npackages/ai/src/auth-storage.ts\n# Change\nReview the auth diff. Shared contract: read-only; return findings as severity/file/line/fix.\n# Acceptance\nReturn confirmed findings only…"
    )
    task(
      role: "Prompt Contract Reviewer",
      assignment: "# Target\npackages/coding-agent/src/prompts/**\n# Change\nCheck active-tool guidance. Shared contract: read-only; return mismatches and exact prompt lines.\n# Acceptance\nReturn confirmed findings only…"
    )
{{/if}}

{{#if taskBatch}}Prefer one wide batch over serial subagent calls when work items do not share files. If tasks overlap, name the overlap and have agents coordinate through IRC before editing.{{else}}Prefer issuing all independent task calls in one assistant turn over serial dispatch when work items do not share files. If tasks overlap, name the overlap and have agents coordinate through IRC before editing.{{/if}}
</structure>

<patterns>
- **Adversarial verify** — dispatch skeptical reviewers with distinct targets, then keep only findings the parent can verify against source.
- **Perspective-diverse review** — use separate correctness, security, performance, and maintainability roles instead of identical reviewers.
- **Completeness critic** — after the first batch, dispatch one read-only critic that asks what modality, file, claim, or proof was missed.
- **No silent caps** — if you bound coverage (top-N, no retry, sampling), state what was dropped and why before acting.
- **Parent owns closure** — subagents return evidence; the parent reads it, resolves contradictions, runs proof, and makes the final decision.
</patterns>

<execution>
- Capture multi-phase workflow state in the visible todo system when available.
{{#if taskBatch}}- Batch independent subagents in one `task` call.{{else}}- Dispatch independent subagents as separate `task` calls in the same turn.{{/if}}
- Give every subagent a narrow target, explicit non-goals, and a concrete return packet.
- After fan-out returns, read the artifacts, patch or decide, and run the shared gate.
- Keep going until the task is closed — returned fan-out is a step, not a stopping point.
</execution>
</system-notice>
