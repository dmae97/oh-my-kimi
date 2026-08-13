# Addy Osmani agent-skills adaptation

- **Source:** <https://github.com/addyosmani/agent-skills>
- **Pinned commit**: `7829ffd90d973b6325f5f12f1b1226dcace74443`
- **Upstream commit date:** 2026-07-26
- **License:** MIT, Copyright (c) 2025 Addy Osmani. See [`LICENSE-ADDYOSMANI`](LICENSE-ADDYOSMANI).

## Reviewed upstream material

The OMK adaptation was based on the upstream `README.md`, `docs/adoption-guide.md`,
`docs/skill-anatomy.md`, `skills/using-agent-skills/SKILL.md`,
`skills/incremental-implementation/SKILL.md`, `skills/doubt-driven-development/SKILL.md`,
`references/orchestration-patterns.md`, and `evals/README.md` at the pinned commit.
The upstream structural validator and deterministic routing eval both passed before adaptation.

## OMK-specific adaptation

OMK is an established brownfield codebase with existing skill hubs and global engineering skills.
The upstream pack is therefore not copied wholesale. In particular:

- upstream skills that collide with existing `context-engineering`, `test-driven-development`, and
  `using-agent-skills` installations are not duplicated;
- upstream commands, personas, hooks, executable scripts, plugin manifests, and behavioral-eval
  runners are not vendored or executed;
- `omk-engine` keeps OMK's small-loadout routing and adds the upstream verification-first brownfield
  order, thin increments, issue-seeking fresh review, anti-rationalization checks, and a hard
  three-cycle repair/review bound;
- OMK's root coordinator remains the orchestration owner; subagents do not recursively orchestrate.

This is an adapted workflow, not a claim that the full upstream package is bundled with OMK.

## Update procedure

1. Review the new upstream commit and license.
2. Re-run upstream `node scripts/validate-skills.js` and deterministic `node scripts/run-evals.js`.
3. Compare the reviewed source files above and adapt only behavior that fits OMK without skill-name
   collisions.
4. Update this pin, `SKILL.md` metadata, and `scripts/check-vendored-skills.mjs` together.
5. Run `npm run check:vendored-skills` and the OMK harness-graph gate.
