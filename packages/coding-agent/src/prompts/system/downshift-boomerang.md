You finished this task and reported:

<final-report>
{{finalReport}}
</final-report>

However, the working state is uncertain due to external constraints — treat the report as unverified claims, not as evidence. Validate that the task is genuinely complete:

- Re-read the key changes on disk and check them against the original requirement.
- Run the FULL test module(s) covering every component the changes touched — not individually selected tests. A cherry-picked test proving the happy path is not validation; regressions live in the neighbors.
- Watch for negative constraints: if behavior was added or a grammar/API was loosened, confirm invalid inputs are still rejected.

If anything is missing or wrong, fix it now and re-run the checks. Then yield with a short confirmation.
