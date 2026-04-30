# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool that uses Claude—questions about its behavior refer to the code in `packages/coding-agent/`, not your current session.

### Package Structure

| Package                 | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support     |
| `packages/agent`        | Agent runtime with tool calling and state management |
| `packages/coding-agent` | Main CLI application (primary focus)                 |
| `packages/tui`          | Terminal UI library with differential rendering      |
| `packages/natives`      | bindings for native text/image/grep operations       |
| `packages/stats`        | Local observability dashboard (`omp stats`)          |
| `packages/utils`        | Shared utilities (logger, streams, temp files)       |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops    |

## Code Quality

- No `any` types unless absolutely necessary
- Prefer `export * from "./module"` over named re-export-from blocks, including `export type { ... } from`. In pure `index.ts` barrel files (re-exports only), use star re-exports even for single-specifier cases. If star re-exports create symbol ambiguity, remove the redundant export path instead of keeping duplicate exports.
- **No `private`/`protected`/`public` keyword on class fields or methods** — use ES native `#` private fields for encapsulation; leave members that need external access as bare (no keyword). The only place `private`/`protected`/`public` is allowed is on **constructor parameter properties** (e.g., `constructor(private readonly session: ToolSession)`), where TypeScript requires the keyword for the implicit field declaration.

  ```typescript
  // BAD: TypeScript keyword privacy
  class Foo {
      private bar: string;
      private _baz = 0;
      protected qux(): void { ... }
      public greet(): void { ... }
  }

  // GOOD: ES native # for private, bare for accessible
  class Foo {
      #bar: string;
      #baz = 0;
      qux(): void { ... }
      greet(): void { ... }
  }

  // OK: constructor parameter properties keep the keyword
  class Service {
      constructor(private readonly session: ToolSession) {}
  }
  ```

- **NEVER use `ReturnType<>`** — it obscures types behind indirection. Use the actual type name instead. Look up return types in source or `node_modules` type definitions and reference them directly.

  ```typescript
  // BAD: Indirection through ReturnType
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stmt: ReturnType<Database["prepare"]>;
  let stat: Awaited<ReturnType<typeof fs.stat>>;

  // GOOD: Use the actual type
  let timer?: NodeJS.Timeout;
  let stmt: Statement;
  let stat: Stats;
  ```

  If a function's return type has no exported name, define a named type alias at the call site — don't use `ReturnType<>`.

- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- **NEVER build prompts in code** — no inline strings, no template literals, no string concatenation. Prompts live in static `.md` files; use Handlebars for any dynamic content.
- **Import static text files via Bun** — use `import content from "./prompt.md" with { type: "text" }` instead of `readFileSync`
- **Use `Promise.withResolvers()`** instead of `new Promise((resolve, reject) => ...)` — cleaner, avoids callback nesting, and the resolver functions are properly typed:

  ```typescript
  // BAD: Verbose, callback nesting
  const promise = new Promise<string>((resolve, reject) => { ... });

  // GOOD: Clean destructuring, typed resolvers
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  ```

## Bun Over Node

This project uses Bun. Use Bun APIs where they provide a cleaner alternative; use `node:fs` for operations Bun doesn't cover.

**NEVER spawn shell commands for operations that have proper APIs** (e.g., `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync` instead).

### Process Execution

**Prefer Bun Shell** (`$` template literals) for simple commands:

```typescript
import { $ } from "bun";

// Capture output
const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

// Fire and forget
$`do-stuff ${tmpFile}`.quiet().nothrow();
```

**Use `Bun.spawn`/`Bun.spawnSync`** only when:

- Long-running processes (LSP servers, Python kernels)
- Streaming stdin/stdout/stderr required (SSE, JSON-RPC)
- Process control needed (signals, kill, complex lifecycle)

**Bun Shell methods:**

- `.quiet()` - suppress output (stdout/stderr to null)
- `.nothrow()` - don't throw on non-zero exit
- `.text()` - get stdout as string
- `.cwd(path)` - set working directory

### Sleep

**Prefer** `await Bun.sleep(ms)`  
**Avoid** `new Promise((resolve) => setTimeout(resolve, ms))`

### Node Module Imports

