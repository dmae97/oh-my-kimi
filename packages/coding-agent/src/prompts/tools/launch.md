Launches and controls project-scoped long-running processes shared by every omp instance in the same directory.

<instruction>
- Long-running service, watcher, debugger, REPL, or process needing later input? MUST use `launch`, not `bash`.
- `start` launches `application` + `args` directly. `cwd` defaults to the session directory; `pty` defaults true.
- `ready.log` is a regex; `ready.port` is a TCP port. Both supplied? BOTH MUST pass. `ready.timeout` is seconds.
- Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
- `list`, `logs`, `wait`, `send`, `stop`, `restart`, and `describe` address the stable `name`.
- `logs` defaults to the last 100 lines. `head: true` reads the beginning. `grep` is a regex.
- `logs` with `follow: true` waits for output after `cursor`; reuse the returned cursor on the next call.
- `wait` blocks until readiness/exit/pattern or timeout. Use it only when blocked; do useful work instead of tight polling.
- `send.text` writes stdin; `enter` defaults true. `keys` supports ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT.
- `send.signal` supports SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGKILL. PTY input is serialized; many clients MAY observe, but writes share one input stream.
- `stop` performs graceful process-tree termination before hard-kill. `restart` reuses the retained launch spec.
- `restart` policy defaults `no`; `on-failure` and `always` use bounded backoff.
- `persist: true` opts out of last-omp teardown. Otherwise the broker stops every non-persistent supervised process after the last omp in this directory exits.
- `detached: true` survives broker shutdown and all omp exits. It implies `persist` and disables PTY/stdin.
</instruction>

<critical>
- Long-running work MUST use `launch`, not async/background bash.
- Readiness MUST be observed; process creation alone is not readiness.
- Omit `persist` and `detached` unless their survival guarantees are required.
- Use `stop`; NEVER kill an unverified PID through bash.
</critical>
