# OMK — Evidence-Led Marketing Plan and Launch Kit v1

**Prepared for:** OMK maintainer
**Date:** 2026-07-14
**Status:** Execution-ready draft; no external post or production marketing configuration has been changed
**Evidence base:** `.agents/product-marketing.md` and `/tmp/omk-evidence/omk-marketing-20260714/`

## 1. Executive Summary

This plan optimizes for one outcome: turn technical curiosity into a **first verified OMK run**, then learn whether that operator returns. It does not optimize for npm download volume, because 87.69% of observed package downloads occurred on release days and cannot be treated as users.

### Three big bets

1. **Fix activation before buying or generating more attention.** Reddit, GitHub, Google, and Threads already send visitors, but the root README has no product-install command, the GitHub homepage field is empty, and `omk.dev` returned DNS NXDOMAIN on 2026-07-14. Promotion before repairing this path wastes the strongest current acquisition signal.
2. **Own verification-led orchestration, not generic “multi-agent.”** OpenHands and Cline already use control-center, parallel-agent, team, approval, and audit language. OMK's supportable wedge is narrower: run the agents users already have through scoped DAG lanes, declared completion predicates, replayable artifacts, and tamper-evident evidence.
3. **Build a proof loop around integrations.** Every useful OMK example should pair one familiar execution engine—Codex, Claude Code, OpenCode, or a local agent—with one concrete objective, one failed predicate, recovery, and the resulting evidence. That single proof can become a README demo, release asset, technical article, social clip, and community post.

### First 90 days

- Restore or replace every broken `omk.dev` CTA.
- Put product installation and the first successful prompt above extension-package installation.
- Publish one canonical 45–90 second proof demo with a sanitized replayable artifact.
- Ship three integration guides: OMK + Codex, OMK + Claude Code, OMK + OpenCode.
- Establish channel tags for Reddit, GitHub, Google, Threads, LinkedIn, and community listings.
- Conduct 10 structured conversations or issue-based interviews about first-run friction and repeat use.
- Define first verified run and weekly retained operator without collecting prompts, source code, credentials, or repository paths.

### Plausible 12-month outcome

- OMK is understood as the verification/control layer around existing coding agents.
- A working docs surface owns quickstart, integration, comparison, and evidence-guide pages.
- Acquisition is diversified across GitHub, search, technical communities, integrations, and founder-led content.
- Activation and weekly retention are measurable under a disclosed opt-in policy.
- Commercial positioning, if any, is explicitly separated between free OMK and AdaptOrch.

## 2. Strategic Frame

### Category claim

**Coding-agent orchestration and verification layer.** OMK is not another coding model and should not lead with the broad “open-source coding agent” category. It coordinates Codex, Claude Code, OpenCode, and local agents while making scope, evidence, failure, and completion visible.

### Primary message hierarchy

1. **Promise:** Run the coding agents you already use. Ship only with evidence.
2. **Mechanism:** Goal → scoped DAG lanes → receipts → declared verification.
3. **Proof:** Replayable artifacts and a tamper-evident evidence ledger.
4. **Choice:** Provider-neutral execution across hosted and local agents.
5. **Boundary:** OMK inherits the launching user's OS permissions; stronger isolation requires a container or sandbox.

### ICP

- Staff/principal engineers coordinating multiple coding-agent tools.
- Platform/DevEx teams standardizing how agents execute and prove work.
- AI tooling maintainers replacing one-off orchestration scripts.
- Technical founders who need provider choice and inspectable autonomous execution.

**Not the initial ICP:** beginners seeking a single chat agent, enterprise buyers requiring a certified sandbox/SLA, or teams that do not need orchestration or verification.

### Business-model logic

OMK is currently evidenced as a free MIT developer tool. Revenue, ARR, CAC, paid conversion, and customer logos are unknown. The first growth loop is therefore:

`proof-led demo → technical discovery → first verified run → reusable evidence artifact → issue/contribution/integration content → more discovery`

Any AdaptOrch lead-generation objective must be approved as a separate business goal and must not blur the boundary between the free OMK repository and the proprietary service.

### Voice

Direct, technical, operator-first, and anti-hype. State the mechanism and limitation. Never turn downloads into users, lane scopes into an OS sandbox, or public attention into customer adoption.

## 3. Current State

### Operating assumptions

