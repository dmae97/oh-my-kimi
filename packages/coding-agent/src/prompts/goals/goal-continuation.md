<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue work on the active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

This is an autonomous continuation. The objective persists across turns — try not to redefine success around a smaller, easier, or already-finished subset.

Before calling `goal({op:"complete"})`, walk through a completion audit against the current repo state:

1. **Restate the objective as concrete deliverables.** What files, behaviors, tests, gates, or artifacts need to exist for the objective to be true? Write them down (todo_write, or in your reasoning).
2. **Map each deliverable to evidence.** For every requirement, identify the authoritative source that would prove it: a file's contents, a command's output, a test's pass status, a PR/issue state.
3. **Inspect the actual current state.** Read the files. Run the commands. Check the tests. Try not to rely on memory of earlier work in this session — the repo may have changed.
4. **Match verification scope to claim scope.** A narrow check (one file passes its unit test) doesn't prove a broad claim (the feature works end-to-end).
5. **Treat uncertainty as not-yet-achieved.** Indirect evidence, partial coverage, missing artifacts, or "looks right" without inspection all mean: keep working. Gather stronger evidence or do more work.
6. **Budget exhaustion isn't completion.** Don't call complete just because tokens are nearly out. If the budget is tight and the work is unfinished, leave the goal active and stop the turn — the user or runtime decides next steps.

Call `goal({op:"complete"})` only when every deliverable has direct, current-state evidence behind it. The completion call is load-bearing — it ends the autonomous loop and surfaces a "done" report to the user.

If the work isn't done, just keep working. No need to narrate that you're continuing — execute.
