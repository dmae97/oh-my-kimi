# OMK v0.97.0

OMK v0.97.0 makes a generated, evidence-grounded local wiki the default repository-understanding layer, adds prompt attachments, hardens command safety, and removes the vendored `oh-my-pi` tree.

## Highlights

- **Local wiki by default** — repositories get a generated `openwiki/` evidence index whose factual claims stay pinned to versioned source evidence, so stale documentation is flagged instead of silently trusted. Root `AGENTS.md`/`CLAUDE.md` carry OpenWiki managed blocks, a scheduled GitHub Actions workflow refreshes the wiki (Gemini provider by default), and the README documents the fresh-session protocol: read the wiki first, then drill into the Understand-Anything knowledge graph. Source and tests remain authoritative.
- **Prompt attachments** — images pasted or dragged into the interactive editor attach as preview chips above the input through a bounded in-memory attachment store instead of per-paste temp files. Attachments release exactly when their prompt is accepted and stay attached for retry when the turn fails before acceptance.
- **Command safety consolidation** — YOLO-mode evaluation is unified in the shared command-safety gate decision engine, and the bash classifier recursively extracts command substitutions (`$(...)`, backticks, process substitution) with quote-aware matching, so destructive bodies can no longer hide behind benign-looking outer commands. The RPC headless bash safety floor honors the same opt-out.
- **Reasoning-router promotion** — a promotion path plus `promote-weights` script moves calibrated routing weights into the registry with tests.
- **Module-size governance** — `check-module-size` joins the release gate with a committed baseline, and a dist-orphan pruning script removes stale build artifacts.
- **Vendor tree removal** — the vendored `oh-my-pi` tree (5,501 leaf entries) is removed. OMK `0.9x` is OMK-native; the README acknowledges pi (badlogic/pi-mono) and oh-my-pi as upstream origins.
- **Terminal repaint fix** — clearing redraws now reprint from the first changed row, fixing stale scrollback content and phantom loaders after above-viewport edits.

## Compatibility and safety

- The wiki layer is additive: OpenWiki blocks describe it as optional just-in-time context, not required startup reading, and claim staleness is advisory until confirmed against source.
- Attachment storage is in-memory and bounded; nothing is written to temp files per paste.
- Command-safety changes keep every verdict — including block-tier commands — running without prompts only when YOLO is explicitly enabled.

## OMK and AdaptOrch

OMK remains the local, MIT-licensed control plane. Teams evaluating a hosted evidence layer for AI-generated patches can review [AdaptOrch.com](https://adaptorch.com/?utm_source=github&utm_medium=release-notes&utm_campaign=omk#pricing). AdaptOrch's published claim boundary describes this evidence as advisory, not proof of patch correctness.

AdaptOrch is a separate proprietary service and is not bundled with OMK.

See the package changelogs for the complete change list.
