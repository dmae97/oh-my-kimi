import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as util from "node:util";

import * as Diff from "diff";
import { ToolError } from "../../tools/tool-errors";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { wrapCode } from "./rewrite-imports";
import type { JsStatusEvent } from "./tool-bridge";
import type {
	JsDisplayOutput,
	RunErrorPayload,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
} from "./worker-protocol";

interface VmHelperOptions {
	path?: string;
	hidden?: boolean;
	maxDepth?: number;
	limit?: number;
	offset?: number;
	reverse?: boolean;
	unique?: boolean;
	count?: boolean;
}

interface ActiveRun {
	runId: string;
	onText(chunk: string): void;
	onDisplay(output: JsDisplayOutput): void;
}

interface VmState {
	cwd: string;
	sessionId: string;
	env: Map<string, string>;
	timers: Set<NodeJS.Timeout>;
	intervals: Set<NodeJS.Timeout>;
	pendingTools: Map<string, { resolve(value: unknown): void; reject(err: Error): void }>;
	currentRun: ActiveRun | null;
}

const utf8Encoder = new TextEncoder();

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error.name === "ToolError" || error instanceof ToolError,
		};
	}
	return { message: String(error) };
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

export class WorkerCore {
	#transport: Transport;
	#state: VmState | null = null;
	#queue: Promise<void> = Promise.resolve();
	#unsubscribe: () => void;

	constructor(transport: Transport) {
		this.#transport = transport;
		this.#unsubscribe = transport.onMessage(msg => this.#handle(msg));
		transport.send({ type: "ready" });
	}