| Item | Current planning assumption | Confidence |
| --- | --- | --- |
| Team | Founder/maintainer-led; no dedicated marketing owner observed | Assumption |
| Budget | Bootstrapped organic motion, $0–$500/month | Assumption |
| Stage | Early adoption/evaluation; no revenue evidence | Verified boundary, stage inferred |
| Primary channels | GitHub, Reddit, Google, Threads; LinkedIn is currently small | Verified 14-day referrers |
| Product cadence | Frequent releases; 25 npm versions since 2026-06-07 | Verified |
| Activation data | Not available | Verified absence from reviewed evidence |

### Existing assets

| Asset | Status | Marketing leverage |
| --- | --- | --- |
| GitHub repository | 122 stars; 20 topics; clear description | Primary trust/discovery surface |
| npm package | Current `0.90.8`; provenance metadata | Install distribution and supply-chain proof |
| Native releases | Six OS/architecture archives | Alternative install route; currently lacks checksums/instructions |
| TUI screenshots/brand visuals | Live in root README | Demonstrates operator surface |
| Discord badge | Live | Community handoff, but engagement baseline unknown |
| Technical docs | 46 Markdown files found in package docs | Strong raw material; promoted domain unavailable |
| Public issue history | Three external issue authors | Concrete friction themes, not testimonials |

### Blockers

| Blocker | Cost | Action |
| --- | --- | --- |
| `omk.dev` NXDOMAIN | Main docs/install CTA fails | Restore DNS/HTTPS or replace every CTA with a verified GitHub docs fallback |
| No product install command in root README | Visitors may confuse `omk install` extensions with installing OMK | Put one five-step product quickstart above extension distribution |
| npm and GitHub capability copy conflict | Prospects cannot tell whether plan/subagent features exist | Explain base CLI vs. OMK loadout and align copy |
| No activation/retention signal | Download spikes cannot guide growth | Define privacy-preserving first verified run and weekly retention |
| Empty GitHub homepage field | Lost high-intent route | Set only after a working destination is approved |
| Legacy higher `v1.x` tags | Version lineage is ambiguous | Add a factual release-line note |

### 17-section audit — scored from public materials

| # | Area | Score / 5 | Rationale |
| ---: | --- | ---: | --- |
| 1 | Positioning | 3 | Strong repository description; category language collides with larger control platforms |
| 2 | Customer research | 1 | Three issue authors provide fragments, not a repeatable research practice |
| 3 | Homepage | 1 | GitHub README is substantial but lacks product quickstart; docs CTA is unavailable |
| 4 | Sales/product pages | 1 | npm, docs, and releases exist but conflict or lack conversion guidance |
| 5 | Conversion pages | 0 | No dedicated integration/use-case landing pages observed |
| 6 | Competitor comparison | 0 | No maintained comparison library observed |
| 7 | Resources/content | 2 | Deep docs exist; no coherent public editorial/search architecture |
| 8 | Onboarding | 2 | Quickstart exists in docs; first-value funnel is not surfaced or measured |
| 9 | Email lifecycle | 0 | No lifecycle program observed; appropriate for current stage |
| 10 | Sales material | 1 | README/release copy exists; no case study or one-page evaluation kit |
| 11 | Messaging | 3 | Strong root promise; npm and inherited language create contradictions |
| 12 | Pricing | 2 | Free MIT status is clear; commercial relationship and goals are not |
| 13 | CRO | 0 | No conversion instrumentation or test history available |
| 14 | GTM launches | 2 | Frequent releases and social referrals exist; no repeatable proof-led launch playbook |
| 15 | Paid acquisition | 0 | Appropriate for an unmeasured bootstrapped stage |
| 16 | SEO | 1 | GitHub topics are strong; authoritative docs domain is unavailable |
| 17 | Internationalization | 1 | Globally available OSS, English-first materials, no localization plan |

**Total: 20 / 85 (23.5%).** The shape is not “weak product”; it is strong technical output with weak conversion plumbing, customer evidence, and repeatable distribution. Activation foundations come before broader acquisition.

## 4. Acquisition

### Channel priority

