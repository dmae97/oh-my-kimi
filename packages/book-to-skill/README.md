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

## Development

```bash
npm test --workspace packages/book-to-skill
npm run build --workspace packages/book-to-skill
```
