# Contributing to OMK

Thanks for helping improve OMK. Keep reports and changes focused, reproducible, and easy to review.

## Before opening an issue

Search existing issues first, then use the matching issue template.

For bugs, include:

- OMK version and platform
- minimal steps to reproduce
- expected and actual behavior
- the shortest relevant error or log excerpt, with credentials removed

For feature proposals, explain the problem before proposing an implementation. Keep the issue concise and state whether you plan to work on it.

Low-signal, duplicate, unreproducible, or automated spam reports may be closed without extended discussion.

## Before submitting a pull request

For substantial changes, open an issue first so maintainers can confirm scope. Small fixes and documentation corrections may go directly to a pull request.

Run the repository gates from the project root:

```bash
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

All gates must pass. Add or update tests for behavioral changes and update the matching file under `packages/coding-agent/docs/` when public behavior changes.

Do not edit release sections in the root `README.md`; `scripts/sync-readme-releases.mjs` generates them from changelogs. Package changelog entries are maintained as part of the release process.

If you add a provider under `packages/ai`, follow the provider test requirements in `AGENTS.md`.

## AI-assisted contributions

AI assistance is welcome, but you must understand and be able to explain every submitted change. Review generated code, remove irrelevant output, run the full verification suite, and never include credentials or private session data.

## Scope

OMK keeps its core focused. Workflow-specific behavior should usually be an extension, skill, or OMK package. Pull requests that add broad complexity without a clear core requirement may be declined.

## Review expectations

Maintainers prioritize correctness, security, compatibility, and evidence. Reviews may request a smaller change, stronger tests, or clearer documentation before merge.

## Questions

Ask on [Discord](https://discord.com/invite/nKXTsAcmbT).
