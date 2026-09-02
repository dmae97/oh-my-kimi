# omk-book-to-skill

Optional OMK package for compiling documents into reusable Agent Skills. It combines a pinned `book-to-skill` workflow with OMK commands and a local provenance verifier.

## Install

From npm after publication:

```bash
omk install npm:omk-book-to-skill@0.97.0
```

From this repository:

```bash
npm run build --workspace packages/book-to-skill
omk install ./packages/book-to-skill
```

Python 3.9 or newer is required for extraction. Format-specific packages such as `pypdf`, `python-docx`, and Docling are optional and stay in the user's Python environment; this npm package installs none of them.

## Use

```text
/book-to-skill-compile <source...>
/book-to-skill-update <existing-skill> <new-source...>
/book-to-skill-verify <generated-skill-directory>
```

The package also installs the `book-to-skill` skill, so `/skill:book-to-skill` and `!book-to-skill` remain available.

## Reading an OpenKB knowledge base

The bundled `openkb` skill navigates a knowledge base compiled by the [OpenKB](https://github.com/VectifyAI/OpenKB) CLI: it locates the active KB with `openkb status`, then reads concept, entity, and summary pages and follows wikilinks across documents. Invoke it with `/skill:openkb` or let it match a question about the user's knowledge base.

The two halves divide by output. `book-to-skill` compiles documents into a reusable skill; OpenKB compiles them into a browsable wiki this skill reads. Document-to-skill compilation stays on `/book-to-skill-compile`, which records and verifies provenance — the skill deliberately routes away from OpenKB's own Skill Factory so one request has one answer.

The skill is read-only. Ingest, removal, `lint --fix`, and the interactive and watch modes are proposed to the user, never run on the agent's initiative, and compiled pages are treated as untrusted data rather than instructions. OpenKB itself is a separate Python CLI (3.10+) with its own model credentials; this package installs neither. Nothing is vendored from OpenKB — see [`skills/openkb/SOURCE.md`](skills/openkb/SOURCE.md) for the pinned commit and what was deliberately left out.

The workflow records provenance after generation through `scripts/provenance.mjs`, resolved relative to the bundled skill. In a normal npm installation where the package bin is on `PATH`, the equivalent commands are:

```bash
omk-book-to-skill record --skill ~/.omk/agent/skills/example --source ./book.pdf
omk-book-to-skill verify --skill ~/.omk/agent/skills/example --source ./book.pdf
```

Repeat `--source` in the original order for multi-source compilations. Use `record --merge-sources` after folding new sources into an existing skill.

## Verification boundary

The v1 manifest records SHA-256 digests for source files and generated artifacts. `verify` also runs the pinned upstream advisory prompt-injection scanner.

This checks local byte-level consistency against an unsigned manifest. It does not authenticate the manifest or prove authorship, licensing, trusted attestation, or semantic claim-to-source grounding. The latter requires a future span/claim evaluation layer.

## Upstream

The runtime subset under `vendor/book-to-skill/` is an unmodified snapshot of [`virgiliojr94/book-to-skill`](https://github.com/virgiliojr94/book-to-skill) commit `c4c5e948caaa912c9e2024b925a7cdee9237b0c0` (declared upstream version `1.4.0`). `upstream.json` pins every vendored file by SHA-256.

The `openkb` skill is derived rather than vendored: it states OpenKB's wiki layout and read-only command surface as original prose pinned to [`VectifyAI/OpenKB`](https://github.com/VectifyAI/OpenKB) commit `ff54396e575ee6feb0113b631a34caa082b441cc` (Apache-2.0), and copies no upstream file. `upstream.json` therefore continues to describe exactly one upstream.

## Development

```bash
npm test --workspace packages/book-to-skill
npm run build --workspace packages/book-to-skill
```