| Priority | Channel | Evidence/thesis | 30-day move | Primary metric |
| ---: | --- | --- | --- | --- |
| 1 | GitHub README/releases | Primary product and trust surface | Quickstart + proof demo + release install block | Quickstart CTA clicks; unique viewers |
| 2 | Reddit technical communities | Largest observed referrer family | One mechanism-first post, then reply with evidence rather than promotion | Qualified repo visits; substantive comments |
| 3 | GitHub/search integration pages | Google already contributes 21 uniques in current window | Publish Codex/Claude/OpenCode guides after query ownership review | Non-brand search impressions; guide→install clicks |
| 4 | Founder Threads/X | Threads already refers traffic | Two short proof clips/week, each one mechanism | Profile→repo clicks |
| 5 | Awesome lists/directories | External listings already mention OMK | Correct old slug and submit factual listing | Approved listings; referral visits |
| 6 | LinkedIn | Only two current unique referrers | One founder technical teardown/week, not corporate product posts | Engaged technical visits |
| Hold | Paid ads | No activation/CAC evidence | Do not spend | N/A |

### Acquisition moves

1. **Unblock the owned path.** A campaign cannot send people to NXDOMAIN docs. Restore `omk.dev` or use GitHub docs as the temporary canonical quickstart.
2. **Lead with a proof artifact.** The hero asset should show a task entering OMK, lane split, a predicate failure, recovery, and a verified result. A product screenshot alone does not establish the wedge.
3. **Write integration content, not generic AI commentary.** “OMK + Codex: add evidence gates to an existing subscription” matches the coexistence position and captures high-intent evaluators.
4. **Use Reddit for technical disclosure.** Explain what failed, what OMK records, and what it does not secure. Avoid star/download celebration posts.
5. **Normalize external identity.** Replace old `dmae97/open-multi-agent-kit` links where maintainers control the listing. Keep redirect monitoring.
6. **Earn comparison demand later.** Start with one neutral page: “OMK vs. using coding agents directly.” Do not publish competitor feature grids without revalidation.

### 12-month acquisition outlook

- **Q1:** conversion plumbing, proof demo, three integration guides, founder cadence.
- **Q2:** stable HTML docs with canonical URLs, search/query ownership, comparison and troubleshooting clusters.
- **Q3:** community case studies and co-marketing with compatible agent/tool projects.
- **Q4:** double down only on channels that produce activated and retained cohorts; paid remains conditional.

## 5. Activation

**Activation event:** the operator completes one non-empty OMK task whose required predicate passes with a visible evidence receipt.

### Activation moves

1. Put this path on the first screen: install → `omk` → `/login` → first prompt → where evidence appears.
2. Offer one 3-minute starter task with a deterministic success signal; do not start with a multi-hour orchestration demo.
3. Show the distinction between installing OMK (`npm install -g ...`) and installing an OMK package (`omk install ...`).
4. Add a “what OMK will access” boundary note before first use, linking containerization options.
5. Turn issue themes into troubleshooting: session ended, custom-provider doctor warning, and timeout limits.
6. Measure time-to-first-prompt and time-to-first-verified-run only under disclosed opt-in telemetry; never send prompt text or repository content.

### Decision rules

- If quickstart→first verified run is below 30%, stop acquisition expansion and interview failed activations.
- If median time-to-first-verified-run exceeds 10 minutes for the starter task, simplify setup before publishing more content.
- These thresholds are initial operating hypotheses, not category benchmarks.

## 6. Retention

**Retention event:** an activated operator completes another verified goal in a later ISO week.

### Moves

- Publish one operator digest per meaningful release, not one promotional post per patch.
- Build a “recipe of the week” library: bug fix, provider migration, release check, parallel implementation, and computer-use verification.
- Ask users who file issues whether they attempted a second task and what stopped them; do not call this NPS.
- Track upgrade completion separately from repeat task value.
- Create a stable release-line note and migration path so rapid releases do not undermine trust.

**Initial target hypothesis:** 25% of activated opt-in operators return in the following week after the activation event is measurable. Replace this target after the first four cohorts.

## 7. Referral

Referral should follow demonstrated value, not precede it.

- Make sanitized evidence reports shareable by default only when the operator explicitly exports them.
- Add a copyable “Built with OMK — evidence attached” footer to exported public reports as an opt-in.
- Invite issue authors and repeat contributors to publish a short recipe or failure post; never manufacture testimonials.
- Provide factual blurbs for awesome lists and MCP/agent catalogs.
- Count referred activated operators, not badge impressions.

## 8. Revenue

OMK has no evidenced paid offer. Do not invent one.

| Metric | Value | Status |
| --- | --- | --- |
| ARPC | Unknown / currently free OSS | Open decision |
| Blended CAC | Unknown | No paid spend or attribution baseline |
| Retention | Unknown | Activation instrumentation absent |
| LTV | Not calculable | Revenue and churn unknown |
| LTV/CAC | Not calculable | Do not estimate |

