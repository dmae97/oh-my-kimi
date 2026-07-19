# Product Marketing Context

*Last updated: 2026-07-14*
*Status: evidence-backed V1 auto-draft; founder review required for assumptions and open questions.*

## Product Overview

**One-liner:** Run the coding agents you already use. Ship only with evidence.

**What it does:** OMK is a provider-neutral control layer for Codex, Claude Code, OpenCode, and local coding agents. It routes bounded goals into scoped DAG lanes, coordinates tools and MCP workflows, and requires declared predicates plus fresh evidence before completion. It is not a model and does not replace the user's existing agent subscriptions.

**Product category:** Coding-agent orchestration and verification layer.

**Product type:** Open-source, local-first developer tool and terminal CLI.

**Business model:** The repository and npm package are MIT-licensed and free. No OMK paid tier, revenue model, or commercial customer base is evidenced in the reviewed public materials. AdaptOrch is a separate proprietary service and must not be presented as the same product.

**Primary conversion action:** Install `open-multi-agent-kit`, launch `omk`, authenticate a provider, and complete one evidence-gated task.

## Target Audience

**Target companies:** Developer-tool teams, AI infrastructure teams, platform engineering groups, and software organizations experimenting with more than one coding agent. Initial focus should remain individual maintainers and small technical teams because enterprise procurement, support, and security evidence are not yet public.

**Decision-makers:** Staff/principal engineers, developer-experience leads, AI platform leads, engineering managers, and technical founders.

**Primary use case:** Coordinate multiple coding-agent runtimes without losing task scope, execution evidence, or operator control.

**Jobs to be done:**
- Route a complex coding objective into explicit parallel or sequential lanes.
- Keep Codex, Claude Code, OpenCode, and local agents interchangeable where practical.
- Know why a task is considered complete through predicates and fresh evidence.
- Recover from ordinary failures without silently bypassing policy or replaying uncertain effects.
- Preserve inspectable artifacts for debugging, review, and handoff.

**Use cases:**
- Multi-agent implementation with non-overlapping owned paths.
- Evidence-gated bug fixes and release preparation.
- Provider-neutral coding workflows across local and hosted agents.
- MCP-backed workflows with explicit boundaries and receipts.
- Reproducible agent evaluations and failure analysis.

## Personas

| Persona | Cares about | Challenge | Value we promise |
| --- | --- | --- | --- |
| Operator / senior developer | Fast execution without losing control | Agent output looks complete but lacks proof | Declared completion predicates, fresh evidence, and replayable artifacts |
| Staff/platform engineer | Repeatable workflows across teams and providers | Every agent has a different runtime and integration surface | One provider-neutral control layer with scoped tools, MCP, and lanes |
| Engineering manager / technical founder | Throughput, reliability, and reviewability | Parallel agents can multiply noise and hidden failure | Bounded DAG execution and an operator-visible verification model |
| AI tooling maintainer | Extensibility and provider choice | Custom glue code becomes another unreviewed orchestrator | Packageable skills/extensions plus a consistent runtime surface |
| Security/platform influencer | Honest boundaries and auditability | “Agent permissions” are often vague or overstated | Explicit evidence and containerization guidance; no false claim of built-in OS isolation |

## Problems & Pain Points

**Core problem:** Coding agents execute quickly, but teams struggle to coordinate several of them, constrain side effects, and determine whether the output is actually complete.

**Why alternatives fall short:**
- A single agent may be effective but remains tied to one runtime, provider, or interaction model.
- Ad hoc shell scripts can parallelize work but do not provide a durable predicate/evidence contract.
- Generic multi-agent claims do not prove scoped ownership, recovery behavior, or why completion is valid.
- Visual control centers and automation platforms can coordinate agents, but OMK's strongest public distinction is the combined verification story: declared predicates, scoped lanes, replayable artifacts, and tamper-evident evidence.

**What it costs them:** Review time, duplicated work, flaky handoffs, silent incomplete tasks, and reduced trust in autonomous execution. No quantified cost claim is currently supported.

**Emotional tension:** “The agents are moving fast, but I cannot tell what they changed, whether they proved it, or what will happen when one lane fails.”

## Competitive Landscape

