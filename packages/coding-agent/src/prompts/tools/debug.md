Provides debugger access through Debug Adapter Protocol (DAP).
Use for launching or attaching debuggers, setting breakpoints, stepping through execution, inspecting threads/stack/variables, evaluating expressions, capturing output, and interrupting hung programs.

<instruction>
- Prefer over bash for program state, breakpoints, stepping, thread inspection, or interrupting running process.
- `action: "launch"` starts session; `program` REQUIRED, `adapter` optional (auto-selected from target path and workspace).
For Python, set `adapter: "debugpy"` and `program` to target `.py` file; put interpreter/script flags in `args`.
- `action: "attach"` connects to existing process: `pid` for local attach, `port` for remote attach (where adapter supports it), `adapter` to force specific debugger.
- **Breakpoints**: `set_breakpoint`/`remove_breakpoint` with source (`file`+`line`) or function (`function`); optional `condition` for conditional breakpoints.
- **Flow control**: `continue` resumes; waits briefly to see if program stops or keeps running. `step_over`/`step_in`/`step_out` single-step. `pause` interrupts running program so can inspect state.
- **Inspect**: `threads` list. `stack_trace` frames for current stopped thread. `scopes` needs `frame_id` or current stopped frame. `variables` needs `variable_ref` or `scope_id`. `evaluate` needs `expression`; `context: "repl"` for raw debugger commands when adapter supports. `output` captured stdout/stderr/console. `sessions` tracked debug sessions. `terminate`.
- Timeouts per-request, not session lifetime.
</instruction>

<caution>
- Only one active debug session at a time.
- Some adapters need launched session receive `configurationDone` before target runs; if config pending, set breakpoints then call `continue`.
- Adapter availability depends on local binaries. Common built-ins: `gdb`, `lldb-dap`, `python -m debugpy.adapter`, `dlv dap`.
- `program` MUST be executable file or debug target, not directory or interpreter name resolving to workspace directory.
- Python debugging requires `debugpy`; install with `pip install debugpy` if adapter unavailable.
</caution>

<examples>
# Launch and inspect hang
1. `debug(action: "launch", program: "./my_app")`
2. `debug(action: "set_breakpoint", file: "src/main.c", line: 42)`
3. `debug(action: "continue")`
4. If program hung: `debug(action: "pause")`
5. Inspect state with `threads`, `stack_trace`, `scopes`, `variables`
# Launch a Python script with debugpy
`debug(action: "launch", adapter: "debugpy", program: "scripts/job.py", args: ["--flag"])`
# Raw debugger command through repl
`debug(action: "evaluate", expression: "info registers", context: "repl")`
</examples>