	#handle(msg: WorkerInbound): void {
		switch (msg.type) {
			case "init":
				this.#ensureState(msg.snapshot);
				return;
			case "run":
				this.#enqueueRun(msg.runId, msg.code, msg.filename, msg.snapshot);
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				this.#close();
				return;
		}
	}

	#ensureState(snapshot: SessionSnapshot): VmState {
		if (this.#state) {
			this.#state.cwd = snapshot.cwd;
			this.#state.sessionId = snapshot.sessionId;
			return this.#state;
		}
		const state: VmState = {
			cwd: snapshot.cwd,
			sessionId: snapshot.sessionId,
			env: new Map(),
			timers: new Set(),
			intervals: new Set(),
			pendingTools: new Map(),
			currentRun: null,
		};
		const helpers = createHelpers(state);
		// Inject helpers + safe globals onto the worker's own globalThis. Using indirect eval
		// (below) instead of vm.runInContext avoids a Bun bug where Worker.terminate() emits
		// SIGTRAP when the worker is mid-`vm.runInContext` synchronous loop.
		const injected: Record<string, unknown> = {
			__omp_session__: { cwd: snapshot.cwd, sessionId: snapshot.sessionId },
			__omp_helpers__: helpers,
			__omp_call_tool__: async (name: string, args: unknown) => this.#callTool(state, name, args),
			__omp_emit_status__: (op: string, data: Record<string, unknown> = {}) =>
				this.#emitStatus(state, { op, ...data }),
			__omp_log__: (level: string, ...args: unknown[]) => {
				const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
				this.#emitText(state, `${prefix}${formatConsoleArgs(args)}`);
			},
			__omp_display__: (value: unknown) => this.#displayValue(state, value),
			setTimeout: createTrackedTimeout(state, false),
			setInterval: createTrackedTimeout(state, true),
			clearTimeout: (timer?: NodeJS.Timeout) => clearTrackedTimeout(state, false, timer),
			clearInterval: (timer?: NodeJS.Timeout) => clearTrackedTimeout(state, true, timer),
			webcrypto: crypto,
			process: createProcessSubset(snapshot.cwd, state),
			require: buildRequire(snapshot.cwd),
			createRequire,
			fs,
		};
		Object.assign(globalThis, injected);
		// Prelude wires console.* and short aliases (read/write/tree/etc.) onto globalThis.
		indirectEval(JAVASCRIPT_PRELUDE_SOURCE);
		this.#state = state;
		return state;
	}

	#enqueueRun(runId: string, code: string, filename: string, snapshot: SessionSnapshot): void {
		const previous = this.#queue;
		const next = (async () => {
			await previous.catch(() => undefined);
			await this.#runOne(runId, code, filename, snapshot);
		})();
		// Detach from the queue so unhandled rejections never poison subsequent runs.
		this.#queue = next.catch(() => undefined);
	}

	async #runOne(runId: string, code: string, filename: string, snapshot: SessionSnapshot): Promise<void> {
		const state = this.#ensureState(snapshot);
		state.cwd = snapshot.cwd;
		state.sessionId = snapshot.sessionId;
		state.currentRun = {
			runId,
			onText: chunk => this.#transport.send({ type: "text", runId, chunk }),
			onDisplay: output => this.#transport.send({ type: "display", runId, output }),
		};
		try {
			const wrapped = wrapCode(code);
			const value = indirectEval(wrapped.source, filename);
			const awaited = await awaitMaybePromise(value);
			this.#displayValue(state, awaited);
			this.#transport.send({ type: "result", runId, ok: true });
		} catch (error) {
			this.#transport.send({ type: "result", runId, ok: false, error: errorPayload(error) });
		} finally {
			state.currentRun = null;
		}
	}

	async #callTool(state: VmState, name: string, args: unknown): Promise<unknown> {
		const current = state.currentRun;
		if (!current) {
			throw new ToolError("Tool calls are only valid inside an active run");
		}
		const id = `tc-${current.runId}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		state.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: current.runId, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const state = this.#state;
		if (!state) return;
		const pending = state.pendingTools.get(id);
		if (!pending) return;
		state.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(errorFromPayload(reply.error));
	}

	#emitText(state: VmState, text: string): void {
		state.currentRun?.onText(text.endsWith("\n") ? text : `${text}\n`);
	}

	#emitStatus(state: VmState, event: JsStatusEvent): void {
		state.currentRun?.onDisplay({ type: "status", event });
	}

	#displayValue(state: VmState, value: unknown): void {
		if (value === undefined) return;
		if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
				state.currentRun?.onDisplay({
					type: "image",
					data: record.data,
					mimeType: record.mimeType,
				});
				return;
			}
			state.currentRun?.onDisplay({
				type: "json",
				data: structuredClone(value),
			});
			return;
		}
		this.#emitText(state, String(value));
	}

	#close(): void {
		const state = this.#state;
		if (state) {
			for (const timer of state.timers) clearTimeout(timer);
			for (const timer of state.intervals) clearInterval(timer);
			state.timers.clear();
			state.intervals.clear();
			for (const pending of state.pendingTools.values()) {
				pending.reject(new ToolError("JS worker closed"));
			}
			state.pendingTools.clear();
		}
		this.#state = null;
		this.#transport.send({ type: "closed" });
		this.#unsubscribe();
		this.#transport.close();
	}
}

function createHelpers(state: VmState) {
	return {
		read: async (rawPath: string, options: VmHelperOptions = {}): Promise<string> => {
			const { filePath, file, size } = await resolveRegularFile(state, rawPath);
			let text = await file.text();
			const offset = typeof options.offset === "number" ? options.offset : 1;
			const limit = typeof options.limit === "number" ? options.limit : undefined;
			if (offset > 1 || limit !== undefined) {
				const lines = text.split(/\r?\n/);
				const start = Math.max(0, offset - 1);
				const end = limit !== undefined ? start + limit : lines.length;
				text = lines.slice(start, end).join("\n");
			}
			emitStatus(state, { op: "read", path: filePath, bytes: size, chars: text.length });
			return text;
		},
		writeFile: async (rawPath: string, data: unknown): Promise<string> => {
			if (!isWriteData(data)) {
				throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
			}
			const filePath = resolvePath(state, rawPath);
			if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) {
				await Bun.write(filePath, data);
			} else {
				await Bun.write(filePath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
			}
			emitStatus(state, { op: "write", path: filePath, bytes: getDataSize(data) });
			return filePath;
		},
		append: async (rawPath: string, content: string): Promise<string> => {
			const target = resolvePath(state, rawPath);
			await Bun.write(
				target,
				`${await Bun.file(target)
					.text()
					.catch(() => "")}${content}`,
			);
			emitStatus(state, {
				op: "append",
				path: target,
				chars: content.length,
				bytes: utf8Encoder.encode(content).byteLength,
			});
			return target;
		},
		sortText: (text: string, options: VmHelperOptions = {}): string => {
			const lines = String(text).split(/\r?\n/);
			const deduped = options.unique ? Array.from(new Set(lines)) : lines;
			const sorted = deduped.sort((a, b) => a.localeCompare(b));
			if (options.reverse) {
				sorted.reverse();
			}
			const result = sorted.join("\n");
			emitStatus(state, {
				op: "sort",
				lines: sorted.length,
				reverse: options.reverse === true,
				unique: options.unique === true,
			});
			return result;
		},
		uniqText: (text: string, options: VmHelperOptions = {}): string | Array<[number, string]> => {
			const lines = String(text)
				.split(/\r?\n/)
				.filter(line => line.length > 0);
			const groups: Array<[number, string]> = [];
			for (const line of lines) {
				const last = groups.at(-1);
				if (last && last[1] === line) {
					last[0] += 1;
					continue;
				}
				groups.push([1, line]);
			}
			emitStatus(state, { op: "uniq", groups: groups.length, count_mode: options.count === true });
			if (options.count) return groups;
			return groups.map(([, line]) => line).join("\n");
		},
		counter: (items: string | string[], options: VmHelperOptions = {}): Array<[number, string]> => {
			const values = Array.isArray(items) ? items : String(items).split(/\r?\n/).filter(Boolean);
			const counts = new Map<string, number>();
			for (const item of values) counts.set(item, (counts.get(item) ?? 0) + 1);
			const entries = Array.from(counts.entries())
				.map(([item, count]) => [count, item] as [number, string])
				.sort((a, b) => (options.reverse === false ? a[0] - b[0] : b[0] - a[0]) || a[1].localeCompare(b[1]));
			const limited = entries.slice(0, options.limit ?? entries.length);
			emitStatus(state, { op: "counter", unique: counts.size, total: values.length, top: limited.slice(0, 10) });
			return limited;
		},
		diff: async (rawA: string, rawB: string): Promise<string> => {
			const fileA = resolvePath(state, rawA);
			const fileB = resolvePath(state, rawB);
			const [a, b] = await Promise.all([Bun.file(fileA).text(), Bun.file(fileB).text()]);
			const result = Diff.createTwoFilesPatch(fileA, fileB, a, b, "", "", { context: 3 });
			emitStatus(state, {
				op: "diff",
				file_a: fileA,
				file_b: fileB,
				identical: a === b,
				preview: result.slice(0, 500),
			});
			return result;
		},
		tree: async (searchPath = ".", options: VmHelperOptions = {}): Promise<string> => {
			const root = resolvePath(state, searchPath);
			const maxDepth = options.maxDepth ?? 3;
			const showHidden = options.hidden ?? false;
			const lines: string[] = [`${root}/`];
			let entryCount = 0;
			const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
				if (depth > maxDepth) return;
				const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
					.filter(entry => showHidden || !entry.name.startsWith("."))
					.sort((a, b) => a.name.localeCompare(b.name));
				for (let index = 0; index < entries.length; index++) {
					const entry = entries[index];
					const isLast = index === entries.length - 1;
					const connector = isLast ? "└── " : "├── ";
					const suffix = entry.isDirectory() ? "/" : "";
					lines.push(`${prefix}${connector}${entry.name}${suffix}`);
					entryCount += 1;
					if (entry.isDirectory()) {
						await walk(path.join(dir, entry.name), `${prefix}${isLast ? "    " : "│   "}`, depth + 1);
					}
				}
			};
			await walk(root, "", 1);
			const result = lines.join("\n");
			emitStatus(state, { op: "tree", path: root, entries: entryCount, preview: result.slice(0, 1000) });
			return result;
		},
		env: (key?: string, value?: string): string | Record<string, string> | undefined => {
			if (!key) {
				const merged = Object.fromEntries(
					Object.entries(getMergedEnv(state)).sort(([a], [b]) => a.localeCompare(b)),
				);
				emitStatus(state, { op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
				return merged;
			}
			if (value !== undefined) {
				state.env.set(key, value);
				emitStatus(state, { op: "env", key, value, action: "set" });
				return value;
			}
			const result = state.env.get(key) ?? Bun.env[key];
			emitStatus(state, { op: "env", key, value: result, action: "get" });
			return result;
		},
	};
}

function emitStatus(state: VmState, event: JsStatusEvent): void {
	state.currentRun?.onDisplay({ type: "status", event });
}

function getMergedEnv(state: VmState): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of state.env) merged[key] = value;
	return merged;
}

function resolvePath(state: VmState, value: string): string {
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(state.cwd, value);
}

async function resolveRegularFile(
	state: VmState,
	rawPath: string,
): Promise<{ filePath: string; file: Bun.BunFile; size: number }> {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath)) {
		throw new ToolError(`Protocol paths are not supported by read(): ${rawPath}`);
	}
	const filePath = resolvePath(state, rawPath);
	const file = Bun.file(filePath);
	const stat = await file.stat();
	if (stat.isDirectory()) {
		throw new ToolError(`Directory paths are not supported by read(): ${filePath}`);
	}
	return { filePath, file, size: stat.size };
}

function getDataSize(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
	if (typeof data === "string") return utf8Encoder.encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return data.byteLength;
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })))
		.join(" ");
}

function createTrackedTimeout(state: VmState, repeat: boolean) {
	return (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
		const fn = () => callback(...args);
		const timer = repeat ? setInterval(fn, delay) : setTimeout(fn, delay);
		if (repeat) state.intervals.add(timer);
		else state.timers.add(timer);
		return timer;
	};
}

function clearTrackedTimeout(state: VmState, repeat: boolean, timer: NodeJS.Timeout | undefined): void {
	if (!timer) return;
	if (repeat) {
		clearInterval(timer);
		state.intervals.delete(timer);
		return;
	}
	clearTimeout(timer);
	state.timers.delete(timer);
}

function createProcessSubset(cwd: string, state: VmState): Record<string, unknown> {
	return Object.freeze({
		arch: process.arch,
		cwd: () => state.cwd ?? cwd,
		platform: process.platform,
		release: Object.freeze({ ...process.release }),
		version: process.version,
		versions: Object.freeze({ ...process.versions }),
	});
}

function buildRequire(cwd: string): NodeJS.Require {
	return createRequire(pathToFileURL(path.join(cwd, "[eval]")).href);
}

async function awaitMaybePromise<T>(value: T | Promise<T>): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	return await (value as Promise<T>);
}

/**
 * Indirect eval — runs in the worker's global scope, isolating bindings declared with
 * `const`/`let` from this module's closure. The optional `filename` is appended as a
 * `//# sourceURL=...` pragma so V8 attributes stack frames to the user cell instead of
 * `<anonymous>`.
 */
function indirectEval(source: string, filename?: string): unknown {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;
	// Read `eval` via a property access so the call site is *indirect* (global scope),
	// not direct (this function's lexical scope). The cast erases the lib.dom return type.
	const geval = globalThis.eval as (src: string) => unknown;
	return geval(withPragma);
}
