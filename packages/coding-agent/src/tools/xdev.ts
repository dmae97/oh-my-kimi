/**
 * `xd://` virtual tool devices.
 *
 * Discoverable built-ins and custom tools are unmounted from the request's
 * tools array and exposed as internal URLs driven through the `read`/`write`
 * tools the model already has:
 *
 *   read  xd://          → mounted tool listing (discovery)
 *   read  xd://<tool>    → tool docs + JSON parameter schema
 *   write xd://<tool>    → execute: `content` is the JSON args object
 *
 * Args go through the same machinery as native tool calls: validated with
 * pi-ai's `validateToolArguments` (the schema is returned on mismatch, so a
 * malformed call self-corrects without a round trip) and streamed through
 * the write tool's existing incremental `content` decoding for live render
 * previews. Compared to a dispatcher def this still costs zero *schema
 * duplication* — one wire schema per tool instead of one per dispatcher
 * branch — but full docs + schema for every mounted device are inlined into
 * the system prompt (`XdevRegistry.docsAll()`) so no discovery `read` is
 * needed before first use; `read xd://<tool>` remains for on-demand re-fetch.
 *
 * Rendering: the write renderer draws NOTHING until the streamed `path` is
 * known and provably does not target `xd://`; device writes then delegate to
 * the wrapped tool's own renderer with the decoded inner args.
 */
import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { parseStreamingJson } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { XD_URL_PREFIX } from "../internal-urls/xd-protocol";
import type { Theme } from "../modes/theme/theme";
import type { Tool } from "./index";
import { replaceTabs } from "./render-utils";
import type { ToolRenderer } from "./renderers";
import { ToolError } from "./tool-errors";

/**
 * Discoverable built-ins that must stay top-level even when xdev mounting is
 * active: `todo` feeds the todo prelude/prewalk machinery, `ask` is the
 * model's user-interaction affordance, and `grep` is the redirect target of
 * the bash interceptor rules — each loses its harness integration if hidden
 * behind dispatch.
 */
export const XDEV_KEEP_TOP_LEVEL: Record<string, true> = { todo: true, ask: true, grep: true };

/**
 * Tools that carry the `xd://` transport itself and therefore can never be
 * mounted as devices: `read xd://` lists/documents devices and
 * `write xd://<tool>` executes them. Demoting either leaves every mounted
 * device unreachable (issue #5764), so they stay top-level regardless of a
 * declared `loadMode`.
 */
export const XDEV_TRANSPORT_TOOLS: Record<string, true> = { read: true, write: true };

/**
 * Whether an enabled tool is presented under `xd://` (rather than top-level)
 * while the `xd://` transport is active. Discoverable tools mount unless they
 * are pinned top-level by {@link XDEV_KEEP_TOP_LEVEL} or carry the transport
 * itself ({@link XDEV_TRANSPORT_TOOLS}); essential tools never do. The caller
 * gates this on the transport being active (a session-owned
 * {@link XdevRegistry} existing).
 */
export function isMountableUnderXdev(tool: { name: string; loadMode?: ToolLoadMode }): boolean {
	if (tool.name in XDEV_TRANSPORT_TOOLS || tool.name in XDEV_KEEP_TOP_LEVEL) return false;
	return tool.loadMode === "discoverable";
}

/** Dispatch metadata carried on write-tool details for renderer delegation. */
export interface XdevDispatch {
	tool: string;
	mode: "help" | "execute";
	/** Validated inner args, kept for renderer delegation on result rebuilds. */
	args?: Record<string, unknown>;
	/** Details object returned by the wrapped tool, when executed. */
	inner?: unknown;
}

/**
 * Renderer lookup injected by `renderers.ts` at module init. Kept as a setter
 * to avoid the xdev → renderers → tool modules → sdk → tools/index → xdev
 * import cycle.
 */
let rendererLookup: ((name: string) => ToolRenderer | undefined) | undefined;

/** Wire the wrapped-renderer lookup. Called once by `renderers.ts`. */
export function setXdevRendererLookup(lookup: (name: string) => ToolRenderer | undefined): void {
	rendererLookup = lookup;
}

