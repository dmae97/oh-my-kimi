import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";
import * as vm from "node:vm";

import * as Diff from "diff";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { JAVASCRIPT_PRELUDE_SOURCE } from "./prelude";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";

export type JsDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "status"; event: JsStatusEvent };

export interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

interface VmHelperOptions {
	path?: string;
	hidden?: boolean;
	maxDepth?: number;
	ignoreCase?: boolean;
	literal?: boolean;
	limit?: number;
	offset?: number;
	globPattern?: string;
	flags?: string;
	reverse?: boolean;
	unique?: boolean;
	count?: boolean;
	cwd?: string;
	timeoutMs?: number;
	timeout?: number;
}

interface VmContextState {
	sessionKey: string;
	cwd: string;
	sessionId: string;
	session: ToolSession;
	context: vm.Context;
	env: Map<string, string>;
	timers: Set<NodeJS.Timeout>;
	intervals: Set<NodeJS.Timeout>;
	currentRun?: VmRunState;
	queue: Promise<void>;
}

const vmContexts = new Map<string, VmContextState>();
const utf8Encoder = new TextEncoder();

function getMergedEnv(state: VmContextState): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}
	for (const [key, value] of state.env) {
		env[key] = value;
	}
	return env;
}

function resolvePath(state: VmContextState, value: string): string {
	if (value.includes("://")) {
		throw new ToolError(`Protocol paths are not supported by this helper: ${value}`);
	}
	return path.isAbsolute(value) ? path.normalize(value) : path.join(state.cwd, value);
}

async function resolveRegularFile(
	state: VmContextState,
	rawPath: string,
): Promise<{ filePath: string; file: Bun.BunFile; size: number }> {
	const filePath = resolvePath(state, rawPath);
	const file = Bun.file(filePath);
	const info = await file.stat().catch(() => undefined);
	if (!info) {
		throw new ToolError(`File not found: ${filePath}`);
	}
	if (info.isDirectory()) {
		throw new ToolError(`Directory paths are not supported by this helper: ${filePath}`);
	}
	return { filePath, file, size: info.size };
}

function getDataSize(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
	if (typeof data === "string") {
		return utf8Encoder.encode(data).byteLength;
	}
	if (data instanceof Blob) {
		return data.size;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return data.byteLength;
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}

function emitText(state: VmContextState, text: string): void {
	if (!text) return;
	state.currentRun?.onText?.(text.endsWith("\n") ? text : `${text}\n`);
}

function emitStatus(state: VmContextState, event: JsStatusEvent): void {
	state.currentRun?.onDisplay?.({ type: "status", event });
}

function displayValue(state: VmContextState, value: unknown): void {
	if (value === undefined) return;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
			state.currentRun?.onDisplay?.({
				type: "image",
				data: record.data,
				mimeType: record.mimeType,
			});
			return;
		}
		state.currentRun?.onDisplay?.({
			type: "json",
			data: structuredClone(value),
		});
		return;
	}
	emitText(state, String(value));
}

function formatConsoleArgs(args: unknown[]): string {
	return args
		.map(arg => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 })))
		.join(" ");
}

function createTrackedTimeout(state: VmContextState, repeat: boolean) {
	return (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
		const fn = () => callback(...args);
		const timer = repeat ? setInterval(fn, delay) : setTimeout(fn, delay);
		if (repeat) {
			state.intervals.add(timer);
		} else {
			state.timers.add(timer);
		}
		return timer;
	};
}

function clearTrackedTimeout(state: VmContextState, repeat: boolean, timer: NodeJS.Timeout | undefined): void {
	if (!timer) return;
	if (repeat) {
		clearInterval(timer);
		state.intervals.delete(timer);
		return;
	}
	clearTimeout(timer);
	state.timers.delete(timer);
}

async function listFiles(
	state: VmContextState,
	pattern: string,
	searchPath: string,
	options: VmHelperOptions,
): Promise<string[]> {
	const resolved = resolvePath(state, searchPath);
	const hasRecursivePattern = pattern.includes("**");
	const normalizedPattern = hasRecursivePattern ? pattern : `**/${pattern}`;
	const matches = await Array.fromAsync(
		new Bun.Glob(normalizedPattern).scan({
			cwd: resolved,
			dot: options.hidden ?? false,
			absolute: true,
			onlyFiles: false,
		}),
	);
	const limited = matches.slice(0, options.limit ?? 1000).map(match => path.normalize(match));
	return limited.sort();
}

