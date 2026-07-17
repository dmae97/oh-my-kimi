# Magic keywords

Magic keywords are standalone words in a user prompt that add a hidden instruction for that turn. They are enabled by default and glow in the editor when `omp` recognizes them.

## Keywords

| Keyword | Effect |
|---|---|
| `ultrathink` | Asks the agent to reason carefully through a multi-step task. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn. |
| `orchestrate` | Switches the agent to the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete. |
| `workflowz` | Asks the agent to build and run a deterministic multi-subagent workflow with the `task` tool. It is intended for broad research, reviews, migrations, or other work that benefits from parallel coverage. The keyword only adds its instruction when `task` is available in the active tool set. |

Use the keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes
```

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink`, `Orchestrate`, and `Workflowz` do not trigger.
- The keyword must be standalone. Sentence punctuation may touch it, but identifiers, inflections, paths, and file extensions do not match. For example, `orchestrate,` matches; `orchestrated` and `orchestrate.ts` do not.
- Fenced code blocks, inline code spans, and XML/HTML sections are ignored.
- The instruction applies to the user turn containing the keyword. The highlighted word remains part of the visible prompt; the added instruction is hidden.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change the settings from a shell:

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
```

All four settings default to `true`. Run `omp config list` to inspect every available setting and its current value. See [Settings](./settings.md) for configuration scopes, precedence, and project-local overrides.
