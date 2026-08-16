# OMK — Unreleased (draft)

> **Not a published npm version.** Source of truth:
> [`packages/coding-agent/CHANGELOG.md`](../packages/coding-agent/CHANGELOG.md) `[Unreleased]`.
> Promote into `RELEASE_NOTES_vX.Y.Z.md` when cutting the next release.

## Highlights

- Added the first OMK Run Protocol v1 slice: canonical task, attempt, observation, evaluation, decision, and waiver contracts; pure semantic reducers; and an integrity-checked EvidenceReceipt v3 observation bridge.
- Added `omk-book-to-skill`, an optional package for document-to-skill compilation, updates, advisory scanning, and local source/artifact provenance checks without Python dependencies in OMK core.
- NVIDIA NIM `z-ai/glm-5.2` now sends reasoning effort through the `max` thinking level.
- Added GLM-5.3 (Z.AI coding-plan endpoints and OpenCode Go) and Gemini 3.7 Flash (Google, Vertex, OpenRouter, GitHub Copilot, Vercel AI Gateway, OpenCode). The GLM reasoning-effort gate now covers GLM-5.2 and later, so future GLM-5.x minor releases inherit `max` thinking without a code change.
- Quota and billing-cycle failures, including 403 usage-limit responses, can fail over to a configured authenticated model before retry; recovered and final attempt terminations remain distinguishable in session events and journals.
- New replay events use versioned RFC 8785 canonical payload hashing while legacy ledgers remain readable and exportable without rewriting; deterministically seeded, bounded property suites now cover WPL transitions, replay/evidence freshness, durable CAS, topology ordering, and timeout races.