**NEVER use named imports from `node:fs` or `node:path`** — always use namespace imports:

```typescript
// BAD: Named imports
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// GOOD: Namespace imports
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Then use: fs.readdir(), path.join(), etc.
```

**Choosing between `node:fs` and `node:fs/promises`:**

- **Async-only file** → `import * as fs from "node:fs/promises"`
- **Needs both sync and async** → `import * as fs from "node:fs"`, use `fs.promises.xxx` for async

### File I/O

**Prefer Bun file APIs:**

```typescript
// Read
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();

// Write
await Bun.write(path, data);
```

**`Bun.write()` is smart** — it auto-creates parent directories and uses optimal syscalls:

```typescript
// BAD: Redundant mkdir before write
await mkdir(dirname(path), { recursive: true });
await Bun.write(path, data);

// GOOD: Bun.write handles it
await Bun.write(path, data); // Creates parent dirs automatically
```

**Use `node:fs/promises`** for directories (Bun has no native directory APIs):

```typescript
import * as fs from "node:fs/promises";

await fs.mkdir(path, { recursive: true });
await fs.rm(path, { recursive: true, force: true });
const entries = await fs.readdir(path);
```

**Avoid sync APIs** in async flows:

- Don't use `existsSync`/`readFileSync`/`writeFileSync` when async is possible
- Use sync only when required by a synchronous interface

### File I/O Anti-Patterns

**NEVER check `.exists()` before reading** — use try-catch with error code:

```typescript
// BAD: Two syscalls, race condition
if (await Bun.file(path).exists()) {
	return await Bun.file(path).json();
}

// GOOD: One syscall, atomic, type-safe error handling
import { isEnoent } from "@oh-my-pi/pi-utils";

try {
	return await Bun.file(path).json();
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

**NEVER create multiple handles to the same path**:

```typescript
// BAD: Creates two file handles
if (await Bun.file(path).exists()) {
	const content = await Bun.file(path).text();
}

// BAD: Still wasteful even in separate functions
async function checkConfig() {
	return await Bun.file(configPath).exists();
}
async function loadConfig() {
	return await Bun.file(configPath).json(); // second handle
}
```

**NEVER use `Buffer.from(await Bun.file(x).arrayBuffer())`** — just use `readFile`:

```typescript
// BAD: Unnecessary conversion
const buffer = Buffer.from(await Bun.file(path).arrayBuffer());

// GOOD: Direct buffer read
import * as fs from "node:fs/promises";
const buffer = await fs.readFile(path);
```

**NEVER mix redundant existence checks with try-catch**:

```typescript
// BAD: Existence check is pointless when you have try-catch
if (await file.exists()) {
	try {
		return await file.json();
	} catch {
		return null;
	}
}