For the next 90 days, revenue work means **learning the commercial boundary**:

- Decide whether OMK remains purely open-source infrastructure.
- If AdaptOrch is the commercial path, define the handoff without presenting OMK features as paid-service proof.
- Interview teams about support, managed orchestration, compliance evidence, and hosted control-plane needs before packaging anything.

## 9. 90-Day Roadmap

### Weeks 1–2 — Unblock

| Move | Stage | Owner | Done when |
| --- | --- | --- | --- |
| Restore/replace broken docs links | Acquisition/Activation | Maintainer | Every promoted link returns expected 2xx content |
| Put product quickstart on root README | Activation | Maintainer | Install→login→first prompt visible before extension install |
| Align GitHub/npm capability copy | Acquisition | Maintainer | No contradiction about subagents/planning/default loadout |
| Set a working GitHub homepage | Acquisition | Maintainer | About sidebar leads to verified quickstart |
| Define activation event and privacy boundary | Activation | Maintainer | Event schema approved; no prompt/code/path collection |

### Weeks 3–4 — Foundation

| Move | Stage | Owner | Done when |
| --- | --- | --- | --- |
| Record canonical proof demo | Acquisition | Maintainer | 45–90 second video/GIF plus sanitized evidence artifact |
| Publish OMK + Codex guide | Acquisition | Maintainer/contributor | Guide has install, task, evidence, troubleshooting |
| Run five first-use interviews | Activation | Maintainer | Notes map friction to funnel stage |
| Publish one Reddit technical post | Acquisition | Maintainer | Post includes mechanism, limitation, and demo CTA |

### Weeks 5–8 — Velocity

| Move | Stage | Owner | Done when |
| --- | --- | --- | --- |
| Publish Claude Code and OpenCode guides | Acquisition | Contributor | Same evidence contract as Codex guide |
| Start two-proof-posts/week cadence | Acquisition | Maintainer | Eight posts tagged by campaign/channel |
| Create troubleshooting cluster | Activation/Retention | Maintainer | Three issue-derived guides live |
| Invite three community recipes | Referral | Maintainer | Explicit opt-in invitations sent after approval |

### Weeks 9–12 — Compound

| Move | Stage | Owner | Done when |
| --- | --- | --- | --- |
| Review four activation cohorts | Activation/Retention | Maintainer | First-run and week-1 rates available or data gap documented |
| Publish one real case study | Referral | User + maintainer | User approves factual narrative and quote |
| Refresh listings/awesome repos | Acquisition | Contributor | Canonical URL and current description accepted |
| Decide Q2 channel | All | Maintainer | One channel scaled, weak channels paused with evidence |

## 10. 12-Month Outlook

No revenue-based or goal-based budget can be computed until revenue, CAC, and team capacity are known. Plan against a bootstrapped organic baseline and keep an optional **$0–$500/month** tooling budget as an assumption, not a recommendation.

- **Q1 — Repair and prove:** working docs, canonical quickstart, proof demo, integration pages, activation definition.
- **Q2 — Build searchable authority:** HTML docs, query ownership, technical content cluster, user research cadence, first case study.
- **Q3 — Build ecosystem loops:** recipes, compatible-tool co-marketing, contributor-led integration guides, repeat-use measurement.
- **Q4 — Specialize:** choose the highest-retention segment and channel; consider commercial packaging only with interview and retention evidence.

Expected growth is a sequence of S-curves, not a promised hockey stick: Reddit/community proof first, integration/search content second, ecosystem/referral third.

## 11. Marketing Operations Stack

| Stage | Primary workflow | Tools currently usable | Deferred capability |
| --- | --- | --- | --- |
| Acquisition | Product marketing, content strategy, social, directory submissions | GitHub API, npm API, public research | GSC, working first-party docs analytics |
| Activation | Onboarding, copywriting, analytics | README/docs, GitHub releases | Opt-in first-run telemetry |
| Retention | Churn prevention, community marketing | Issues, releases, Discord | Cohort dashboard |
| Referral | Referrals, co-marketing | GitHub contributors/listings | Attribution links |
| Revenue | Pricing, offers, customer research | Interviews only | Billing/CRM data if a paid offer exists |

