# Public Skills

OMK currently publishes **24 project-local skills** in this repository under [`.omk/skills`](.omk/skills). When OMK runs from a repository checkout, it discovers these skills automatically and loads them on demand.

These repository skills are **not bundled into the `open-multi-agent-kit` npm package**. The package publishes only the paths declared in [`packages/coding-agent/package.json`](packages/coding-agent/package.json). See the [skills documentation](packages/coding-agent/docs/skills.md) for discovery rules and packaging your own skills.

Invoke any available skill with `!skill:<name>` or `/skill:<name>`. `caveman` is explicit-only; the others may be selected when their descriptions match the task.

## OMK workflows

| Skill | Purpose |
| --- | --- |
| [`add-llm-provider`](.omk/skills/add-llm-provider.md) | Checklist for adding and wiring a new LLM provider. |
| [`clone-website`](.omk/skills/clone-website/SKILL.md) | Reverse-engineer and rebuild websites with bounded parallel builders. |
| [`omk-computeruse`](.omk/skills/omk-computeruse/SKILL.md) | Route desktop, browser, Stagehand, and WSL-to-Windows computer-use tasks. |
| [`reverse-skill`](.omk/skills/reverse-skill/SKILL.md) | Route and adapt reverse-engineering and security workflow packs. |

## Output style

| Skill | Purpose |
| --- | --- |
| [`caveman`](.omk/skills/caveman/SKILL.md) | Explicit-only compressed response style with six brevity levels. |

## Ponytail

| Skill | Purpose |
| --- | --- |
| [`ponytail`](.omk/skills/ponytail/SKILL.md) | Prefer the smallest implementation that works. |
| [`ponytail-audit`](.omk/skills/ponytail-audit/SKILL.md) | Audit an entire repository for removable complexity. |
| [`ponytail-debt`](.omk/skills/ponytail-debt/SKILL.md) | Collect `ponytail:` comments into a debt ledger. |
| [`ponytail-gain`](.omk/skills/ponytail-gain/SKILL.md) | Display Ponytail's benchmark impact summary. |
| [`ponytail-help`](.omk/skills/ponytail-help/SKILL.md) | Show the Ponytail command and mode reference. |
| [`ponytail-review`](.omk/skills/ponytail-review/SKILL.md) | Review a change specifically for over-engineering. |

## Taste skill pack

| Skill | Purpose |
| --- | --- |
| [`brandkit`](.omk/skills/taste-skill/skills/brandkit/SKILL.md) | Create premium brand-system and identity-board imagery. |
| [`design-taste-frontend`](.omk/skills/taste-skill/skills/taste-skill/SKILL.md) | Build anti-generic landing pages, portfolios, and redesigns. |
| [`design-taste-frontend-v1`](.omk/skills/taste-skill/skills/taste-skill-v1/SKILL.md) | Preserve the original v1 frontend taste workflow. |
| [`full-output-enforcement`](.omk/skills/taste-skill/skills/output-skill/SKILL.md) | Require complete output without placeholders or silent truncation. |
| [`gpt-taste`](.omk/skills/taste-skill/skills/gpt-tasteskill/SKILL.md) | Build editorial interfaces with advanced GSAP motion. |
| [`high-end-visual-design`](.omk/skills/taste-skill/skills/soft-skill/SKILL.md) | Apply premium typography, spacing, surfaces, and motion. |
| [`image-to-code`](.omk/skills/taste-skill/skills/image-to-code-skill/SKILL.md) | Generate and analyze design references before implementing them. |
| [`imagegen-frontend-mobile`](.omk/skills/taste-skill/skills/imagegen-frontend-mobile/SKILL.md) | Generate premium mobile app screen concepts and flows. |
| [`imagegen-frontend-web`](.omk/skills/taste-skill/skills/imagegen-frontend-web/SKILL.md) | Generate one implementation-ready design image per web section. |
| [`industrial-brutalist-ui`](.omk/skills/taste-skill/skills/brutalist-skill/SKILL.md) | Design mechanical Swiss and military-terminal interfaces. |
| [`minimalist-ui`](.omk/skills/taste-skill/skills/minimalist-skill/SKILL.md) | Design clean editorial interfaces with restrained styling. |
| [`redesign-existing-projects`](.omk/skills/taste-skill/skills/redesign-skill/SKILL.md) | Upgrade existing interfaces without breaking functionality. |
| [`stitch-design-taste`](.omk/skills/taste-skill/skills/stitch-skill/SKILL.md) | Generate premium `DESIGN.md` systems for Google Stitch. |

## Distribution and provenance

- **Public repository:** all 24 skills above are tracked in Git.
- **Repository checkout:** OMK discovers them as project-local skills.
- **npm package:** none of these root-level `.omk/skills` files are currently included in `open-multi-agent-kit`.
- **Vendored content:** [`taste-skill`](.omk/skills/taste-skill/SOURCE.md), [`caveman`](.omk/skills/caveman/SOURCE.md), [`ponytail`](.omk/skills/ponytail/SKILL.md), and [`clone-website`](.omk/skills/clone-website/LICENSE-THIRD-PARTY) retain their source and license notices.
- **Excluded from this inventory:** machine-local skills, test fixtures, examples, scratch data, goal snapshots, and worktrees.
