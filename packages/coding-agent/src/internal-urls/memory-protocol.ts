import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getMemoryRoot } from "../memories";
import { getMnemopiSessionState, type MnemopiScopedMemoryHit, type MnemopiSessionState } from "../mnemopi/state";
import { AgentRegistry } from "../registry/agent-registry";
import { buildDirectoryResource } from "./filesystem-resource";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const DEFAULT_MEMORY_FILE = "memory_summary.md";
const MEMORY_NAMESPACE = "root";

/**
 * Snapshot of memory roots for every registered session, deduped.
 * Each session has its own cwd (possibly a worktree), so subagents and main
 * may see different roots.
 */
export function memoryRootsFromRegistry(): string[] {
	const agentDir = getAgentDir();
	const roots: string[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const sm = ref.session?.sessionManager;
		if (!sm) continue;
		const root = getMemoryRoot(agentDir, sm.getCwd());
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

function memoryRootsForContext(context?: ResolveContext): string[] {
	if (context?.cwd) return [getMemoryRoot(getAgentDir(), context.cwd)];
	return memoryRootsFromRegistry();
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("memory:// URL escapes memory root");
	}
}

function toMemoryValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "memory://"));
}

/**
 * Resolve a memory:// URL to an absolute filesystem path under memory root.
 */
export function resolveMemoryUrlToPath(url: InternalUrl, memoryRoot: string): string {
	const namespace = url.rawHost || url.hostname;
	if (!namespace) {
		throw new Error("memory:// URL requires a namespace: memory://root");
	}
	if (namespace !== MEMORY_NAMESPACE) {
		throw new Error(`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE}`);
	}

	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";
	if (!hasPath) {
		return path.resolve(memoryRoot, DEFAULT_MEMORY_FILE);
	}
	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPathname.slice(1));
	} catch {
		throw new Error(`Invalid URL encoding in memory:// path: ${url.href}`);
	}

	try {
		validateRelativePath(relativePath);
	} catch (error) {
		throw toMemoryValidationError(error);
	}

	return path.resolve(memoryRoot, relativePath);
}