**Concrete week-one demonstration:** use the existing repository, public APIs, and product-marketing workflow to turn a release-heavy download chart into an honest narrative: 4,379 package downloads, 87.69% on release days, and stronger direct evidence from three external issue authors. This demonstrates the brand rule—evidence before claims—without private analytics.

### RACI assumption

| Function | Responsible | Accountable | Consulted | Informed |
| --- | --- | --- | --- | --- |
| Positioning and claims | Maintainer | Maintainer | Active users/contributors | Community |
| Quickstart/docs | Maintainer/contributor | Maintainer | New-user interviewees | Community |
| Founder content | Maintainer | Maintainer | Technical reviewer | Community |
| Measurement/privacy | Maintainer | Maintainer | Security/privacy reviewer | Users |
| Community posts | Maintainer | Maintainer | Moderators where required | Community |

## 12. Tactical Idea Bank

### Do now

- Proof-led README and release conversion path.
- Integration guides for incumbent agent users.
- Technical founder posts that disclose failure and recovery.
- Issue-derived troubleshooting content.
- Awesome-list/directory canonicalization.
- Public case studies only with user approval.
- Shareable sanitized evidence artifacts.

### Q2

- Search-owned HTML documentation.
- Neutral direct-vs-orchestrated-agent comparison.
- Monthly technical teardown/newsletter.
- Compatible-tool co-marketing.
- Community recipe gallery.

### Hold or skip

- **Paid acquisition:** blocked until activation and cohort retention exist.
- **Cold email:** no validated buyer or paid offer.
- **Influencer sponsorship:** weak fit before proof-led organic repeatability.
- **Product Hunt:** one-day attention would currently hit broken conversion plumbing.
- **Broad “AI agent” SEO pages:** crowded, undifferentiated, and unsupported by query data.
- **Download milestone campaigns:** release-driven count would overstate adoption.

## 13. Measurement, Decisions, and Publication Queue

### Funnel contract

| Stage | Event | Baseline | 30-day signal | Decision rule |
| --- | --- | ---: | ---: | --- |
| Acquisition | GitHub unique viewers | 308 / available 14 days | Preserve source mix; improve qualified CTA clicks | Scale only channels producing activation cohorts |
| Acquisition | Reddit unique referrals | 53 web + 35 app in current window | One proof post with tagged CTA | Repeat if substantive engagement and activated visits appear |
| Activation | First verified run | Unknown | Instrument or manually observe 10 users | If <30% after install, stop reach expansion |
| Retention | Return verified run in later week | Unknown | Four cohorts | Replace target after real data |
| Referral | Referred activated operator | Unknown | First attributable case | Do not count shares alone |
| Revenue | Qualified commercial conversation | Unknown | Research only | No offer until recurring need is evidenced |

### Review cadence

- **Weekly:** channel/referrer changes, quickstart failures, issue themes, content shipped.
- **Monthly:** activation cohort, week-1 retention, campaign-to-first-run path, claims audit.
- **Quarterly:** positioning, ICP, channel concentration, product/commercial boundary.

### Open decisions

1. Restore, replace, or retire `omk.dev`.
2. Confirm current release-line explanation for legacy `v1.x` tags.
3. Confirm team capacity, budget, and campaign owner.
4. Approve or reject privacy-preserving opt-in activation telemetry.
5. Decide whether OMK growth serves OSS adoption only or an AdaptOrch lead path.
6. Interview actual operators before finalizing persona language.
7. Clarify public author/maintainer lineage in npm metadata.
8. Select the first public channel action from the queue below.

# 30-Day Publishing Calendar

Nothing in this calendar has been published. Every row requires the named platform's rules and a fresh approval before external posting.

| Day | Asset/channel | Audience | CTA | Measurement |
| ---: | --- | --- | --- | --- |
| 1 | README quickstart draft | High-intent GitHub visitors | Complete first verified task | Quickstart link clicks / observed completions |
| 3 | Proof demo recording | Multi-agent tool evaluators | Watch and reproduce | Demo completion; artifact opens |
| 5 | GitHub release proof note | Existing watchers/users | Upgrade and run recipe | Release→quickstart clicks |
| 7 | Reddit technical post | Coding-agent power users | Reproduce one evidence-gated run | Qualified repo visits; technical comments |
| 9 | Threads/X proof clip | Agent-tool builders | View full demo | Tagged repo clicks |
| 11 | LinkedIn founder teardown | Platform/DevEx leads | Read architecture/evidence post | Engaged clicks; saves/comments |
| 14 | OMK + Codex guide | Codex subscribers | Run guide | Guide→install→first-run cohort |
| 17 | Issue-derived troubleshooting post | Failed evaluators | Retry setup | Troubleshooting→successful run |
| 20 | Awesome-list submission | Tool researchers | Evaluate repository | Listing approval; referrals |
| 22 | OMK + Claude Code guide | Claude Code users | Run guide | Guide cohort activation |
| 25 | OMK + OpenCode guide | OpenCode users | Run guide | Guide cohort activation |
| 28 | Discord recipe call | Existing community | Submit one sanitized recipe | Qualified submissions |
| 30 | Transparent month review | Maintainers/builders | Comment with friction | Actionable replies; next-month decision |

