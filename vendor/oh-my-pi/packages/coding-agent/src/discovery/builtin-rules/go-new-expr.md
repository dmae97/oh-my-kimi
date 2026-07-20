---
description: "Use new(expr) for pointer-to-value helpers instead of `func ptr[T any](v T) *T { return &v }` (Go 1.26)"
interruptMode: never
scope: "tool:edit(*.go), tool:write(*.go)"
astCondition:
  - "func $F($V $T) *$T { return &$V }"
  - "func $F[$$$TP]($V $T) *$T { return &$V }"
---

Go 1.26 lets `new` take an expression: `new(expr)` allocates, stores `expr`, and returns its `*T`. That removes the need for hand-written `Ptr`/`boolPtr`/`Int64`-style helpers and the `x := v; p := &x` two-step.

## Why

- One builtin replaces a helper per type (`boolPtr`, `strPtr`, `int64Ptr`, …) and the generic `func Ptr[T any](v T) *T`.
- No extra function-call frame and no separate heap escape — the value is constructed directly in the allocation.
- The intent (`new(false)`) reads at the call site instead of hiding behind a helper name.

## Avoid

```go
// A helper that just takes a value and returns its address.
func boolPtr(v bool) *bool   { return &v }
func strPtr(v string) *string { return &v }
func Ptr[T any](v T) *T       { return &v }

cfg := Config{Enabled: boolPtr(true), Name: strPtr("svc")}
```

## Use

```go
cfg := Config{Enabled: new(true), Name: new("svc")}

// Was: x := int64(300); p := &x
p := new(int64(300))
```

`new(true)` / `new(false)` give you `*bool`; `new(expr)` works for any expression, including function results (`new(time.Now())`).

## Notes

- Requires Go 1.26+. If the module's `go` directive is older, keep the helper or the temp-variable form until the toolchain is bumped.
- This is for helpers that *only* take a value and return its address. A function that does real work before taking an address is not in scope.
- `new(T)` (a bare type) is unchanged and still zero-initializes.