/** Whether a wire JSON schema declares a top-level `i` (intent) property. */
function schemaDeclaresIntentField(schema: unknown): boolean {
	if (!schema || typeof schema !== "object" || !("properties" in schema)) return false;
	const props = schema.properties;
	return !!props && typeof props === "object" && "i" in props;
}

function renderDocs(inst: Tool, heading = "#", descriptionCap?: number): string {
	const schema = JSON.stringify(toolWireSchema(inst as AiTool), null, 1);
	let description = inst.description ?? "";
	if (descriptionCap !== undefined && description.length > descriptionCap) {
		description = `${description.slice(0, descriptionCap).trimEnd()}… (full docs: read ${XD_URL_PREFIX}${inst.name})`;
	}
	return [
		`${heading} ${inst.name}${inst.label ? ` — ${inst.label}` : ""}`,
		"",
		description,
		"",
		`${heading}# Schema`,
		"```json",
		schema,
		"```",
		`Execute by writing JSON to ${XD_URL_PREFIX}${inst.name}.`,
	].join("\n");
}

/**
 * Parse and validate a device write's JSON `content` against the wrapped
 * tool's wire schema. Strips a habitual top-level `i` (intent) unless the
 * schema declares one. Throws ToolError; schema-mismatch errors carry `docs()`
 * for repair.
 */