# Ready-to-Publish Asset Pack

## Asset 1 — README hero and quickstart

- **Audience:** GitHub visitors already evaluating coding-agent tooling.
- **CTA:** complete one evidence-gated task.
- **Metric:** quickstart CTA clicks and observed first verified runs.

**Hero:**

> **Run the coding agents you already use. Ship only with evidence.**  
> OMK routes Codex, Claude Code, OpenCode, and local agents into scoped DAG lanes, then requires declared predicates and fresh evidence before completion.

**Quickstart:**

```bash
npm install -g --ignore-scripts open-multi-agent-kit
omk
```

Then run `/login`, select your provider, and submit:

```text
Inspect this repository and report one improvement. Do not edit files. Cite the exact evidence you used.
```

> OMK runs with the permissions of the user who launched it. Use a container or sandbox when you need stronger filesystem, process, network, or credential boundaries.

## Asset 2 — Show HN draft

- **Audience:** Hacker News developers evaluating agent infrastructure.
- **CTA:** inspect the repo and reproduce the proof demo.
- **Metric:** qualified GitHub visits, issue feedback, successful reproductions.

**Title:**

> Show HN: OMK – evidence-gated orchestration for the coding agents you already use

**Body:**

> I built OMK because “the agent says it is done” is not a useful completion condition once multiple agents and tools are involved.
>
> OMK runs Codex, Claude Code, OpenCode, and local agents as execution engines. A task can be split into scoped DAG lanes with explicit owned paths, required predicates, receipts, and replayable evidence. The current release also uses a tamper-evident evidence ledger.
>
> It is not an OS sandbox: it inherits the permissions of the user who launches it, and the docs recommend containers/sandboxes for stronger isolation.
>
> The repo includes the CLI, TUI, skills/extensions model, and a reproducible demo: [canonical demo URL]. I would especially value feedback on first-run friction and whether the evidence model is useful or just overhead for your workflows.

## Asset 3 — Reddit technical post

- **Audience:** technical coding-agent communities whose rules allow project posts.
- **CTA:** reproduce the workflow and challenge the evidence model.
- **Metric:** substantive comments, tagged repo visits, first-run reports.

**Title:**

> I stopped treating “agent finished” as proof — here is the evidence gate I use across Codex, Claude Code, and OpenCode

**Body:**

> I use several coding agents, but the failure mode was always the same: orchestration made work faster while making completion harder to trust.
>
> OMK wraps those agents in a bounded flow:
>
> `goal → scoped DAG lanes → receipts → required checks → verified result`
>
> The demo shows a predicate failing, the recovery path, and the resulting evidence artifact—not just a successful final screenshot.
>
> Important limitation: lane scopes are an orchestration contract, not an OS sandbox. OMK runs with your user permissions; use containerization when you need a stronger boundary.
>
> Reproduction: [canonical demo URL]
>
> I am looking for blunt feedback on two things: where first setup breaks, and which tasks justify this much verification overhead.

## Asset 4 — Threads/X post

- **Audience:** agent builders and coding-tool users.
- **CTA:** watch the short proof demo.
- **Metric:** tagged link clicks and qualified replies.

> Multi-agent coding is easy to demo and hard to trust.
>
> OMK runs Codex, Claude Code, OpenCode, and local agents through scoped DAG lanes—then requires declared checks and fresh evidence before calling the work done.
>
> Not another model. Not a magic sandbox. A control + verification layer around the agents you already use.
>
> Demo: [canonical demo URL]

## Asset 5 — LinkedIn founder post

- **Audience:** platform engineering, DevEx, and AI tooling leads.
- **CTA:** review the architecture and share one workflow that needs evidence.
- **Metric:** engaged technical clicks, saves, and relevant comments.

