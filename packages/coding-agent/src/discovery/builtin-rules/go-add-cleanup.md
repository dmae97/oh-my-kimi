---
description: "Prefer runtime.AddCleanup over runtime.SetFinalizer for new code (Go 1.24)"
condition: 'runtime\.SetFinalizer'
scope: "tool:edit(*.go), tool:write(*.go)"
---

Go 1.24 added `runtime.AddCleanup`, a finalization mechanism that is more flexible and less error-prone than `runtime.SetFinalizer`. The release notes state plainly: **new code should prefer `AddCleanup` over `SetFinalizer`.**

## Why AddCleanup wins

- Multiple cleanups may attach to one object; `SetFinalizer` allows only one.
- Cleanups may attach to interior pointers.
- Objects that form a reference cycle still get cleaned up — finalizers leak them.
- A cleanup does not resurrect its object or delay freeing it (and what it points to) by an extra GC cycle.

## Migration

```go
// Before
runtime.SetFinalizer(obj, func(o *T) { o.release() })

// After — the cleanup func receives a value you supply, NOT the object,
// so it cannot accidentally keep the object alive.
runtime.AddCleanup(obj, func(h handle) { h.release() }, obj.handle)
```

The cleanup argument must not reference `obj` itself (that would keep it reachable forever). Capture only the data the cleanup needs — a file descriptor, handle, or pointer that is independent of `obj`.

## Keep SetFinalizer only when

- The module targets a Go release older than 1.24.
- You depend on finalizer-specific behavior (e.g. object resurrection) that `AddCleanup` deliberately does not provide.
