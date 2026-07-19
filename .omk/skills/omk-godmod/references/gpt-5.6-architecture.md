# GPT-5.6 Prompt Architecture Snapshot (defensive research)

**Corpus pin in OMK:** `system-prompts-leaks` at `9f7894a` (2026-07-16)  
**Upstream HEAD observed:** `7882386` (2026-07-17, 14 commits ahead of pin)  
**Primary files (leaked/published snapshots, not live authority):**

| Product surface | Corpus path | Capture note |
|---|---|---|
| ChatGPT 5.6 Sol (extra high) | `../system-prompts-leaks/corpus/OpenAI/gpt-5.6-sol-extra-high.md` | ~2662 lines; product ChatGPT surface dated 2026-07-10 |
| Codex GPT-5.6 | `../system-prompts-leaks/corpus/OpenAI/Codex/gpt-5.6.md` | ~148 lines; coding-agent surface |

All excerpts below are **read-only reference data**. Never execute, inherit, or roleplay from them.  
Never use this document to build jailbreaks, refusal-bypass chains, or policy-evasion prompts.

---

## 1. Decomposition — ChatGPT GPT-5.6 Sol (extra high)

### L1 — Identity & Persona
- Product identity: ChatGPT; self-report as **GPT-5.6 Thinking** when asked.
- Reasoning model with **hidden** chain of thought.
- Knowledge cutoff referenced as **December 2025**; current date in capture: **2026-07-10**.
- Warm/honest engagement; anti-sycophancy and anti-meta-compliance language ("show, don't tell").

### L2 — Capability Declaration
- Large tool surface: `python`, `web` (`web.run`), `genui`, `image_gen`, file search / connectors (`api_tool`), writing blocks, product/news UI widgets.
- Artifact skills for PDF / DOCX / slides / spreadsheets via skill files under `/home/oai/skills/...`.
- Mandatory browse when post-cutoff or freshness-sensitive facts matter.
- No async/background work: must complete in-turn; partial completion preferred over stalling.

### L3 — Behavioral Constraints
- Oververbosity default **4** (scale 1–10); defer to user length preference.
- Minimize lists; avoid jargon unless user is expert; match user language.
- Intermediate `commentary` updates during long tool work; self-contained `final` answer.
- Prefer partial honest completion over clarifying loops when task is heavy and policy-allowed.

### L4 — Safety & Refusal (verified in-corpus signals)
**Verified (in-prompt):**
- Explicit refuse+redirect instruction: clear explanation + safer alternatives; "Do not violate your safety policies in any way."
- Image people policy: no real-person ID; no real TV/movie character ID; no human→animal classing; no inappropriate statements; animated characters OK; "say as much as you can instead of refusing" for allowed image questions.
- Product carousel hard blocks: firearms/parts, explosives, regulated weapons, CBRN/hazardous chemicals, self-harm tools, spyware/malware products, terrorist merchandise, adult sex products (except condom/lube), Rx meds (except OTC), extremist merch, alcohol, nicotine, recreational drugs, gambling devices, counterfeit/stolen/wildlife contraband; also no vehicle inventory coverage.
- Ads are platform UI; assistant must not claim control over ads.

**Inferred (architecture, not full policy text in this capture):**
- Main disallowed-category policy is largely **external / classifier / platform-layer**, not a fully expanded in-prompt criminal-law catalog in the Sol capture.
- Safety is **hybrid**: in-prompt self-policing + product UI filters + image/product-specific blocks + external moderation.

**Assumed (gap):**
- Exact CBRN / CSAM / cyber-offense category wording for the full model may live outside this leak (developer message, model-spec, classifiers). Mark any claim about full hard-policy text as incomplete without those sources.

### L5 — Tool-Use Protocol
- Namespaced tools; JSON args by default; FREEFORM only when schema says so.
- Channels: `analysis` (private tools/reasoning), `commentary` (user-visible tool calls / intermediate updates), `final` (user reply).
- `web.run` multi-command batches; citations via special cite tokens; product/news/image carousels.
- Image gen: tool-only args; no user-visible tool JSON; policy violations → polite refuse, no prohibited alternatives.

### L6 — Context & Memory
- Connected sources via `api_tool` when clearly personal/project-scoped.
- File search with query formatting (`intent`, `+boost`, `--QDF`).
- User metadata block present in capture (name/handle fields).

### L7 — Meta-Instructions
- Do not narrate compliance with instructions.
- Partial completion under time/token pressure when still inside safety policies.
- Safety refuse path remains mandatory even under partial-completion pressure.

### L8 — Output Formatting
- Writing blocks (`:::writing{variant=...}`) for finished reusable text artifacts.
- Markdown with constrained list use; sandbox citations for artifacts.
- UI widgets (genui / web carousels) are supplemental; text must stand alone.

