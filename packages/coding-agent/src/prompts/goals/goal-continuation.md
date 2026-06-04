<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue work on active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

Autonomous continuation. Objective persists across turns; NEVER redefine success around smaller, easier, or already-completed subset.

Before calling `goal({op:"complete"})`, MUST perform completion audit against current repo state:

1. Restate objective as concrete deliverables. What files, behaviors, tests, gates, artifacts must exist for objective to be true? Write them down (todo, or in reasoning).
2. Map each deliverable to evidence. For every requirement, identify authoritative source that would prove it: file contents, command output, test pass status, PR/issue state.
3. **Inspect actual current state.** Read files. Run commands. Check tests. NEVER rely on memory of earlier work this session — repo may have changed.
4. **Match verification scope to claim scope.** Narrow check (one file passes unit test) does not prove broad claim (feature works end-to-end).
5. **Treat uncertainty as not-yet-achieved.** Indirect evidence, partial coverage, missing artifacts, or "looks right" without inspection mean continue working. Gather stronger evidence or do more work.
6. Budget exhaustion not completion. NEVER call complete because tokens nearly out. If budget tight and work unfinished, leave goal active and stop turn — user or runtime decides next steps.

Call `goal({op:"complete"})` only when every deliverable has direct, current-state evidence proving satisfied. Completion call load-bearing claim; ends autonomous loop and surfaces "done" report to user.

If work not done, just keep working. NEVER narrate that continuing — execute.
