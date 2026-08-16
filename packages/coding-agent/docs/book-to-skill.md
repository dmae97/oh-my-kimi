# Book to Skill

`omk-book-to-skill` is an optional OMK package for turning documents into reusable Agent Skills. It is not part of the OMK core install.

## Install

Pin the package when installing from npm:

```bash
omk install npm:omk-book-to-skill@0.95.2
```

In a source checkout:

```bash
npm run build --workspace packages/book-to-skill
omk install ./packages/book-to-skill
```

Run `/reload` after installation if the current session was already open.

## Requirements

- Node.js 22.19 or newer, as required by OMK
- Python 3.9 or newer for document extraction
- Optional extractors in a user-managed Python environment

The package does not add Docling or other Python dependencies to OMK. Plain text and Markdown use the Python standard library; PDF, EPUB, DOCX, RTF, and technical extraction select an available upstream extractor and preserve its confirmation/fallback behavior.

## Commands

```text
/book-to-skill-compile <source...>
/book-to-skill-update <existing-skill> <new-source...>
/book-to-skill-verify <generated-skill-directory>
```

The compile and update commands start an agent turn with the bundled workflow. The package also exposes the ordinary skill commands:

```text
/skill:book-to-skill <source...>
!book-to-skill <source...>
```

Generated personal skills default to `~/.omk/agent/skills/`; project skills use `.omk/skills/`. The workflow asks when scope is ambiguous.

## Provenance and verification

After generation, the skill runs the upstream advisory scanner and records `.book-to-skill-provenance.json`. The bundled workflow resolves `scripts/provenance.mjs` from the skill directory, so it does not depend on an npm bin path. If `omk-book-to-skill` is on `PATH`, the standalone CLI can repeat the checks:

```bash
omk-book-to-skill record \
  --skill ~/.omk/agent/skills/example \
  --source ./book.pdf

omk-book-to-skill verify \
  --skill ~/.omk/agent/skills/example \
  --source ./book.pdf
```

Repeat `--source` in the original order. During Update / Fold-in, use `record --merge-sources` to retain prior source digests.

Exit codes:

- `0`: artifact hashes, supplied source hashes, and advisory scan passed
- `1`: mismatch or scanner finding
- `2`: usage error or incomplete verification, such as omitted source files or unavailable Python

`/book-to-skill-verify` checks artifact integrity and the advisory scanner. Use the CLI with `--source` to recheck source bytes.

## Trust boundary

The provenance file is an unsigned local integrity record. It detects byte changes after compilation, but does not establish authorship, redistribution rights, trusted attestation, or semantic claim-to-source grounding. Source documents remain untrusted data; the workflow must not execute instructions embedded in them.

## Supply chain

The package pins the upstream runtime snapshot at commit `c4c5e948caaa912c9e2024b925a7cdee9237b0c0` (`book-to-skill` `1.4.0`). `upstream.json` records SHA-256 digests for every vendored file. Python packages remain external to the npm package and OMK core.

See [Skills](skills.md) for discovery and invocation and [OMK Packages](packages.md) for package management.
