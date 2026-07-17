---
description: "Use the standard library slices and maps packages instead of golang.org/x/exp/{slices,maps}"
condition:
  - '"golang.org/x/exp/slices"'
  - '"golang.org/x/exp/maps"'
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
---

`golang.org/x/exp/slices` and `golang.org/x/exp/maps` were promoted into the standard library as `slices` and `maps` in Go 1.21. Import the stdlib packages in new code instead of the experimental ones.

## Migration

```go
// Before
import (
	"golang.org/x/exp/slices"
	"golang.org/x/exp/maps"
)

// After
import (
	"slices"
	"maps"
)
```

Most call sites are unchanged: `slices.Sort`, `slices.Contains`, `slices.Index`, `slices.Equal`, `maps.Clone`, etc.

## Watch the signature differences

The promoted APIs were tweaked, so a blind path swap can break the build:

- `x/exp/maps.Keys(m)` / `Values(m)` returned a slice; the stdlib `maps.Keys(m)` / `maps.Values(m)` return an **iterator** (`iter.Seq`). Use `slices.Collect(maps.Keys(m))` to recover a slice, or range over the iterator.
- `slices.SortFunc` takes a comparison returning `int` (cmp-style), matching the stdlib signature.

## Keep x/exp when

- The module's `go` directive is below 1.21 (stdlib `slices`/`maps` don't exist yet).
- You need an `x/exp` helper that was not promoted (e.g. parts of `x/exp/constraints` still live outside the stdlib).
