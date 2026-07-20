---
description: "Use for i := range n instead of the C-style for i := 0; i < n; i++ loop (Go 1.22)"
interruptMode: never
scope: "tool:edit(*.go), tool:write(*.go)"
astCondition:
  - "for $I := 0; $I < $N; $I++ { $$$BODY }"
---

Go 1.22 lets `for` range over an integer. A plain counting loop from `0` to `n` with step `1` reads better as `for i := range n` (or `for range n` when the index is unused).

## Avoid

```go
for i := 0; i < n; i++ {
	use(i)
}

for i := 0; i < len(s); i++ {
	use(s[i])
}
```

## Use

```go
for i := range n {
	use(i)
}

// Ranging the slice directly is usually clearer than indexing.
for i := range s {
	use(s[i])
}

// Index unused → drop it entirely.
for range n {
	tick()
}
```

## When it does not apply

- Non-zero start, step other than `++`, or a descending loop (`for i := n - 1; i >= 0; i--`) — keep the explicit form.
- The body reassigns the loop variable or depends on `i` surviving past the loop.
- Requires Go 1.22+. If the module's `go` directive is older, keep the classic loop.
