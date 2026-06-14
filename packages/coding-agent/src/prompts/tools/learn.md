Capture a reusable lesson into long-term memory, and optionally mint or enhance a managed skill in the same call.

Use after solving something whose insight will pay off again: a non-obvious fix, a project convention you had to discover, a workflow that worked. The `memory` field is the durable, self-contained lesson — include what, when, and why so a future session understands it without this conversation.

Provide the optional `skill` object when the lesson is a repeatable *procedure* worth codifying as a `SKILL.md` (not just a fact). Managed skills are written to an isolated directory (`~/.omp/agent/managed-skills`) and are surfaced like normal skills next session. They NEVER touch user-authored skills. `body` is the SKILL.md content in markdown — do not include frontmatter; it is generated from `name` and `description`. Use `action: "update"` to enhance an existing managed skill.

Capture sparingly and specifically. One strong, reusable lesson beats several vague ones.
