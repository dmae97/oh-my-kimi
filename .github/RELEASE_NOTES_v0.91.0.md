# OMK v0.91.0

OMK v0.91.0 is a feature release published to npm as `open-multi-agent-kit@0.91.0` (lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`) with prebuilt binaries attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| Footer metrics | The footer CPU/MEM segment now reports whole-machine utilization — aggregate `os.cpus()` busy percentage and `totalmem - freemem` — instead of process-scoped usage. Wide terminals show `CPU 42% MEM 35% (18.0GB/50.5GB)`; thresholds are percentage-based (warning ≥70% CPU or ≥85% MEM, error ≥90%/95%). |
| Themes | New built-in Aurora pair (`omk-aurora-dark`, `omk-aurora-light`; aliases `aurora`, `aurora-dark`, `aurora-light`) with WCAG-verified contrast (body ≥14:1, muted ≥5.7:1, semantic ≥4.5:1) and a stepped thinking-level color ramp. |
| AdaptOrch | `omk-adaptorch-wpl` is promoted from experimental to stable and ships as a runtime dependency of the CLI. The v4 auto thinking-level resolver gains an opt-in, global-only `adaptorchBridge` settings block; when enabled it fuses advisory hints as a bounded ±2-step nudge behind a circuit breaker and TTL cache. Default remains fully off. |
| Providers | Two new built-in subscription (OAuth) providers under `/login` → "Use a subscription": Qwen (Qwen Code Subscription) and Grok (xAI OAuth Proxy). |

## Install

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version   # 0.91.0
```

## Verification boundary

`tsgo --noEmit` is clean across the workspace; the adaptorch-wpl suite passed 73/73, the coding-agent regression suite passed 784/784, and the theme/footer/metrics suites are green. Live-provider tests and other operating systems remain outside this release's verification boundary.

## Migration and rollback

No breaking changes. The footer metric source switched from process to system; process-scoped getters remain on `MetricsSampler` for diagnostics. The `adaptorchBridge` resolver hint is inert unless explicitly enabled in the global settings file (`~/.omk/agent/settings.json`); project-scope settings cannot enable it.

## Compatibility

All five packages publish in lockstep at `0.91.0`. Internal workspace packaging was extended so `omk-adaptorch-wpl` is included reproducibly in the coding-agent shrinkwrap.
