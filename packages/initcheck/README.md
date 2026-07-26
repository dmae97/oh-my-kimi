# omk-initcheck

A small Go 1.22 binary for OMK initialization checks. The first migration seam
covers model readiness for the failover pair:

1. `kimi-coding/k3`
2. `modelstudio-maas/qwen3.8-max-preview`

The JavaScript bootstrap remains the compatibility fallback while this binary is
rolled out.

## Security contract

- Parses JSON/JSONC without interpolation.
- Never executes `apiKey` commands and never prints key values or key paths.
- A recognized `!cat <file>` source is checked only with `os.Stat`.
- HTTP probes are unauthenticated `GET` requests to a derived `/models` path.
- URL userinfo is rejected; query parameters and fragments are removed.
- Redirects are not followed; proxy environment variables are not used.
- Only the `Accept: application/json` header is set by the checker.
- Each probe has a bounded timeout. HTTP `200..499` means reachable.

The configured host is intentionally operator-controlled, including private or
localhost endpoints. `models` is an explicit network action; `--config-only` is
offline.

## Use

```sh
omk-initcheck models --root ~/.omk/agent
omk-initcheck models --root ~/.omk/agent --config-only
omk-initcheck version
```

Exit codes: `0` ready, `1` readiness failure, `2` invocation/runtime failure.

## Test

```sh
make test
make fuzz
```

Tests include table cases, real `httptest` requests, deterministic concurrent
results, JSONC fuzz targets, race detection, and goroutine leak checks.

## Build profiles

```sh
make build          # optimized static binary, symbols + DWARF retained
make install        # install the host binary into ~/.omk/agent/skills/omk-init/bin
make ghidra         # static analysis build with inlining/optimization disabled
make verify-ghidra  # ELF/DWARF/named-symbol checks
make cross          # Linux, macOS, and Windows release binaries
```

Neither profile passes Go's `-s` or `-w` linker flags. The release profile keeps
default Go optimization for startup/runtime performance while retaining symbols
and DWARF. The Ghidra profile adds `-gcflags 'all=-N -l'` to preserve function
boundaries and source-shaped control flow for decompilation.

A headless local Ghidra check can import the analysis build:

```sh
~/.omk/agent/bin/ghidra-call import_binary \
  '{"binary_path":"/absolute/path/to/dist/omk-initcheck-linux-amd64-ghidra"}'
~/.omk/agent/bin/ghidra-call search_symbols_by_name \
  '{"binary_name":"<name-returned-by-import>","query":"BuildProbeURL","functions_only":true}'
~/.omk/agent/bin/ghidra-call decompile_function \
  '{"binary_name":"<name-returned-by-import>","name_or_address":"<address-returned-by-search>"}'
```