async function grepFile(
	filePath: string,
	pattern: string,
	options: VmHelperOptions,
): Promise<Array<{ line: number; text: string }>> {
	const content = await Bun.file(filePath).text();
	const lines = content.split(/\r?\n/);
	const matcher = options.literal
		? (line: string) =>
				options.ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern)
		: (line: string) => new RegExp(pattern, options.flags ?? (options.ignoreCase ? "i" : "")).test(line);
	const hits: Array<{ line: number; text: string }> = [];
	for (let index = 0; index < lines.length; index++) {
		if (matcher(lines[index])) {
			hits.push({ line: index + 1, text: lines[index] });
			if (hits.length >= (options.limit ?? 200)) {
				break;
			}
		}
	}
	return hits;
}

async function createHelpers(state: VmContextState) {
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
		stat: async (
			rawPath: string,
		): Promise<{ path: string; size: number; is_file: boolean; is_dir: boolean; mtime: string }> => {
			const target = resolvePath(state, rawPath);
			const info = await Bun.file(target).stat();
			const result = {
				path: target,
				size: info.size,
				is_file: info.isFile(),
				is_dir: info.isDirectory(),
				mtime: new Date(info.mtimeMs).toISOString(),
			};
			emitStatus(state, { op: "stat", path: target, size: result.size, is_dir: result.is_dir, mtime: result.mtime });
			return result;
		},
		find: async (pattern: string, searchPath = ".", options: VmHelperOptions = {}): Promise<string[]> => {
			const matches = await listFiles(state, pattern, searchPath, options);
			emitStatus(state, {
				op: "find",
				pattern,
				path: resolvePath(state, searchPath),
				count: matches.length,
				matches: matches.slice(0, 20),
			});
			return matches;
		},
		glob: async (pattern: string, searchPath = ".", options: VmHelperOptions = {}): Promise<string[]> => {
			const resolved = resolvePath(state, searchPath);
			const matches = await Array.fromAsync(
				new Bun.Glob(pattern).scan({
					cwd: resolved,
					dot: options.hidden ?? false,
					absolute: true,
					onlyFiles: false,
				}),
			);
			const limited = matches
				.slice(0, options.limit ?? 1000)
				.map(match => path.normalize(match))
				.sort();
			emitStatus(state, {
				op: "glob",
				pattern,
				path: resolved,
				count: limited.length,
				matches: limited.slice(0, 20),
			});
			return limited;
		},
		grep: async (
			pattern: string,
			rawPath: string,
			options: VmHelperOptions = {},
		): Promise<Array<{ line: number; text: string }>> => {
			const filePath = resolvePath(state, rawPath);
			const hits = await grepFile(filePath, pattern, options);
			emitStatus(state, { op: "grep", pattern, path: filePath, count: hits.length, hits: hits.slice(0, 10) });
			return hits;
		},
		rgrep: async (
			pattern: string,
			searchPath = ".",
			options: VmHelperOptions = {},
		): Promise<Array<{ file: string; line: number; text: string }>> => {
			const files = await listFiles(state, options.globPattern ?? "*", searchPath, {
				...options,
				limit: options.limit ?? 100,
			});
			const hits: Array<{ file: string; line: number; text: string }> = [];
			for (const file of files) {
				const fileStat = await Bun.file(file)
					.stat()
					.catch(() => undefined);
				if (!fileStat || fileStat.isDirectory()) continue;
				for (const hit of await grepFile(file, pattern, options)) {
					hits.push({ file, line: hit.line, text: hit.text });
					if (hits.length >= (options.limit ?? 100)) {
						emitStatus(state, {
							op: "rgrep",
							pattern,
							path: resolvePath(state, searchPath),
							count: hits.length,
							hits: hits.slice(0, 10),
						});
						return hits;
					}
				}
			}
			emitStatus(state, {
				op: "rgrep",
				pattern,
				path: resolvePath(state, searchPath),
				count: hits.length,
				hits: hits.slice(0, 10),
			});
			return hits;
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
			if (options.count) {
				return groups;
			}
			return groups.map(([, line]) => line).join("\n");
		},
		counter: (items: string | string[], options: VmHelperOptions = {}): Array<[number, string]> => {
			const values = Array.isArray(items) ? items : String(items).split(/\r?\n/).filter(Boolean);
			const counts = new Map<string, number>();
			for (const item of values) {
				counts.set(item, (counts.get(item) ?? 0) + 1);
			}
			const entries = Array.from(counts.entries())
				.map(([item, count]) => [count, item] as [number, string])
				.sort((a, b) => (options.reverse === false ? a[0] - b[0] : b[0] - a[0]) || a[1].localeCompare(b[1]));
			const limited = entries.slice(0, options.limit ?? entries.length);
			emitStatus(state, { op: "counter", unique: counts.size, total: values.length, top: limited.slice(0, 10) });
			return limited;
		},
		sed: async (
			rawPath: string,
			pattern: string,
			replacement: string,
			options: VmHelperOptions = {},
		): Promise<number> => {
			const filePath = resolvePath(state, rawPath);
			const content = await Bun.file(filePath).text();
			const regex = new RegExp(pattern, options.flags ?? "g");
			const matches = content.match(regex);
			const updated = content.replace(regex, replacement);
			await Bun.write(filePath, updated);
			const count = matches?.length ?? 0;
			emitStatus(state, { op: "sed", path: filePath, count });
			return count;
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
		run: async (
			command: string,
			options: VmHelperOptions = {},
		): Promise<{ stdout: string; stderr: string; exit_code: number }> => {
			const cwd = options.cwd ? resolvePath(state, options.cwd) : state.cwd;
			const timeoutMs =
				typeof options.timeoutMs === "number"
					? options.timeoutMs
					: typeof options.timeout === "number"
						? options.timeout * 1000
						: undefined;
			const timeoutSignal =
				typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
					? AbortSignal.timeout(timeoutMs)
					: undefined;
			const signal =
				state.currentRun?.signal && timeoutSignal
					? AbortSignal.any([state.currentRun.signal, timeoutSignal])
					: (state.currentRun?.signal ?? timeoutSignal);
			const child = Bun.spawn(["bash", "-lc", command], {
				cwd,
				env: getMergedEnv(state),
				stdout: "pipe",
				stderr: "pipe",
				signal,
			});
			const [stdout, stderr, exit_code] = await Promise.all([
				new Response(child.stdout as ReadableStream<Uint8Array>).text(),
				new Response(child.stderr as ReadableStream<Uint8Array>).text(),
				child.exited,
			]);
			const output = `${stdout}${stderr}`.slice(0, 500);
			emitStatus(state, { op: "run", cmd: command.slice(0, 120), code: exit_code, output });
			return { stdout, stderr, exit_code };
		},
		env: (key?: string, value?: string): string | Record<string, string> | undefined => {
			if (!key) {
				const env = Object.fromEntries(Object.entries(getMergedEnv(state)).sort(([a], [b]) => a.localeCompare(b)));
				emitStatus(state, { op: "env", count: Object.keys(env).length, keys: Object.keys(env).slice(0, 20) });
				return env;
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

function createProcessSubset(cwd: string): Record<string, unknown> {
	return Object.freeze({
		arch: process.arch,
		cwd: () => cwd,
		platform: process.platform,
		release: Object.freeze({ ...process.release }),
		version: process.version,
		versions: Object.freeze({ ...process.versions }),
	});
}

async function createVmState(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	session: ToolSession,
): Promise<VmContextState> {
	const state: VmContextState = {
		sessionKey,
		cwd,
		sessionId,
		session,
		context: {} as vm.Context,
		env: new Map(),
		timers: new Set(),
		intervals: new Set(),
		queue: Promise.resolve(),
	};

	const helpers = await createHelpers(state);
	const contextGlobals: Record<string, unknown> = {
		__omp_session__: { cwd, sessionId },
		__omp_helpers__: helpers,
		__omp_call_tool__: async (name: string, args: unknown) =>
			callSessionTool(name, args, {
				session: state.session,
				signal: state.currentRun?.signal,
				emitStatus: event => emitStatus(state, event),
			}),
		__omp_emit_status__: (op: string, data: Record<string, unknown> = {}) => emitStatus(state, { op, ...data }),
		__omp_log__: (level: string, ...args: unknown[]) => {
			const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
			emitText(state, `${prefix}${formatConsoleArgs(args)}`);
		},
		__omp_display__: (value: unknown) => displayValue(state, value),
		setTimeout: createTrackedTimeout(state, false),
		setInterval: createTrackedTimeout(state, true),
		clearTimeout: (timer?: NodeJS.Timeout) => clearTrackedTimeout(state, false, timer),
		clearInterval: (timer?: NodeJS.Timeout) => clearTrackedTimeout(state, true, timer),
		queueMicrotask,
		URL,
		URLSearchParams,
		TextEncoder,
		TextDecoder,
		AbortController,
		AbortSignal,
		structuredClone,
		crypto,
		webcrypto: crypto,
		performance,
		atob,
		btoa,
		Buffer,
		process: createProcessSubset(cwd),
		fs,
		fetch,
		Blob,
		File,
		Headers,
		Request,
		Response,
		globalThis: undefined,
	};
	const context = vm.createContext(contextGlobals);
	context.globalThis = context;
	state.context = context;
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, context, { filename: "js-prelude.js" });
	return state;
}

async function getOrCreateVmState(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	session: ToolSession,
): Promise<VmContextState> {
	const existing = vmContexts.get(sessionKey);
	if (existing) {
		existing.cwd = cwd;
		existing.sessionId = sessionId;
		existing.session = session;
		return existing;
	}
	const created = await createVmState(sessionKey, sessionId, cwd, session);
	vmContexts.set(sessionKey, created);
	return created;
}

async function disposeState(state: VmContextState): Promise<void> {
	for (const timer of state.timers) {
		clearTimeout(timer);
	}
	state.timers.clear();
	for (const timer of state.intervals) {
		clearInterval(timer);
	}
	state.intervals.clear();
	state.currentRun = undefined;
}

async function runQueued<T>(state: VmContextState, work: () => Promise<T>): Promise<T> {
	const previous = state.queue;
	const { promise, resolve } = Promise.withResolvers<void>();
	state.queue = promise;
	await previous;
	try {
		return await work();
	} finally {
		resolve();
	}
}

function wrapCode(code: string): { source: string; asyncWrapped: boolean } {
	const needsAsyncWrapper = /\bawait\b|\breturn\b/.test(code);
	if (!needsAsyncWrapper) {
		return { source: code, asyncWrapped: false };
	}
	return {
		source: `(async () => {\n${code}\n})()`,
		asyncWrapped: true,
	};
}

async function awaitMaybePromise<T>(value: T | Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	const promised = value as Promise<T>;
	if (!signal) {
		return promised;
	}
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	if (signal.aborted) {
		reject(signal.reason ?? new Error("Execution aborted"));
		return promise;
	}
	const onAbort = () => reject(signal.reason ?? new Error("Execution aborted"));
	signal.addEventListener("abort", onAbort, { once: true });
	promised.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	return promise;
}

export async function executeInVmContext(options: {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	session: ToolSession;
	reset?: boolean;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
}): Promise<{ value: unknown }> {
	if (options.reset) {
		await resetVmContext(options.sessionKey);
	}
	const state = await getOrCreateVmState(options.sessionKey, options.sessionId, options.cwd, options.session);
	return runQueued(state, async () => {
		state.currentRun = options.runState;
		try {
			if (options.runState.signal?.aborted) {
				throw options.runState.signal.reason ?? new Error("Execution aborted");
			}
			const wrapped = wrapCode(options.code);
			const value = vm.runInContext(wrapped.source, state.context, {
				filename: options.filename,
				timeout: options.timeoutMs,
			});
			const awaited = await awaitMaybePromise(value, options.runState.signal);
			displayValue(state, awaited);
			return { value: awaited };
		} finally {
			state.currentRun = undefined;
		}
	});
}

export async function resetVmContext(sessionKey: string): Promise<void> {
	const existing = vmContexts.get(sessionKey);
	if (!existing) return;
	vmContexts.delete(sessionKey);
	await disposeState(existing);
}

export async function disposeAllVmContexts(): Promise<void> {
	const states = Array.from(vmContexts.values());
	vmContexts.clear();
	for (const state of states) {
		await disposeState(state);
	}
}
