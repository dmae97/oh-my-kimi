import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as util from "node:util";

import { ToolError } from "../../../tools/tool-errors";
import { createHelpers, type HelperBundle } from "./helpers";
import { awaitMaybePromise, indirectEval } from "./indirect-eval";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { wrapCode } from "./rewrite-imports";
import type { JsDisplayOutput, JsStatusEvent } from "./types";

/**
 * Per-run callbacks. Returned by `getHooks()` on each helper/tool/display invocation so
 * the embedding worker can route emissions to the currently active run. Returning `null`
 * makes status/display/tool calls reject with an error — useful for guarding against
 * helpers being invoked outside a run window.
 */
export interface RuntimeHooks {
	onText(chunk: string): void;
	onDisplay(output: JsDisplayOutput): void;
	callTool(name: string, args: unknown): Promise<unknown>;
}

export interface RuntimeOptions {
	initialCwd: string;
	sessionId: string;
	/** Resolve hooks for the run currently in flight, or `null` if nothing is active. */
	getHooks(): RuntimeHooks | null;
	/**
	 * Extra globals installed alongside `__omp_helpers__` / prelude. Use for stable, lifetime-
	 * of-the-worker bindings (e.g. browser's `page`, `browser`). Per-run scope should be set
	 * via `setRunScope()` instead.
	 */
	extraGlobals?: Record<string, unknown>;

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
	#getHooks: () => RuntimeHooks | null;

	constructor(opts: RuntimeOptions) {
		this.#cwd = opts.initialCwd;
		this.sessionId = opts.sessionId;
		this.#env = new Map();
		this.#getHooks = opts.getHooks;
		this.helpers = createHelpers({
			cwd: () => this.#cwd,
			env: this.#env,
			emitStatus: event => this.#getHooks()?.onDisplay({ type: "status", event }),
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

	async run(code: string, filename?: string): Promise<unknown> {
		const wrapped = wrapCode(code);
		const value = indirectEval(wrapped.source, filename);
		return await awaitMaybePromise(value);
	}

	displayValue(value: unknown): void {
		if (value === undefined) return;
		const hooks = this.#getHooks();
		if (!hooks) return;
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
				hooks.onDisplay({ type: "image", data: record.data, mimeType: record.mimeType });
				return;
			}
			hooks.onDisplay({ type: "json", data: structuredClone(value) });
			return;
		}
		hooks.onText(`${String(value)}\n`);
	}

	#install(extraGlobals: Record<string, unknown> | undefined): void {
		const injected: Record<string, unknown> = {
			__omp_session__: { cwd: this.#cwd, sessionId: this.sessionId },
			__omp_helpers__: this.helpers,
			__omp_call_tool__: async (name: string, args: unknown) => {
				const hooks = this.#getHooks();
				if (!hooks) throw new ToolError("Tool calls are only valid inside an active run");
				return await hooks.callTool(name, args);
			},
			__omp_import__: async (source: string, attrs?: Record<string, string>) => {
				const target = resolveImportSpecifier(this.#cwd, source);
				return attrs ? await import(target, { with: attrs }) : await import(target);
			},
			__omp_emit_status__: (op: string, data: Record<string, unknown> = {}) => {
				const event: JsStatusEvent = { op, ...data };
				this.#getHooks()?.onDisplay({ type: "status", event });
			},
			__omp_log__: (level: string, ...args: unknown[]) => {
				const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
				const text = `${prefix}${formatConsoleArgs(args)}`;
				this.#getHooks()?.onText(text.endsWith("\n") ? text : `${text}\n`);
			},
			__omp_display__: (value: unknown) => this.displayValue(value),
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
 * Resolve an import specifier emitted by `rewriteStaticImports` against the active session
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
