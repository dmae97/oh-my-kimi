# promptguard

Portable, zero-dependency Go module for assembling injection-resistant prompts.
Ports the OMK coding-agent trust-boundary and context-escaping logic so non-TS
runtimes (Go agents, CLIs, gateways) get the same defense in depth.

**Scope:** structural isolation + detection. It is not a sandbox and never
generates override or bypass material.

## Layout

| File | Responsibility |
|------|----------------|
| `escape.go` | `EscapeText` / `EscapeAttr` — single-pass XML escaping |
| `boundary.go` | `TrustBoundary` constant + `Wrap` (base → boundary → sections) |
| `envelope.go` | `RenderContext` — parent-first, escaped context envelopes |
| `scan.go` | `Scan` / `Highest` — defensive injection-signal detection |
| `cmd/promptguard` | stdin/stdout CLI |

## Use

```go
prompt := promptguard.Wrap(base, promptguard.RenderContext([]promptguard.Source{
    {Path: "~/.agent/AGENTS.md", Content: global, Provenance: promptguard.Parent},
    {Path: "./AGENTS.md", Content: project, Provenance: promptguard.Project},
}))

if top, ok := promptguard.Highest(promptguard.Scan(untrusted)); ok && top == promptguard.High {
    // triage before feeding untrusted content to the model
}
```

## CLI

```sh
go run ./cmd/promptguard boundary
go run ./cmd/promptguard escape  < notes.md
go run ./cmd/promptguard scan    < untrusted.txt   # exit 3 on a high finding
go run ./cmd/promptguard scan --json < untrusted.txt
```

`scan` exits `3` when a high-severity signal is found, for CI gating.

## Test

```sh
cd packages/promptguard && go test ./...
```
