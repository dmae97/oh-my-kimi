# Source & Provenance

## Origin

- **Repository:** https://github.com/asgeirtj/system_prompts_leaks
- **Pinned commit:** `9f7894a3e9fa553abbfc93ac444aef81e47cdf8d` (`9f7894a`)
- **Commit date:** 2026-07-16
- **Retrieved (vendored into OMK):** 2026-07-16
- **License:** CC0 1.0 Universal (public domain) — see `LICENSE` in this directory.

## What this is

A community-maintained archive of system prompts that have **leaked or been published** for major
AI assistants (Anthropic Claude, OpenAI ChatGPT/Codex, Google Gemini, xAI Grok, Microsoft Copilot,
Perplexity, and many third-party products). It documents the hidden instructions behind those bots.

## How it was vendored

```
rsync -a \
  --exclude='.git/' --exclude='.github/' \
  --exclude='.coderabbit.yaml' --exclude='.gitattributes' \
  --exclude='banner-dark.png' --exclude='banner-light.png' \
  <repo>/  ./.omk/skills/system-prompts-leaks/corpus/
```

- Only the prompt/reference content was copied. Repo metadata (`.git`, `.github`, `.coderabbit.yaml`,
  `.gitattributes`) and decorative banner images were excluded.
- Spot-check: `sha256sum corpus/xAI/grok-4.2.md` matches the upstream file at the pinned commit.
- `references/index.md` is **generated** by `scripts/build-index.mjs` — it is not part of upstream.

## Refreshing the corpus

```sh
# 1. pull the latest upstream into a scratch clone
cd /tmp && git clone --depth 1 https://github.com/asgeirtj/system_prompts_leaks
# 2. re-vendor (run from the omk repo root)
SKILL=.omk/skills/system-prompts-leaks
rsync -a --delete \
  --exclude='.git/' --exclude='.github/' --exclude='.coderabbit.yaml' \
  --exclude='.gitattributes' --exclude='banner-dark.png' --exclude='banner-light.png' \
  /tmp/system_prompts_leaks/ "$SKILL/corpus/"
# 3. rebuild the catalog
node "$SKILL/scripts/build-index.mjs"
# 4. update the pinned commit + date in this file
# 5. Note lag: as of 2026-07-18 OMK pin is `9f7894a` while upstream HEAD was `7882386` (14 commits: CommandCode, OpenCode, Pi, Anthropic claude.ai, Kimi-3, Grok safety rename, path restores). GPT-5.6 Sol body matched upstream raw at observation; still re-vendor before claiming "latest."
```

## Attribution

All credit for collecting and curating these prompts belongs to the upstream repository and its
contributors. This OMK skill merely wraps that archive with a search interface and a usage/ethics
contract. If you reference a specific prompt, cite the upstream repo.