> The problem with running more coding agents is not task generation. It is knowing what “done” means.
>
> Once work splits across agents, tools, and repositories, three questions become operational:
>
> 1. Which lane owned each change?
> 2. Which side effects actually happened?
> 3. Which fresh evidence proves the goal was met?
>
> OMK is my attempt to make those questions part of the runtime. It coordinates Codex, Claude Code, OpenCode, and local agents through scoped DAG lanes, declared predicates, receipts, and replayable evidence.
>
> The boundary matters: this is orchestration and verification, not an OS sandbox. Strong isolation still belongs in containers or sandbox runtimes.
>
> I published a short failure-and-recovery demo here: [canonical demo URL]
>
> What is the first coding-agent workflow in your team where “show me the evidence” becomes mandatory?

## Asset 6 — Technical article brief

- **Audience:** Dev.to/Hashnode/search visitors evaluating multi-agent systems.
- **CTA:** run the exact example.
- **Metric:** article→guide clicks and first-run cohort.

**Title:** “The Missing Layer Between Coding Agents and Verified Delivery”

**Outline:**
1. Why parallel agents amplify uncertainty.
2. Completion predicates versus model confidence.
3. Scoped lanes and owned paths.
4. Side-effect receipts and uncertain effects.
5. A real failed predicate and recovery.
6. What OMK does not secure.
7. Reproduction commands and evidence artifact.

**Opening:**

> Adding another coding agent increases execution capacity. It does not automatically increase confidence. The moment a task spans multiple agents, tools, or side effects, “finished” becomes a claim that needs a contract: scope, required checks, receipts, and current evidence.

## Asset 7 — Awesome-list/directory blurb

- **Audience:** maintainers curating coding-agent and developer-tool lists.
- **CTA:** include or refresh the listing.
- **Metric:** accepted listings and referral traffic.

> **[OMK](https://github.com/dmae97/omk)** — MIT-licensed, provider-neutral control and verification layer for Codex, Claude Code, OpenCode, and local coding agents. Routes bounded goals into scoped DAG lanes with declared predicates, replayable artifacts, and tamper-evident evidence.

## Asset 8 — Release announcement template

- **Audience:** existing watchers and npm users.
- **CTA:** upgrade and run one release-specific recipe.
- **Metric:** release→quickstart clicks, recipe completions, regressions reported.

> **OMK [version] is available.**
>
> This release changes: [one user outcome, not a changelog dump].
>
> Reproduce the new path:
>
> ```bash
> npm install -g --ignore-scripts open-multi-agent-kit@[version]
> omk
> ```
>
> Recipe: [exact prompt/command]  
> Expected evidence: [exact signal]  
> Known boundary: [one relevant limitation]  
> Full notes: [release URL]

## Asset 9 — 45-second demo script

- **Audience:** social and README visitors who need visual proof.
- **CTA:** reproduce the task.
- **Metric:** completion rate and demo→guide clicks.

1. **0–5s:** “Three coding agents. One goal. ‘Done’ is not evidence.”
2. **5–12s:** Show goal normalized into two scoped lanes and one verifier.
3. **12–22s:** Show lanes running concurrently with owned paths.
4. **22–30s:** Show a required predicate fail.
5. **30–38s:** Show bounded recovery and a fresh check.
6. **38–45s:** Show `VERIFIED`, receipt references, and exported artifact. End card: “Run the agents you already use. Ship only with evidence.”

## Asset 10 — Discord community post

- **Audience:** existing OMK community members.
- **CTA:** submit one reproducible recipe or first-run blocker.
- **Metric:** qualified recipes and actionable blockers.

> I am rebuilding OMK's onboarding around proof instead of feature lists.
>
> Please share one of these:
>
> 1. A task where OMK's evidence gate helped you trust the result.
> 2. The exact step where your first run failed.
> 3. A workflow where OMK added overhead without enough value.
>
> Do not share credentials, private repositories, prompts, or source code. A sanitized command, expected signal, and failure message are enough.

## Publication Guardrail

All copy above is a draft. Before publication:

- Replace `[canonical demo URL]` and `[version]` placeholders.
- Revalidate numeric claims and product boundaries.
- Check each community's self-promotion rules.
- Obtain a fresh direct approval for the exact platform, final text, executor, and side effect.
- Do not batch approvals across platforms.

*OMK Marketing Plan v1. Prepared 2026-07-14 for founder review.*