function parseDeviceArgs(
	device: AiTool,
	content: string,
	toolCallId: string,
	docs: () => string,
): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ToolError(
			`${XD_URL_PREFIX}${device.name} expects a JSON args object as content (${error instanceof Error ? error.message : String(error)}). Write \`?\` for docs.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ToolError(
			`${XD_URL_PREFIX}${device.name} content must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
		);
	}
	// The harness only injects the intent field into top-level schemas; strip a
	// habitual `i` from inner args unless the wrapped schema really declares it.
	const args: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	if ("i" in args && !schemaDeclaresIntentField(toolWireSchema(device))) delete args.i;
	try {
		return validateToolArguments(device, {
			type: "toolCall",
			id: toolCallId,
			name: device.name,
			arguments: args,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid args for ${XD_URL_PREFIX}${device.name}: ${message}\n\n${docs()}`);
	}
}

/** One-line catalog summary for a mounted tool: `summary`, else first description line. */
function toolSummary(inst: Tool): string {
	if (inst.summary) return inst.summary;
	const firstLine = (inst.description ?? "").split("\n").find(line => line.trim().length > 0);
	return firstLine?.trim() ?? inst.label ?? inst.name;
}

/** Decode the (possibly partially streamed) inner args JSON string into display args. */
function decodeInnerArgs(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || raw.length === 0) return {};
	const parsed = parseStreamingJson<Record<string, unknown>>(raw);
	const args: Record<string, unknown> = parsed && typeof parsed === "object" ? { ...parsed } : {};
	args.__partialJson = raw;
	return args;
}

/** Device-write content that requests docs instead of executing: empty, `?`, or `help`. */
const HELP_CONTENT_RE = /^\s*(\?|help)?\s*$/i;

/**
 * Registry of tools mounted under `xd://` for one session. `createTools`
 * mounts discoverable built-ins first; SDK assembly adds custom tools that do
 * not opt out. `read`/`write` consult it at execute time.
 */
export class XdevRegistry {
	/** Discoverable built-ins mounted at construction; never reconciled away. */
	#builtins = new Map<string, Tool>();
	/**
	 * Dynamic mounts (custom, MCP, extension, autoresearch) — replaced wholesale
	 * by {@link reconcile} as the active tool set changes, so a deactivated or
	 * disconnected tool is no longer callable through a stale device.
	 */
	#dynamic = new Map<string, Tool>();

	constructor(builtins: Iterable<Tool>) {
		for (const tool of builtins) this.#builtins.set(tool.name, tool);
	}

	/**
	 * Replace the dynamic mount set while preserving the built-in devices. Order
	 * follows `tools`; names absent from it are dropped. A built-in device is
	 * never shadowed by a same-named dynamic entry.
	 */
	reconcile(tools: Iterable<Tool>): void {
		const next = new Map<string, Tool>();
		for (const tool of tools) {
			if (this.#builtins.has(tool.name)) continue;
			next.set(tool.name, tool);
		}
		this.#dynamic = next;
	}

	get size(): number {
		return this.#builtins.size + this.#dynamic.size;
	}

	/** Mounted tools in catalog order: built-ins first, then dynamic mounts. */
	list(): readonly Tool[] {
		return [...this.#builtins.values(), ...this.#dynamic.values()];
	}

	get(name: string): Tool | undefined {
		return this.#builtins.get(name) ?? this.#dynamic.get(name);
	}

	/** `{name, summary}` pairs for prompt templates and /tools display. */
	entries(): Array<{ name: string; summary: string }> {
		return this.list().map(tool => ({ name: tool.name, summary: toolSummary(tool) }));
	}

	/** `read xd://` listing with one device per line. */
	listing(): string {
		const rows = this.entries().map(({ name, summary }) => `${XD_URL_PREFIX}${name.padEnd(14)} ${summary}`);
		return [
			`${XD_URL_PREFIX} ${this.size} mounted tool devices.`,
			...rows,
			"",
			`Read ${XD_URL_PREFIX}<tool> for docs + JSON schema; write the JSON args object to ${XD_URL_PREFIX}<tool> to execute.`,
		].join("\n");
	}

	/** Docs + schema for one device; throws with the listing when unknown. */
	docs(name: string): string {
		return renderDocs(this.#resolve(name));
	}

	/**
	 * Char budget for the full docs inlined into the system prompt. Large MCP
	 * catalogs previously shipped every schema top-level; without a cap they
	 * would bloat every request. Devices past the budget fall back to a
	 * one-line summary — their docs stay one `read xd://<tool>` away.
	 */
	static readonly DOCS_TOTAL_BUDGET = 48_000;
	/** A single device's docs above this size never inline: one pathological
	 *  MCP description must not starve every later device. */
	static readonly DOCS_PER_DEVICE_CAP = 10_000;
	/** Description cap for EXTERNAL devices (dynamic mounts: MCP, custom,
	 *  extension, …) in the system-prompt embedding. Built-in devices inline
	 *  their full curated docs; external descriptions are server-controlled
	 *  prose the model can re-fetch, so only the lede earns prompt space. */
	static readonly EXTERNAL_DESCRIPTION_CAP = 200;

	/**
	 * Docs + schema for mounted devices, nested under `##` headings for
	 * system-prompt embedding. Inlines full docs in catalog order (built-ins
	 * first) until {@link DOCS_TOTAL_BUDGET} is spent; the rest are listed by
	 * name + summary with a pointer to on-demand `read xd://<tool>` docs.
	 * Dynamic mounts embed at most {@link EXTERNAL_DESCRIPTION_CAP} description
	 * chars (schema always intact); `read xd://<tool>` returns the full text.
	 */
	docsAll(): string {
		const sections: string[] = [];
		const overflow: Tool[] = [];
		let used = 0;
		for (const tool of this.list()) {
			const descriptionCap = this.#dynamic.has(tool.name) ? XdevRegistry.EXTERNAL_DESCRIPTION_CAP : undefined;
			const docs = renderDocs(tool, "##", descriptionCap);
			if (docs.length > XdevRegistry.DOCS_PER_DEVICE_CAP || used + docs.length > XdevRegistry.DOCS_TOTAL_BUDGET) {
				overflow.push(tool);
				continue;
			}
			used += docs.length;
			sections.push(docs);
		}
		if (overflow.length > 0) {
			sections.push(
				[
					"## Additional devices (docs on demand)",
					...overflow.map(tool => `- ${XD_URL_PREFIX}${tool.name} — ${toolSummary(tool)}`),
					"",
					`Read ${XD_URL_PREFIX}<tool> for full docs + JSON schema before first use.`,
				].join("\n"),
			);
		}
		return sections.join("\n\n");
	}

	#resolve(name: string): Tool {
		const inst = this.get(name);
		if (!inst) {
			throw new ToolError(
				`No such tool device: ${XD_URL_PREFIX}${name}. Mounted: ${this.list()
					.map(tool => tool.name)
					.join(", ")}.`,
			);
		}
		return inst;
	}

	/**
	 * Execute a device write: `content` is the JSON args object (empty, `?`, or
	 * `help` returns docs). Args validate against the wrapped tool's schema —
	 * the schema comes back in the error on mismatch.
	 */
	async dispatch(
		name: string,
		content: string,
		toolCallId: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		context?: AgentToolContext,
	): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
		const inst = this.#resolve(name);

		if (HELP_CONTENT_RE.test(content)) {
			return {
				result: { content: [{ type: "text", text: renderDocs(inst) }] },
				xdev: { tool: name, mode: "help" },
			};
		}

		const validated = parseDeviceArgs(inst as AiTool, content, toolCallId, () => renderDocs(inst));

		const xdevBase: XdevDispatch = { tool: name, mode: "execute", args: validated };
		const innerOnUpdate: AgentToolUpdateCallback | undefined = onUpdate
			? partial =>
					onUpdate({
						content: partial.content,
						details: { xdev: { ...xdevBase, inner: partial.details } },
						isError: partial.isError,
					})
			: undefined;
		const result = await inst.execute(toolCallId, validated as never, signal, innerOnUpdate, context);
		return { result, xdev: { ...xdevBase, inner: result.details } };
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Render delegation (consumed by the write renderer)
// ═══════════════════════════════════════════════════════════════════════════

/** Renderer for a mounted device: the live mounted tool's own render callbacks
 *  (custom/MCP/image tools carry them) first, then the static built-in renderer
 *  map keyed by name. */
function resolveDeviceRenderer(
	name: string,
	resolveMounted: ((name: string) => Tool | undefined) | undefined,
): Pick<ToolRenderer, "renderCall" | "renderResult" | "mergeCallAndResult"> | undefined {
	const mounted = resolveMounted?.(name);
	if (mounted && (mounted.renderCall || mounted.renderResult)) {
		// A mounted AgentTool exposes the same renderCall/renderResult/mergeCallAndResult
		// surface as a static ToolRenderer; only the parameter generics differ, so unify
		// through a single cast rather than fabricating a per-field shape.
		return mounted as unknown as Pick<ToolRenderer, "renderCall" | "renderResult" | "mergeCallAndResult">;
	}
	return rendererLookup?.(name);
}

/**
 * Streaming-safe call preview for an `xd://` write: forwards the decoded inner
 * args to the mounted tool's renderer (session instance first, then the static
 * map). Returns `undefined` (render nothing) when no renderer produces output.
 */
export function renderXdevCall(
	name: string,
	content: unknown,
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | undefined {
	const renderer = resolveDeviceRenderer(name, resolveMounted);
	if (renderer?.renderCall) {
		return renderer.renderCall(decodeInnerArgs(content), options, theme);
	}
	return new Text(theme.fg("toolTitle", theme.bold(`${XD_URL_PREFIX}${name}`)), 0, 0);
}

/** Forward an `xd://` dispatch result to the mounted tool's renderer. */
export function renderXdevResult(
	dispatch: XdevDispatch,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | undefined {
	const text = result.content
		.map(block => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	if (dispatch.mode === "help") {
		return text ? new Text(theme.fg("toolOutput", replaceTabs(text)), 0, 0) : undefined;
	}
	const renderer = resolveDeviceRenderer(dispatch.tool, resolveMounted);
	const innerResult = { content: result.content, details: dispatch.inner, isError: result.isError };
	if (renderer?.renderResult) {
		const parts: Component[] = [];
		// Emulate the unmerged call+result topology inside the write block for
		// renderers that expect a separate call header.
		if (!renderer.mergeCallAndResult && renderer.renderCall) {
			const call = renderer.renderCall(dispatch.args ?? {}, { ...options, isPartial: false }, theme);
			if (call) parts.push(call);
		}
		const rendered = renderer.renderResult(innerResult, options, theme, dispatch.args ?? {});
		if (rendered) parts.push(rendered);
		if (parts.length === 1) return parts[0];
		if (parts.length > 1) {
			const box = new Container();
			for (const part of parts) box.addChild(part);
			return box;
		}
	}
	return text ? new Text(theme.fg("toolOutput", replaceTabs(text)), 0, 0) : undefined;
}