// GOOD: Let try-catch handle missing files
try {
	return await Bun.file(path).json();
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

### Streams

**Prefer centralized helpers:**

```typescript
import { readStream, readLines } from "./utils/stream";

// Read entire stream
const text = await readStream(child.stdout);

// Line-by-line iteration
for await (const line of readLines(stream)) {
	// process line
}
```

**Avoid manual reader loops** unless protocol requires it (SSE, streaming JSON-RPC).

### JSON5 Parsing

**Use `Bun.JSON5`** — never add `json5` as a dependency:

```typescript
// BAD: External dependency
import JSON5 from "json5";
const data = JSON5.parse(text);

// GOOD: Bun builtin
const data = Bun.JSON5.parse(text);
const output = Bun.JSON5.stringify(obj);
```

### JSONL Parsing

**Use `Bun.JSONL`** — never manually split and parse:

```typescript
// BAD: Manual split + JSON.parse
const lines = text.split("\n").filter(Boolean);
const entries = lines.map((line) => JSON.parse(line));

// GOOD: Full blob parsing
const entries = Bun.JSONL.parse(text);
```

**For streaming JSONL** (SSE, JSON-RPC, subprocess output), use `Bun.JSONL.parseChunk() | Bun.JSONL.parse()` without decoding to string:

### Terminal Width and Wrapping

**Use `Bun.stringWidth()`** for display width calculations:

```typescript
// BAD: External dependency or custom implementation
import { getWidth } from "get-east-asian-width";
function visibleWidth(str: string) {
	/* custom logic */
}

// GOOD: Bun builtin (handles ANSI, emoji, CJK)
const width = Bun.stringWidth(text);
const widthNoAnsi = Bun.stringWidth(text, { countAnsiEscapeCodes: false });
```

**Use `Bun.wrapAnsi()`** for ANSI-aware text wrapping:

```typescript
// BAD: Custom ANSI-aware wrapping
function wrapTextWithAnsi(text: string, width: number) {
	/* complex SGR tracking */
}

// GOOD: Bun builtin
const wrapped = Bun.wrapAnsi(text, width, {
	wordWrap: true,
	hard: false,
	trim: true,
});
```

### Where Bun Wins

| Operation       | Use                                   | Not                             |
| --------------- | ------------------------------------- | ------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`           | `readFileSync`, `writeFileSync` |
| Spawn process   | `$\`cmd\``, `Bun.spawn()`             | `child_process`                 |
| Sleep           | `Bun.sleep(ms)`                       | `setTimeout` promise            |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`   |
| HTTP server     | `Bun.serve()`                         | `http.createServer()`           |
| SQLite          | `bun:sqlite`                          | `better-sqlite3`                |
| Hashing         | `Bun.hash()`, Web Crypto              | `node:crypto`                   |
| Path resolution | `import.meta.dir`, `import.meta.path` | `fileURLToPath` dance           |
| JSON5 parsing   | `Bun.JSON5.parse()`                   | `json5` package                 |
| JSONL parsing   | `Bun.JSONL.parse()`, `.parseChunk()`  | manual split + `JSON.parse`     |
| String width    | `Bun.stringWidth()`                   | `get-east-asian-width`, custom  |
| Text wrapping   | `Bun.wrapAnsi()`                      | custom ANSI-aware wrappers      |

### Patterns

**Subprocess streams** — cast when using pipe mode:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

**Password hashing** — built-in bcrypt/argon2:

```typescript
const hash = await Bun.password.hash("password", "bcrypt");
const valid = await Bun.password.verify("password", hash);
```

### Anti-Patterns

- `Bun.spawnSync([...])` for simple commands → use `$\`...\``
- `new Promise((resolve) => setTimeout(resolve, ms))` → use `Bun.sleep(ms)`
- `existsSync/readFileSync/writeFileSync` in async code → use `Bun.file()` APIs
- Manual `child.stdout.getReader()` loops for non-streaming commands → use `readStream()` helper
- `import JSON5 from "json5"` → use `Bun.JSON5.parse()`
- `text.split("\n").map(JSON.parse)` for JSONL → use `Bun.JSONL.parse()`
- Custom `visibleWidth()` / `get-east-asian-width` → use `Bun.stringWidth()`
- Custom ANSI-aware text wrapping → use `Bun.wrapAnsi()`

## Logging

**NEVER use `console.log`, `console.error`, or `console.warn`** in the coding-agent package. Console output corrupts the TUI rendering.

Use the centralized logger instead:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation.

## TUI Rendering Sanitization

All text displayed in tool renderers must be sanitized before output. Raw content (file contents, error messages, tool output) can contain characters that break terminal rendering — tabs cause visual holes, long lines overflow, and unsanitized paths leak home directories.

### Rules

- **Tabs → spaces**: Always pass displayed text through `replaceTabs()` before rendering. Tabs produce variable-width gaps in terminals and cause visual holes in the TUI. Import from `@oh-my-pi/pi-tui` or `../tools/render-utils`.
- **Line truncation**: Truncate displayed lines with `truncateToWidth()` or `ui.truncate()` to prevent horizontal overflow. Use constants from `TRUNCATE_LENGTHS` for consistency.
- **Path shortening**: Use `shortenPath()` for file paths shown to users — replaces home directory prefix with `~`.
- **Content preview limits**: Use `PREVIEW_LIMITS` constants for collapsed/expanded line counts. Don't invent ad-hoc limits.

### Where to apply

Sanitization applies to **every** code path that renders text to the TUI, including:

- Success output (file previews, command output, search results)
- **Error messages** — these often embed file content (e.g., patch failure messages include the lines that failed to match)
- Diff content (both added/removed lines)
- Streaming previews

A common mistake is sanitizing the happy path but forgetting error paths. If a message includes file content, it needs `replaceTabs()`.

### Streaming tool previews

Streaming tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed arguments, update every path — not just the final renderer.

For the bash tool specifically:
- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed tool-call args can lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve any preview-only fields (for example `__partialJson`) when tool-call args flow through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists. The bash renderer uses call args plus render context to show the command preview while streaming, not only after output arrives.
- When changing bash preview formatting, verify both live streaming and rebuilt transcript paths. A fix in one path does not automatically fix the other.

## Commands

| Command        | Description                      |
| -------------- | -------------------------------- |
| `bun check`    | Check all (TypeScript + Rust)    |
| `bun check:ts` | Biome check + tsgo type checking |
| `bun check:rs` | Cargo fmt --check + clippy       |
| `bun lint`     | Lint all                         |
| `bun lint:ts`  | Biome lint                       |
| `bun lint:rs`  | Cargo clippy                     |
| `bun fmt`      | Format all                       |
| `bun fmt:ts`   | Biome format                     |
| `bun fmt:rs`   | Cargo fmt                        |
| `bun fix`      | Fix all (unsafe fixes + format)  |
| `bun fix:ts`   | Biome --unsafe + format-prompts  |
| `bun fix:rs`   | Clippy --fix + cargo fmt         |

- NEVER run: `bun run dev`, `bun test` unless user instructs
- Only run specific tests if user instructs: `bun test test/specific.test.ts`
- NEVER commit unless user asks
- Do NOT use `tsc` or `npx tsc` - always use `bun check`

## Testing Guidance

When adding or changing tests, test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one concrete, externally observable contract: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- Do not add placeholder tests, tautologies, or assertions that only prove the code executed (`expect(true).toBe(true)`, `not.toThrow()`, non-empty string checks, array length growth checks, or "prompt exists" checks without a stronger semantic assertion).
- Prefer contract-level tests over implementation-detail tests. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail as a documented contract.
- Do not duplicate coverage across abstraction levels. If an integration or public-surface test already proves the behavior, delete or avoid the narrower unit test that only restates it through mocks or internal plumbing.
- Tests MUST be full-suite safe, not just file-local safe. Do not use long-lived file-wide mutations of globals like `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)`, local fakes, and immediate restoration via `vi.restoreAllMocks()`. A test that passes in isolation but poisons later files is broken.
- Never use `mock.module()`. Bun's `mock.module()` mutates the global module registry and leaks across test files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). There is no reliable per-file isolation. Use `spyOn` on the imported module object instead, and restore in `afterEach`. For pass dependencies, import the pass object and spy on its `run` method. For package dependencies, use a namespace import and spy on the exported function.
- For lifecycle or stateful code, prefer one test per invariant or transition over several tiny tests that each assert one field from the same transition.
- For error handling, prefer tests that trigger the real failure path and assert the surfaced error contract over tests that directly instantiate error classes or inspect purely internal metadata.
- Smoke tests are only acceptable when they detect a failure mode narrower tests would miss. A test that only proves a package boots or a command starts is not enough.
- Exact strings, ordering, and formatting should only be asserted when downstream code parses or materially depends on the exact bytes. Otherwise assert semantic content instead.
- If a guarantee is purely compile-time, enforce it with type checks or type-test coverage, not a runtime test disguised as a placeholder.
- Do not add tests for tiny, low-risk changes unless the change affects a real contract, fixes a regression-prone edge case, or would otherwise be easy to break silently.
- When trimming or adding tests, prefer focused package-local verification for the changed area so the surviving suite proves the contract it claims to protect.

## GitHub Issues

When reading issues:

- Always read all comments on the issue

When creating issues:

- Use standard GitHub labels (bug, enhancement, documentation, etc.)
- If an issue affects a specific package, mention it in the issue title or description

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## Tools

- GitHub CLI for issues/PRs
- TUI interaction: use tmux

## Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features
- `### Breaking Changes` - API changes requiring migration (appears first if present)

### Rules

- New entries ALWAYS go under `## [Unreleased]` section
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`

## Releasing

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   bun run release
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.