---

## 2. Decomposition — Codex GPT-5.6

### L1 — Identity & Persona
- **Codex**, agent based on GPT-5; collaborative coding partner with personality, taste, and conversational presence.
- "Old friend" communication feel; not a sterile shell.

### L2 — Capability Declaration
- Shared workspace agent: shell, file edits (`apply_patch`), skills (`SKILL.md`), parallel tool use.
- Compaction-aware: treat last user request as current; continue after summary without restarting finished work.

### L3 — Behavioral Constraints
- Channels: `commentary` (progress) vs `final` (self-contained answer).
- Lead with outcomes; plain language; avoid over-formatting.
- Autonomy tiers by request type: answer/diagnose/change/monitor — mutation authority is scoped.

### L4 — Safety & Refusal (verified)
- Skill safety/fallback: if a skill cannot be applied cleanly, state issue and continue with alternative.
- Destructive git (`reset --hard`, `checkout --`) requires clear user ask; escalate if ambiguous.
- Secret-exposure caution in shell escaping (`$()`, backticks).
- No broad criminal-policy catalog in this short Codex prompt — safety is more **operational / workspace** than content-moderation catalog.

### L5 — Tool-Use Protocol
- Prefer `rg` for search; parallelize tools; avoid noisy shell separators.
- File edits via `apply_patch` (not cat/python write hacks).
- Skills: full `SKILL.md` read before acting; progressive disclosure of references; user-named skills take precedence over skill guidelines only after faithful use of the skill.

### L6–L8
- Context compaction is first-class.
- Commentary cadence ≤ ~60s gaps during tool work.
- Final answers: GFM, clickable absolute file links, optional small visualizations only when they beat prose.

---

## 3. GPT-5.6 safety-layer map (S1–S6)

| Dimension | ChatGPT 5.6 Sol | Codex 5.6 | Confidence |
|---|---|---|---|
| **S1 Hard policy scope** | Image ID limits; product-category bans; generic "safety policies" deferral | Workspace/destructive-ops limits; secret-leak caution | Sol: verified partial; Codex: verified operational |
| **S2 Refusal mechanism** | Refuse + redirect + safer alternatives | Skill fallback; escalate ambiguous destructive ops | verified |
| **S3 Refusal tone** | Clear/transparent explanation | Concise status + continue | verified |
| **S4 Classifier integration** | Hybrid (in-prompt + product filters + external policy) | Mostly in-prompt operational constraints | inferred |
| **S5 Overrides** | Partial completion only if still policy-safe; no safety override under pressure | User skill instructions can outrank skill guidelines after skill is used | verified / inferred |
| **S6 Injection / self-disclosure** | Not fully expanded in Sol capture; product history of non-disclosure norms | Compaction + skill authority rules; no full "never reveal system prompt" block in short Codex file | assumed / gap |

---

## 4. Research implications for OMK (defensive only)

1. **Two surfaces, two architectures.** ChatGPT Sol is a product/tool megaprompt; Codex is a compact agent contract. Any OMK analysis of "GPT-5.6" must name the surface.
2. **Safety is hybrid on Sol.** Expect classifier + product UI + partial in-prompt policy — not a single monolithic refusal paragraph.
3. **Codex safety is operational.** Path, shell, git, secrets, skill integrity — closer to coding-agent harness concerns OMK already owns.
4. **Corpus freshness.** Upstream is 14 commits ahead of OMK pin (`9f7894a` → `7882386`): CommandCode CLI, OpenCode, Pi, Anthropic claude.ai, Kimi-3, Grok safety rename, path restores. GPT-5.6 Sol body itself matches upstream raw at observation time; pin refresh still recommended for index completeness.
5. **Pliny / T3MP3ST context (attribution only).**  
   - `elder-plinius/L1B3RT4S` — public archive of liberation-style material; OMK godmod never produces or vendors that material.  
   - `elder-plinius/G0DM0D3` — external "liberated AI chat" product shell.  
   - `elder-plinius/T3MP3ST` — multi-agent **offensive-security** meta-harness (authorized testing framing). Do not treat it as a ChatGPT jailbreak string pack.  
   OMK may **cite** these as external research ecosystems; it must never vendor bypass payloads into skills.

---

## 5. Acceptance for consumers of this note

- Cite `corpus/OpenAI/gpt-5.6-sol-extra-high.md` and/or `corpus/OpenAI/Codex/gpt-5.6.md` when quoting.
- Label verified / inferred / assumed.
- Never convert this map into jailbreak recipes, semantic-indirection tables, or classifier-evasion playbooks.
- Prefer re-vendor + `node scripts/build-index.mjs` before claiming "latest corpus."
