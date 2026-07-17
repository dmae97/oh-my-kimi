Debugger access. Prefer over bash for program state, breakpoints, stepping, or thread inspection.

Only one active session at a time. `program` is a target path, not a shell command. Directories need a directory-capable adapter (`dlv`).

Adapters:
- Python: `debugpy` (`pip install debugpy`)
- Go: Delve (`go install github.com/go-delve/delve/cmd/dlv@latest`)
- Ruby: `rdbg` (`gem install debug`)
