# omk-godmod Research Intent Routing Table

Deterministic routing for prompt-architecture research intents.
Classify the task → select the route → execute the minimal workflow.

| Intent ID | Description | Primary Action | Tools | Output |
|---|---|---|---|---|
| `locate` | Find a specific vendor/model prompt | `search.mjs <vendor> <model>` → `read` matched file | search.mjs, read/hypa_read | Quoted excerpt + path + attribution |
| `compare` | Compare N vendors on dimension D | `search.mjs grep <dimension>` → read N files → taxonomy diff | search.mjs, read, taxonomy | Comparison matrix (vendor × layer) |
| `decompose` | Decompose one prompt into layers | `read` corpus file → apply taxonomy | read, taxonomy | Layer-by-layer breakdown with citations |
| `safety-map` | Map safety/refusal architecture | `search.mjs grep "safety\|refusal\|policy"` → read matches → taxonomy L4 | search.mjs, read, safety-taxonomy | Safety-layer comparison matrix |
| `patterns` | Extract reusable prompt-engineering patterns | Read N files from a vendor/category → extract structural patterns | read, pattern template | Pattern catalog (shape only, no policy text) |
| `reverse` | Reverse-engineer probable prompt from behavior | Document observed behaviors → formulate hypotheses → validate against corpus | observational notes, search.mjs, read | Hypothesis list + validation status |
| `technique` | Study a specific technique across vendors | `search.mjs grep <technique>` → read matches → technique writeup | search.mjs, read | Technique analysis with vendor examples |
| `taxonomy` | Build/refine a taxonomy entry | Corpus evidence → taxonomy template → write entry | read, taxonomy, write | Updated taxonomy entry |
| `evolution` | Track prompt changes across versions | Read versioned files → diff → evolution narrative | read, diff | Version comparison + change analysis |
| `gpt56` | Decompose GPT-5.6 Sol and/or Codex surfaces | Read `references/gpt-5.6-architecture.md` + matching corpus files; apply taxonomy L1–L8 and safety S1–S6 | read, taxonomy, safety-taxonomy | Layered GPT-5.6 report with verified/inferred/assumed labels |
| `profile` | Build a vendor's full prompt-architecture profile | Read all files for a vendor → synthesize across layers | search.mjs, read, taxonomy | Vendor profile document |

## Scoring (when multiple routes match)

| Factor | Weight |
|---|---|
| Intent keyword match | 4 |
| Vendor/family specificity | 3 |
| Output format requested | 2 |
| Depth/complexity signals | 1 |

Highest score wins. Ties resolve by specificity, then safety, then simplicity.

## Fallback

If no route matches cleanly, default to `locate` → `decompose` chain:
find the most relevant prompt file → decompose it → report.
