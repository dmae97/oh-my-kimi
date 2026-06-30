---
description: "Use io and os instead of the deprecated io/ioutil package"
condition: '"io/ioutil"'
scope: "tool:edit(*.go), tool:write(*.go)"
---

`io/ioutil` has been deprecated since Go 1.16. Every function moved to `io` or `os` with the same behavior. Do not import it in new code.

## Mapping

| io/ioutil | Replacement |
| --- | --- |
| `ioutil.ReadAll` | `io.ReadAll` |
| `ioutil.ReadFile` | `os.ReadFile` |
| `ioutil.WriteFile` | `os.WriteFile` |
| `ioutil.ReadDir` | `os.ReadDir` (returns `[]os.DirEntry`, not `[]os.FileInfo`) |
| `ioutil.TempFile` | `os.CreateTemp` |
| `ioutil.TempDir` | `os.MkdirTemp` |
| `ioutil.NopCloser` | `io.NopCloser` |
| `ioutil.Discard` | `io.Discard` |

## Migration

```go
// Before
import "io/ioutil"
data, err := ioutil.ReadFile(path)
_ = ioutil.WriteFile(out, data, 0o644)

// After
import "os"
data, err := os.ReadFile(path)
_ = os.WriteFile(out, data, 0o644)
```

`os.ReadDir` returns `[]os.DirEntry` rather than `[]os.FileInfo` — call `entry.Info()` if you need the old `FileInfo`. Everything else is a drop-in rename.
