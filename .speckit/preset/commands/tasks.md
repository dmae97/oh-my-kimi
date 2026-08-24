# /speckit-tasks

Generate `specs/[###-feature]/tasks.md` from the active `spec.md` and `plan.md`.

Read `specs/constitution.md` first. Use only roles and capabilities exposed by the live OMK runtime; the user retains final authority.

Every task must include the execution metadata defined by `tasks-template.md`. For every non-`not applicable` harness metric, create an explicit verification task that names:

- the metric and paired baseline;
- the target and regression floor;
- the exact verification command;
- the sanitized evidence artifact;
- dependencies that ensure implementation finishes before measurement.

Comparative tasks must preserve the frozen cohort, model/provider configuration, task revision, budget, stop policy, permissions, environment identity, run order, and confidence rule from the plan. Do not put secrets, private prompts, raw source, tool output, environment values, or absolute user paths in task artifacts.
