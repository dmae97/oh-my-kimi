# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, and what users can control via `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (default template)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` (override template)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (project/environment footer)

---

## 1) Inputs

Four user-controllable inputs feed prompt assembly. All four resolve a value as either a literal string or, if the argument looks like a file path, the contents of that file (`resolvePromptInput`).

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces the default prompt. Highest precedence. |
| `SYSTEM.md` | `<cwd>/.omp/SYSTEM.md` (walk-up), then `~/.omp/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Same effect as `--system-prompt`; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI flag | Appended after the (default or custom) prompt. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

Discovery for `SYSTEM.md` / `APPEND_SYSTEM.md` uses `findConfigFile` (`packages/coding-agent/src/config.ts`): the first existing file across the ordered bases (`.omp`, `.claude`, `.codex`, `.gemini` — project-level first, then user-level) wins. See [`docs/config-usage.md`](./config-usage.md) for the full discovery contract.

Precedence (highest first):

1. `--system-prompt`
2. project `SYSTEM.md`
3. user `SYSTEM.md`

For append, the same precedence applies between `--append-system-prompt`, project `APPEND_SYSTEM.md`, and user `APPEND_SYSTEM.md`.

---

## 2) Replace vs. append

Two templates exist:

- `system-prompt.md` (default) — full staff-engineer preamble, env/workstation info, tool inventory, skills/rules, exploration rules, etc.
- `custom-system-prompt.md` (override) — minimal wrapper: user content, then optional context blocks (AGENTS.md files, skills list, always-apply rules, domain rules).

`buildSystemPrompt` picks the template based on whether a custom prompt was supplied:

```ts
const rendered = prompt.render(
  resolvedCustomPrompt ? customSystemPromptTemplate : systemPromptTemplate,
  data,
);
```

Consequences:

- Providing `--system-prompt` or `SYSTEM.md` **replaces** the default prompt entirely. The default "staff engineer" preamble, the `ENV` / `Tools` / `Exploration` / `Tool Priority` / `Workflow` sections, the workstation info, the workspace tree, the today's-date/cwd footer (`project-prompt.md`), and the dir-context list are NOT injected. The override template only adds: context files (AGENTS.md), skills list, always-apply rules, and domain rules.
- Providing `--append-system-prompt` or `APPEND_SYSTEM.md` **appends** to whichever template was selected. The default prompt and its project footer remain intact.

If you want to keep the default prompt and add to it, use `--append-system-prompt` / `APPEND_SYSTEM.md`. If you want to start from scratch, use `--system-prompt` / `SYSTEM.md`.

---

## 3) Templating contract

**Contents of `SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are treated as plain text.** They are interpolated verbatim into the parent template.

The parent template is Handlebars (`packages/utils/src/prompt.ts`), but a `{{value}}` reference in Handlebars does not recursively render its substituted contents — the value is emitted as a string. Concretely:

```handlebars
{{! parent template — handled by Handlebars }}
{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
```

If `SYSTEM.md` contains:

```handlebars
Working in {{cwd}} on {{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

the rendered output contains those characters verbatim — `{{cwd}}`, `{{#if hasMemoryRoot}}`, etc. are NOT substituted. They will be shown to the model as literal Handlebars syntax.

This is by design. The internal template variables (`cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, `hasObsidian`, `mcpDiscoveryServerSummaries`, ...) are not a supported public surface — they change between releases as the prompt is rewritten, and they would couple user configs to internals. Treat them as private.

If a future release exposes a templating surface for `SYSTEM.md`, it will be opt-in (e.g. via a settings flag or a different filename) and documented here.

---

## 4) Recommended patterns

### "Tweak the default" — keep default, add a few rules

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`). The default prompt — including environment info, workspace tree, and the dated project footer — stays intact; your text is appended at the very end.

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### "Replace the default entirely" — bring your own prompt

Use `SYSTEM.md` (or `--system-prompt`). You own everything except the auto-appended context blocks (AGENTS.md, skills list, always-apply rules, domain rules). You will NOT get the default tool guidance, exploration rules, or environment-aware footer — copy what you need from `packages/coding-agent/src/prompts/system/system-prompt.md` and adjust.

```text
# ~/.omp/agent/SYSTEM.md
You are a code reviewer. Read diffs, surface issues, never edit files.
- Cite paths with backticks.
- Prefer concrete fixes over abstract advice.
```

If you do this and want environment info (cwd, date, GPU, etc.) anyway, paste a snapshot or read it from the tooling at conversation time — there is currently no way to reuse the default template's rendering pieces from `SYSTEM.md`.

### "Replace, but keep one section of the default" — not directly supported

There is no built-in way to inherit specific blocks of the default prompt while overriding the rest. The two supported modes are full-replace (`SYSTEM.md`) and append (`APPEND_SYSTEM.md`). If you need this, file a feature request describing the section you want to inherit.

---

## 5) Deduplication

To avoid double-injecting the same content, `buildSystemPrompt` deduplicates:

- If both `SYSTEM.md` (via `loadSystemPromptFiles`) and `--system-prompt` / discovered `SYSTEM.md` (via `discoverSystemPromptFile`) resolve to the same path, the `systemPromptCustomization` block is dropped because its blocks already appear in `customPrompt` (`dedupePromptSource`).
- Always-apply rules whose body appears verbatim in any of `{customPrompt, appendPrompt, systemPromptCustomization}` are omitted from the rules block (`dedupeAlwaysApplyRules`).

These passes work on **whitespace-normalized blocks separated by blank lines**, so trivial reformatting will not defeat them, but semantic restatements will not be matched.

---

## 6) Discovery and the empty-directory rule

Two code paths exist for reading `SYSTEM.md` / `APPEND_SYSTEM.md`:

- The primary path (`discoverSystemPromptFile` in `main.ts`, which feeds `customPrompt` / `appendPrompt`) calls `findConfigFile` and only checks file existence. It works even if `.omp/` contains only the `SYSTEM.md` file itself.
- The secondary capability path (`loadSystemPromptFiles` → builtin discovery) requires the project `.omp/` directory to be non-empty (the same admission rule applied to every other config file under `.omp/`). When this path skips the file, the primary path's copy already populated `customPrompt`, so deduplication leaves user-facing behavior unchanged.

Net effect: `SYSTEM.md` and `APPEND_SYSTEM.md` are picked up even from an otherwise empty `.omp/`. The non-empty rule documented in [`docs/config-usage.md`](./config-usage.md) applies to the capability layer specifically.

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add an instruction on top of the default prompt | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace the prompt entirely | `SYSTEM.md` or `--system-prompt` |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Inherit specific parts of the default prompt | Not supported; use append, or copy what you need into `SYSTEM.md`. |
| Override at a per-repo level | Project `.omp/SYSTEM.md` or `.omp/APPEND_SYSTEM.md` |
| Override globally | `~/.omp/agent/SYSTEM.md` or `~/.omp/agent/APPEND_SYSTEM.md` |