async function tryResolveInRoot(url: InternalUrl, memoryRoot: string): Promise<InternalResource | undefined> {
	const resolved = path.resolve(memoryRoot);
	let resolvedRoot: string;
	try {
		resolvedRoot = await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	const targetPath = resolveMemoryUrlToPath(url, resolvedRoot);
	ensureWithinRoot(targetPath, resolvedRoot);

	const parentDir = path.dirname(targetPath);
	try {
		const realParent = await fs.realpath(parentDir);
		ensureWithinRoot(realParent, resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}

	ensureWithinRoot(realTargetPath, resolvedRoot);

	const stat = await fs.stat(realTargetPath);
	if (stat.isDirectory()) {
		return buildDirectoryResource(url.href, realTargetPath);
	}
	if (!stat.isFile()) {
		throw new Error(`memory:// URL must resolve to a file or directory: ${url.href}`);
	}

	const content = await Bun.file(realTargetPath).text();
	const ext = path.extname(realTargetPath).toLowerCase();
	const contentType: InternalResource["contentType"] = ext === ".md" ? "text/markdown" : "text/plain";

	return {
		url: url.href,
		content,
		contentType,
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: realTargetPath,
		notes: [],
	};
}

/**
 * Snapshot of live mnemopi session states, deduplicated. A mnemopi backend
 * always keeps its state on the {@link AgentSession} it was initialised for;
 * subagents alias their parent's state, so different `session` objects can
 * point at the same underlying banks. The dedupe below picks the
 * canonical (non-aliased) state per bank set so `memory://<id>` resolves in
 * one pass regardless of how many subagents are alive.
 */
function mnemopiSessionStatesFromRegistry(): MnemopiSessionState[] {
	const seen = new Set<unknown>();
	const states: MnemopiSessionState[] = [];
	for (const ref of AgentRegistry.global().list()) {
		const session = ref.session;
		if (!session) continue;
		const state = getMnemopiSessionState(session);
		if (!state) continue;
		const primary = state.aliasOf ?? state;
		if (seen.has(primary)) continue;
		seen.add(primary);
		states.push(primary);
	}
	return states;
}

/**
 * Look up a mnemopi memory row by id across every live session's scoped banks.
 * First hit wins; returns `null` when the id is not stored anywhere in scope.
 */
function tryResolveMnemopiMemory(id: string): MnemopiScopedMemoryHit | null {
	for (const state of mnemopiSessionStatesFromRegistry()) {
		const hit = state?.getScopedMemory(id);
		if (hit) return hit;
	}
	return null;
}

/**
 * Render a mnemopi memory row as text/markdown with a small YAML-front-matter
 * header. The frontmatter carries the metadata an agent needs to reason about
 * a working vs episodic memory (bank, store, timestamps, importance) without
 * having to reconstruct it from the recall preview.
 */
function renderMnemopiMemory(url: InternalUrl, hit: MnemopiScopedMemoryHit): InternalResource {
	const { row, bank, store } = hit;
	const meta = row.metadata == null ? "" : `metadata: ${JSON.stringify(row.metadata)}\n`;
	const header =
		"---\n" +
		`id: ${row.id}\n` +
		`bank: ${bank}\n` +
		`store: ${store}\n` +
		(row.memory_type ? `memory_type: ${row.memory_type}\n` : "") +
		(row.source ? `source: ${row.source}\n` : "") +
		(row.timestamp ? `timestamp: ${row.timestamp}\n` : "") +
		(row.created_at ? `created_at: ${row.created_at}\n` : "") +
		(row.importance != null ? `importance: ${row.importance}\n` : "") +
		(row.veracity ? `veracity: ${row.veracity}\n` : "") +
		(row.session_id ? `session_id: ${row.session_id}\n` : "") +
		meta +
		"---\n\n";
	const content = `${header}${row.content}`;
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

/**
 * Protocol handler for memory:// URLs.
 * Resolves file-backed roots against the calling session cwd when provided.
 * Contextless callers fall back to the live-session registry for legacy
 * cross-session lookups.
 */
export class MemoryProtocolHandler implements ProtocolHandler {
	readonly scheme = "memory";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const namespace = url.rawHost || url.hostname;
		if (!namespace) {
			throw new Error("memory:// URL requires a namespace: memory://root or memory://<memory-id>");
		}

		// Mnemopi rows live in SQLite banks per session, keyed by memory id.
		// Any host other than the file-backed `root` namespace is treated as a
		// mnemopi memory id lookup. This is the read counterpart to
		// `memory_edit update` and lets agents inspect the full content of a
		// clipped recall preview before overwriting it (issue #4443).
		if (namespace !== MEMORY_NAMESPACE) {
			const mnemopiStates = mnemopiSessionStatesFromRegistry();
			if (mnemopiStates.length === 0) {
				throw new Error(
					`Unknown memory namespace: ${namespace}. Supported: ${MEMORY_NAMESPACE} (file-backed memory summary), or a mnemopi memory id when memory.backend=mnemopi is active.`,
				);
			}
			const hit = tryResolveMnemopiMemory(namespace);
			if (hit) return renderMnemopiMemory(url, hit);
			throw new Error(
				`Mnemopi memory ${namespace} not found in any scoped bank. Use \`recall\` to list available ids.`,
			);
		}

		const roots = memoryRootsForContext(context);
		if (roots.length === 0) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		let anyExists = false;
		for (const root of roots) {
			try {
				await fs.stat(root);
				anyExists = true;
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const result = await tryResolveInRoot(url, root);
			if (result) return result;
		}

		if (!anyExists) {
			throw new Error(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		}

		throw new Error(`Memory file not found: ${url.href}`);
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const completions: UrlCompletion[] = [];
		if (memoryRootsForContext(context).length > 0) {
			completions.push({ value: MEMORY_NAMESPACE, description: "Project memory summary" });
		}
		if (mnemopiSessionStatesFromRegistry().length > 0) {
			completions.push({
				value: "<memory-id>",
				description: "Full mnemopi memory by id (from recall)",
			});
		}
		return completions;
	}
}
