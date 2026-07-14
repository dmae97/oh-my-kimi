Before you consider this task finished, verify:

- Consistency: if you changed a pattern, signature, or check in one place, grep for every other call site or duplicate copy that needs the identical change. A fix applied to only some of the matching sites is still a failure.
- Scope: if your diff does more than the minimal change needed to resolve the issue, confirm you have not altered behavior for any case outside the reported issue. Prefer the smallest correct diff over a broader rewrite.
- Verification: run the full test module or file the issue lives in, not just the one test you expect to flip. A change that breaks a sibling test is not a fix.

Do not claim the task is complete until you have done these three checks.