**Direct:**
- [OpenHands Agent Canvas](https://github.com/OpenHands/OpenHands) — closest “developer control center” positioning, multiple agents/backends, and automations. OMK must differentiate on bounded delivery and verification rather than generic control-plane language.
- [Cline](https://github.com/cline/cline) — broad IDE/CLI/SDK/Kanban surface with parallel agents, teams, checkpoints, approvals, and plugins.

**Secondary:**
- [OpenCode](https://github.com/anomalyco/opencode) — polished open-source terminal/desktop coding agent with providers and subagents.
- [goose](https://github.com/aaif-goose/goose) — provider-neutral general agent with MCP breadth.
- GitHub Copilot cloud agent — GitHub-native issue-to-PR execution and enterprise distribution.

**Indirect / execution engines:**
- Codex, Claude Code, and Gemini CLI. OMK should usually position these as workers it coordinates, not products users must abandon.
- Hand-written scripts, tmux sessions, and manual copy/paste between agents.

**Competitive evidence boundary:** These comparisons use official public messaging retrieved on 2026-07-14. They do not prove feature absence or benchmark superiority.

## Differentiation

**Key differentiators:**
- Existing-agent coexistence: Codex, Claude Code, OpenCode, and local agents remain execution engines.
- Goal-to-DAG execution with explicit lane ownership and bounded parallelism.
- Declared acceptance predicates and fresh evidence before completion.
- Replayable artifacts and a tamper-evident evidence ledger.
- Skills, extensions, tools, MCP workflows, and hooks controlled from one operator surface.
- Provider-neutral routing without claiming providers are behaviorally identical.

**How we do it differently:** OMK wraps execution in an explicit control and evidence model instead of selling another model-specific coding agent.

**Why that is better:** The operator can inspect scope, progress, receipts, blockers, and completion evidence while retaining provider choice.

**Why customers choose us:** This is not yet supported by interviews or customer testimonials. The best current signals are three external issue authors describing concrete runtime problems and 122 GitHub stars; both indicate evaluation/interest, not proven purchase or retention.

## Objections

| Objection | Response |
| --- | --- |
| “Why not just use Codex or Claude Code directly?” | Continue using them. OMK is the orchestration and verification layer around those agents when the task needs more structure. |
| “This sounds over-engineered for normal coding.” | It is not for every prompt. Use direct agent interaction for simple tasks and OMK for multi-step work where evidence, recovery, or parallel ownership matter. |
| “Does lane scoping sandbox my machine?” | No. OMK runs with the launching user's permissions. Use a container or sandbox when stronger filesystem/process/network boundaries are required. |
| “Is this another proprietary agent platform?” | The OMK repository and npm package are MIT-licensed. Provider accounts and separate services retain their own terms. |
| “Do the npm downloads prove adoption?” | No. 87.69% of observed downloads occurred on release days. Downloads are delivery events, not unique users. |
| “Can I trust a young project with many releases?” | Evaluate the current release through the quickstart and evidence artifacts. Version lineage, release checksums, docs availability, and stability remain explicit improvement areas. |

**Anti-persona:**
- Someone wanting a single zero-configuration coding chatbot.
- Teams requiring a vendor-certified OS sandbox or enterprise SLA today.
- Buyers expecting proven benchmark superiority, large-customer references, or mature retention data.
- Users who do not need multi-step orchestration, provider choice, or verification evidence.

## Switching Dynamics

**Push:** Agent-specific workflows, manual coordination, unverifiable completion, duplicated glue code, and difficult recovery after partial failure.

**Pull:** Keep existing agents while adding bounded DAG execution, visible evidence, and one extensible control surface.

**Habit:** Existing subscriptions, IDE muscle memory, single-agent prompt workflows, and scripts that appear “good enough.”

**Anxiety:** Setup complexity, project maturity, security boundaries, provider compatibility, frequent releases, and whether orchestration adds more overhead than it removes.

**Switching strategy:** Do not ask users to replace their agent. Ask them to route one task that currently requires two agents, manual review, or repeated verification through OMK and compare the resulting evidence.

## Customer Language

**How users describe the problem — verified public issue language:**
- “Chat Session Ended problem” — [issue #13](https://github.com/dmae97/omk/issues/13)
- “false warnings when custom provider configured via config.toml” — [issue #9](https://github.com/dmae97/omk/issues/9)
- “Adjustable timeouts and execution limits” — [issue #6](https://github.com/dmae97/omk/issues/6)

These are issue titles from three non-owner accounts, not testimonials or representative customer research.

**How we describe the solution:**
- “Run the coding agents you already use. Ship only with evidence.”
- “Goal → scoped DAG lanes → receipts → verified delivery.”
- “Provider-neutral execution without evidence-neutral completion.”

**Words to use:** evidence-gated, scoped, bounded, replayable, operator-visible, provider-neutral, local-first, declared predicates, owned paths, receipts, verified.

**Words to avoid:** autonomous software engineer, fully secure, sandboxed by default, zero risk, benchmark-winning, enterprise-ready, users/customers when referring to downloads, magical, unlimited.

**Glossary:**

| Term | Meaning |
| --- | --- |
| Control plane | The routing, policy, evidence, and operator layer around execution models |
| Lane | A scoped unit of work with explicit ownership and evidence |
| Predicate | A checkable condition required for completion |
| Evidence gate | The requirement for current, relevant proof before a completion claim |
| Receipt | A record that a side effect or workflow action completed |
| Skill | On-demand procedure or domain knowledge loaded for a task |
| MCP | Registered external workflow/resource surface |
| Hook | Always-on enforcement or evidence gate, not a selectable worker |

## Brand Voice

**Tone:** Technical, direct, skeptical of hype, operator-first.

**Style:** State the mechanism, evidence, limitation, and next action. Prefer concrete nouns and verbs over AI abstractions. Separate verified facts from inference.

**Personality:** Precise, controlled, credible, pragmatic, quietly ambitious.

**Non-negotiables:**
- Never equate downloads or stars with active users.
- Never claim an OS/account permission boundary OMK does not provide.
- Never claim benchmark superiority without identical measured tests.
- Show the actual workflow and evidence rather than saying “enterprise-grade.”

## Proof Points

**Current public metrics, retrieved 2026-07-14:**
- 122 GitHub stars.
- 3 external public issue authors.
- 308 unique GitHub viewers and 151 unique cloners in the available 14-day traffic window; these may include automation and are not active-user counts.
- 4,379 npm downloads since first publish through the latest complete data day, 2026-07-11.
- 87.69% of observed npm downloads occurred on release days; this must accompany any download total.
- Latest release: `v0.90.8`, 2026-07-13.
- MIT license and npm provenance metadata.

**Product proof:**
- Public README documents goal/DAG routing, scoped tools and MCP, evidence gates, and parallel execution.
- `v0.90.8` documents a tamper-evident evidence ledger.
- Public docs include quickstart material, although the promoted `omk.dev` domain returned DNS NXDOMAIN at retrieval.

**Customers:** No verified customer logos.

**Testimonials:** No verified testimonial suitable for publication.

**Value themes:**

| Theme | Current proof |
| --- | --- |
| Keep provider choice | Public support surfaces for Codex, Claude Code, OpenCode, and local agents |
| Make completion inspectable | Declared predicates, fresh evidence, receipts, and replayable artifacts |
| Bound parallel work | DAG lanes and owned-path model documented publicly |
| Be honest about authority | README states OMK inherits launcher permissions and recommends sandboxing |

## Goals

**Business goal:** Convert technical attention into repeatable first verified runs, then learn which operators return weekly. Revenue, funding, and commercial goals are unknown.

**North-star candidate:** Weekly retained operators completing at least one verified goal. This is a recommendation, not a currently measurable metric.

**Primary conversion action:** First successful evidence-gated task.

**Current acquisition metrics:**
- GitHub 14-day unique viewers: 308.
- GitHub top referrers: Reddit, GitHub, Google, Threads, then LinkedIn.
- npm last complete 7-day downloads: 795, heavily release-correlated.

**Current activation/retention metrics:** Unknown. npm downloads, GitHub stars, and clones cannot measure first value or retention.

**90-day objective:** Repair the install/docs path, publish one canonical proof-led demo, establish channel-attributed install intent, and obtain 10 structured user conversations or issue-based feedback records.

## Assumptions and Open Questions

The following must be corrected by the founder before this becomes final positioning:

- **Assumption:** OMK is bootstrapped/founder-led with a near-zero paid marketing budget.
- **Assumption:** The immediate goal is adoption and credible technical feedback, not revenue.
- **Assumption:** Maintainer-owned channels available for launch include GitHub, Reddit, Threads/X, LinkedIn, and Discord; access was not tested.
- Who owns marketing execution and how many hours per week are available?
- What is the actual monthly budget?
- Is `omk.dev` intended to be restored, replaced, or retired?
- Which 5–10 users can be interviewed about first-run friction and repeat use?
- Is privacy-preserving opt-in activation telemetry acceptable? If so, what policy and retention limits apply?
- What is the relationship/lineage statement for Mario Zechner, the inherited package author metadata, and OMK's current maintainer identity?
- Which current release line should new users treat as canonical, given legacy higher `v1.x` tags?
- Is the preferred growth target individual developers, teams, or AdaptOrch-qualified leads?

## Evidence Sources

- `/tmp/omk-evidence/omk-marketing-20260714/competitor-research.md`
- `/tmp/omk-evidence/omk-marketing-20260714/discovery-audit.md`
- `/tmp/omk-evidence/omk-marketing-20260714/baseline.json`
- https://github.com/dmae97/omk
- https://www.npmjs.com/package/open-multi-agent-kit
