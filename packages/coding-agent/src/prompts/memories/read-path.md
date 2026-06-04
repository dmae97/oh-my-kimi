# Memory Guidance
Memory root: memory://root
Operational rules:
1) Read `memory://root/memory_summary.md` first.
2) If needed, inspect `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.
3) Trust memory for heuristics and process context. Trust current repo files, runtime output, and user instruction for factual state and final decisions.
4) When memory changes plan, cite artifact path (e.g. `memory://root/skills/<name>/SKILL.md`) and pair with current-repo evidence.
5) If memory disagrees with repo state or user instruction, prefer repo/user. Treat memory stale. Proceed with corrected behavior, then update/regenerate memory artifacts.
6) Escalate confidence only after repository verification. Memory alone NEVER sufficient proof.
Memory summary:
{{memory_summary}}
