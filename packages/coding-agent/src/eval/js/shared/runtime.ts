import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as util from "node:util";

import { logger } from "@oh-my-pi/pi-utils";

import { createHelpers, type HelperBundle } from "./helpers";
import { awaitMaybePromise, indirectEval } from "./indirect-eval";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { wrapCode } from "./rewrite-imports";
import type { JsDisplayOutput, JsStatusEvent } from "./types";

/**
 * Per-run callbacks. Runtime globals resolve these from AsyncLocalStorage so
 * overlapping async cells can route output/tool calls back to their own run.
 */
export interface RuntimeHooks {
	onText(chunk: string): void;
	onDisplay(output: JsDisplayOutput): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

export interface RunContext {
	runId: string;
	hooks: RuntimeHooks;
	cwd: string;
	finalExpressionSet: boolean;
	finalExpressionValue: unknown;
}

export interface RuntimeOptions {
	initialCwd: string;
	sessionId: string;
	/**
	 * Extra globals installed alongside `__omp_helpers__` / prelude. Use for stable, lifetime-
	 * of-the-worker bindings (e.g. browser's `page`, `browser`). Per-run scope should be set
	 * via `setRunScope()` instead.
	 */
	extraGlobals?: Record<string, unknown>;
}

// Strict base64: characters from the standard alphabet plus optional `=` padding, and a
// length that is a multiple of four. URL-safe base64 and embedded whitespace are not
// accepted — the Anthropic API only honors strict base64 in image sources.
const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;

function isStrictBase64(s: string): boolean {
	if (s.length === 0 || s.length % 4 !== 0) return false;
	return BASE64_STRICT_RE.test(s);
}

/**
 * Normalize the `data` field of an `{ type: "image", data, mimeType }` display payload
 * into strict base64. Accepts:
 *   - already-valid base64 strings (passed through verbatim)
 *   - `Uint8Array` / `Buffer` / `ArrayBuffer` / typed array views
 *   - `{ type: "Buffer", data: number[] }` (the shape Node serializes Buffers to via
 *     `JSON.stringify`)
 *   - decimal-CSV byte strings (the output of `uint8array.toString("base64")`, which
 *     silently ignores the encoding argument and returns `Array.prototype.toString` —
 *     a footgun for callers expecting `Buffer.toString` semantics)
 * Returns `null` if no recovery is possible.
 */
function coerceImageBase64(data: unknown): string | null {
	if (typeof data === "string") {
		if (isStrictBase64(data)) return data;
		if (DECIMAL_CSV_RE.test(data)) {
			const parts = data.split(",");
			const bytes = new Uint8Array(parts.length);
			for (let i = 0; i < parts.length; i++) {
				const n = Number(parts[i]);
				if (!Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
		return null;
	}
	if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
	}
	if (data && typeof data === "object") {
		const obj = data as { type?: unknown; data?: unknown };
		if (obj.type === "Buffer" && Array.isArray(obj.data)) {
			const arr = obj.data as unknown[];
			const bytes = new Uint8Array(arr.length);
			for (let i = 0; i < arr.length; i++) {
				const n = arr[i];
				if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
				bytes[i] = n;
			}
			return Buffer.from(bytes).toString("base64");
		}
	}
	return null;
}

function describeDataType(data: unknown): string {
	if (data === null) return "null";
	if (data instanceof Uint8Array) return "Uint8Array";
	if (data instanceof ArrayBuffer) return "ArrayBuffer";
	if (ArrayBuffer.isView(data)) return data.constructor.name;
	if (typeof data === "string") return `string(${data.length})`;
	return typeof data;
}

/**
 * Shared JS runtime for the eval worker and the browser tab worker. Owns the prelude,
 * helper bag, console bridge, and indirect-eval execution. Emits text/display/tool-call
 * back through `RuntimeHooks` that the embedder supplies — wire format is the embedder's
 * concern.
 */
export class JsRuntime {
	readonly helpers: HelperBundle;
	#cwd: string;
	readonly sessionId: string;
	#env: Map<string, string>;
	#als = new AsyncLocalStorage<RunContext>();
	/**
	 * mtime (ms) of every user-owned absolute path we've routed through `__omp_import__`.
	 * Powers edit-aware cache eviction: an unchanged file keeps its existing module
	 * instance — and therefore its module-private singletons — across cells; a bumped
	 * mtime triggers a one-shot `require.cache` eviction so the next `import` reloads.
	 */
	#moduleMtimes = new Map<string, number>();

	constructor(opts: RuntimeOptions) {
		this.#cwd = opts.initialCwd;
		this.sessionId = opts.sessionId;
		this.#env = new Map();
		this.helpers = createHelpers({
			cwd: () => this.#activeCwd(),
			env: this.#env,
			emitStatus: event => this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event }),
		});
		this.#install(opts.extraGlobals);
	}

	get cwd(): string {
		return this.#cwd;
	}

	setCwd(cwd: string): void {
		this.#cwd = cwd;
		const session = (globalThis as { __omp_session__?: { cwd?: string } }).__omp_session__;
		if (session) session.cwd = cwd;
	}

	/**
	 * Install per-run globals. Intended for run-scoped state (browser's `tab`, `display`
	 * overrides, etc.). Overwrites previous assignments — caller is responsible for any
	 * cleanup it wants.
	 */
	setRunScope(scope: Record<string, unknown>): void {
		Object.assign(globalThis, scope);
	}

	async run(
		code: string,
		filename: string | undefined,
		hooks: RuntimeHooks,
		options: { runId?: string; cwd?: string } = {},
	): Promise<unknown> {
		const context: RunContext = {
			runId: options.runId ?? crypto.randomUUID(),
			hooks,
			cwd: options.cwd ?? this.#cwd,
			finalExpressionSet: false,
			finalExpressionValue: undefined,
		};
		return await this.#als.run(context, async () => {
			const wrapped = wrapCode(code);
			const value = indirectEval(wrapped.source, filename);
			if (wrapped.finalExpressionReturned) {
				const awaited = await awaitMaybePromise(value);
				if (context.finalExpressionSet) {
					const finalValue = context.finalExpressionValue;
					context.finalExpressionSet = false;
					context.finalExpressionValue = undefined;
					return await awaitMaybePromise(finalValue);
				}
				return awaited;
			}
			return await awaitMaybePromise(value);
		});
	}

	displayValue(value: unknown, hooks: RuntimeHooks | undefined = this.#als.getStore()?.hooks): void {
		if (value === undefined) return;
		if (!hooks) {
			logger.warn("js runtime display called outside an active run");
			return;
		}
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.type === "image" && typeof record.mimeType === "string") {
				const data = coerceImageBase64(record.data);
				if (data !== null) {
					hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
					return;
				}
				logger.warn("js displayValue: dropping image with unrecognized data shape", {
					mimeType: record.mimeType,
					dataType: describeDataType(record.data),
				});
				hooks.onText(
					`[display: image dropped — \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]\n`,
				);
				return;
			}
			try {
				hooks.onDisplay({ type: "json", data: structuredClone(value) });
			} catch (err) {
				logger.debug("js displayValue: value is not structured-cloneable, falling back to text", {
					error: err instanceof Error ? err.message : String(err),
				});
				hooks.onText(`${Object.prototype.toString.call(value)}\n`);
			}
			return;
		}
		hooks.onText(`${String(value)}\n`);
	}

	#activeCwd(): string {
		return this.#als.getStore()?.cwd ?? this.#cwd;
	}

	#activeHooks(action: string): RuntimeHooks | undefined {
		const hooks = this.#als.getStore()?.hooks;
		if (!hooks) {
			logger.warn("js runtime helper called outside an active run", { action });
		}
		return hooks;
	}

	#install(extraGlobals: Record<string, unknown> | undefined): void {
		const injected: Record<string, unknown> = {
			__omp_session__: { cwd: this.#cwd, sessionId: this.sessionId },
			__omp_helpers__: this.helpers,
			__omp_call_tool__: async (name: string, args: unknown) => {
				const hooks = this.#activeHooks("tool");
				if (!hooks) return undefined;
				return await hooks.callTool(name, args);
			},
			__omp_import__: async (source: string, options?: ImportCallOptions) => {
				const target = resolveImportSpecifier(this.#activeCwd(), source);
				// Edit-aware module cache eviction for user-owned source files (relative or
				// absolute paths). Bun's module cache otherwise pins the first evaluation for
				// the lifetime of the worker, which (a) hides edits made between cells and
				// (b) would force any module-private singleton state to be re-initialized on
				// every re-import — breaking patterns like `Settings.init()`'s module-scoped
				// `globalInstance` when one cell inits and a later cell re-imports.
				//
				// Strategy: stat the resolved file, compare mtime to the last value we saw,
				// and only evict when the file actually changed. First sight just records
				// the mtime so the current module instance — and any singleton state it
				// owns — survives subsequent imports until the user edits the file. Bare
				// specifiers and URL schemes are left alone: `node:` built-ins cannot be
				// reloaded and busting packages would defeat module identity across cells.
				if (isLocalPathSpecifier(source) && path.isAbsolute(target)) {
					try {
						const mtime = fs.statSync(target).mtimeMs;
						const prev = this.#moduleMtimes.get(target);
						if (prev !== undefined && prev !== mtime) {
							delete require.cache[target];
						}
						this.#moduleMtimes.set(target, mtime);
					} catch {
						// stat failure (missing file, permission error, …) — fall through and
						// let the real `import` surface the underlying error.
					}
				}
				return options !== undefined ? await import(target, options) : await import(target);
			},
			__omp_emit_status__: (op: string, data: Record<string, unknown> = {}) => {
				const event: JsStatusEvent = { op, ...data };
				this.#activeHooks("emitStatus")?.onDisplay({ type: "status", event });
			},
			__omp_log__: (level: string, ...args: unknown[]) => {
				const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
				const text = `${prefix}${formatConsoleArgs(args)}`;
				this.#activeHooks("log")?.onText(text.endsWith("\n") ? text : `${text}\n`);
			},
			__omp_table__: (...args: unknown[]) => {
				const hooks = this.#activeHooks("table");
				if (!hooks) return;
				let buffer = "";
				const stream = new Writable({
					write(chunk, _enc, cb) {
						buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
						cb();
					},
				});
				const tableConsole = new Console({ stdout: stream, colorMode: false });
				(tableConsole.table as (...a: unknown[]) => void)(...args);
				hooks.onText(buffer.endsWith("\n") ? buffer : `${buffer}\n`);
			},
			__omp_display__: (value: unknown) => this.displayValue(value),
			__omp_set_final_expr__: (value: unknown) => {
				const context = this.#als.getStore();
				if (!context) {
					logger.warn("js runtime final expression set outside an active run");
					return;
				}
				context.finalExpressionSet = true;
				context.finalExpressionValue = value;
			},
			webcrypto: crypto,
			// `process` is intentionally not overridden — user code gets the host worker's real
			// `process` object. Subsetting it caused segfaults in workers that share state with
			// puppeteer/worker_threads internals.
			require: buildRequire(this.#cwd),
			createRequire,
			fs,
		};
		Object.assign(globalThis, injected, extraGlobals ?? {});
		// Prelude assigns console bridge + short aliases (`read`, `write`, `tool`, `display`, ...)
		// onto globalThis. Must run after helpers are in place.
		indirectEval(JAVASCRIPT_PRELUDE_SOURCE);
	}
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })))
		.join(" ");
}

