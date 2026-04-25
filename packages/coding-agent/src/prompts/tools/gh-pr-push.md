Pushes a checked-out pull request branch back to its source branch through local git.

<instruction>
- Defaults to the current checked-out git branch
- Requires branch metadata recorded by `gh_pr_checkout`; fail instead of pushing if the branch was not checked out with `gh_pr_checkout`
- Pushes back to the contributor fork and PR head branch recorded in that metadata
- Use `forceWithLease` only when rewriting the branch intentionally
</instruction>

<output>
Returns the local branch, remote, remote branch, and push target that were used.
</output>