function buildRequire(cwd: string): NodeJS.Require {
	return createRequire(pathToFileURL(path.join(cwd, "[eval]")).href);
}

/**
 * Resolve an import specifier emitted by `rewriteImports` against the active session
 * cwd. Relative paths (`./`, `../`, `/`) and bare specifiers (`pkg`, `@scope/pkg`) both go
 * through `Bun.resolveSync` rooted at the cwd so user-pasted ESM behaves as if it lived in
 * the project — not next to the worker module. URL-like specifiers (`file://`, `data:`,
 * `node:`, `http:`) are passed through unchanged.
 */
function resolveImportSpecifier(cwd: string, source: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
	try {
		return Bun.resolveSync(source, cwd);
	} catch {
		return source;
	}
}

/**
 * Returns true when the original specifier is a relative or absolute filesystem path
 * (i.e. user-owned source the agent is iterating on). Bare specifiers and URL schemes
 * are excluded — `node:` built-ins cannot be reloaded, and busting bare packages would
 * defeat module identity for every cell while bringing no editing benefit.
 */
function isLocalPathSpecifier(source: string): boolean {
	return (
		source.startsWith("./") ||
		source.startsWith("../") ||
		source === "." ||
		source === ".." ||
		source.startsWith("/") ||
		source.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(source)
	);
}
