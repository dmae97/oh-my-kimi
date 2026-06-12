/**
 * IRC tool — agent-to-agent messaging over the process-global IrcBus.
 *
 * `send` is fire-and-forget: the bus routes the message to the recipient
 * (waking idle agents with a real turn, reviving parked ones via the
 * lifecycle manager, injecting a non-interrupting aside into busy ones) and
 * returns delivery receipts immediately. Replies are real turns by the
 * recipient, observed with `wait` (or the `await: true` send sugar). `inbox`
 * drains pending messages; `list` shows every addressable peer.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, prompt } from "@oh-my-pi/pi-utils";
import { z } from "zod/v4";
import type { Settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../irc/bus";
import type { Theme } from "../modes/theme/theme";
import ircDescription from "../prompts/tools/irc.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import {
	createCachedComponent,
	formatBadge,
	formatErrorDetail,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
} from "./render-utils";

const DEFAULT_IRC_TIMEOUT_MS = 120_000;

/**
 * IRC availability: there must be someone to chat with. True for every
 * subagent (it always has a parent, and possibly siblings) and for any
 * session that can still spawn subagents through the task tool. Only a
 * top-level session with task spawning unavailable has no peers — no irc.
 */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	const maxDepth = settings.get("task.maxRecursionDepth") ?? 2;
	return maxDepth < 0 || taskDepth < maxDepth;
}

const ircSchema = z.object({
	op: z.enum(["send", "wait", "inbox", "list"]).describe("irc operation"),
	to: z.string().optional().describe('send: recipient agent id or "all"'),
	message: z.string().optional().describe("send: message body"),
	replyTo: z.string().optional().describe("send: message id being answered"),
	await: z.boolean().optional().describe('send: wait for the recipient\'s reply (invalid with to:"all")'),
	from: z.string().optional().describe("wait: only accept a message from this agent id"),
	timeoutMs: z.number().optional().describe("wait: timeout in milliseconds (0 waits indefinitely)"),
	peek: z.boolean().optional().describe("inbox: list messages without consuming them"),
});

type IrcParams = z.infer<typeof ircSchema>;

interface IrcPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
	lastActivity: number;
}

export interface IrcDetails {
	op: "send" | "wait" | "inbox" | "list";
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait` / `send await:true`; null when the wait timed out. */
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: IrcPeerInfo[];
}

function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

export class IrcTool implements AgentTool<typeof ircSchema, IrcDetails> {
	readonly name = "irc";
	readonly approval = "read" as const;
	readonly label = "IRC";
	readonly summary = "Send and receive messages between agents";
	readonly description: string;
	readonly parameters = ircSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(ircDescription);
	}

	static createIf(session: ToolSession): IrcTool | null {
		if (!isIrcEnabled(session.settings, session.taskDepth ?? 0)) return null;
		if (!session.agentRegistry || !session.getAgentId) return null;
		return new IrcTool(session);
	}

	async execute(
		_toolCallId: string,
		params: IrcParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<IrcDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<IrcDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? null;
		if (!registry) {
			return errorResult("IRC is unavailable in this session.", { op: params.op });
		}
		if (!senderId) {
			return errorResult("IRC is unavailable: caller has no agent id.", { op: params.op });
		}

		switch (params.op) {
			case "list":
				return this.#executeList(registry, senderId);
			case "send":
				return this.#executeSend(registry, senderId, params, signal);
			case "wait":
				return this.#executeWait(senderId, params, signal);
			case "inbox":
				return this.#executeInbox(senderId, params);
			default:
				return errorResult("Unknown irc op.", { op: params.op });
		}
	}

	#executeList(registry: AgentRegistry, senderId: string): AgentToolResult<IrcDetails> {
		const bus = IrcBus.global();
		const peers = registry
			.list()
			.filter(ref => ref.id !== senderId && ref.status !== "aborted")
			.map(ref => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind,
				status: ref.status,
				parentId: ref.parentId,
				unread: bus.unreadCount(ref.id),
				lastActivity: ref.lastActivity,
			}));
		const lines: string[] = [];
		if (peers.length === 0) {
			lines.push("No other agents.");
		} else {
			lines.push(`${peers.length} peer(s):`);
			for (const peer of peers) {
				const extras = [
					peer.unread > 0 ? `unread ${peer.unread}` : undefined,
					peer.parentId ? `parent ${peer.parentId}` : undefined,
					`active ${formatDuration(Date.now() - peer.lastActivity)} ago`,
				].filter(Boolean);
				lines.push(`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}] — ${extras.join(", ")}`);
			}
			if (peers.some(peer => peer.status === "parked")) {
				lines.push("");
				lines.push("Parked agents are revived automatically when you message them.");
			}
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "list", from: senderId, peers },
		};
	}

	async #executeSend(
		registry: AgentRegistry,
		senderId: string,
		params: IrcParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<IrcDetails>> {
		const to = params.to?.trim();
		const message = params.message?.trim();
		if (!to) {
			return errorResult('`to` is required for op="send".', { op: "send", from: senderId });
		}
		if (!message) {
			return errorResult('`message` is required for op="send".', { op: "send", from: senderId });
		}
		if (to === senderId) {
			return errorResult("Cannot send an IRC message to yourself.", { op: "send", from: senderId, to });
		}
		const isBroadcast = to === "all";
		if (isBroadcast && params.await) {
			return errorResult('`await` is invalid with to:"all" — broadcasts have no single replier.', {
				op: "send",
				from: senderId,
				to,
			});
		}

		const bus = IrcBus.global();
		let waited: IrcMessage | null | undefined;
		const timeoutMs = params.await ? this.#resolveTimeoutMs(params) : undefined;
		const awaitAbort = params.await ? new AbortController() : undefined;
		const awaitCancelled = new Error("IRC await cancelled");
		let removeAwaitAbortListener: (() => void) | undefined;
		const waiting = params.await
			? bus
					.wait(senderId, { from: to }, timeoutMs ?? DEFAULT_IRC_TIMEOUT_MS, awaitAbort?.signal, {
						drainPending: false,
					})
					.then(
						message => ({ message, error: null as Error | null }),
						error => ({
							message: null,
							error: error === awaitCancelled ? null : error instanceof Error ? error : new Error(String(error)),
						}),
					)
			: undefined;
		if (params.await && signal && awaitAbort) {
			if (signal.aborted) {
				awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			} else {
				const onAbort = (): void => {
					awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeAwaitAbortListener = () => signal.removeEventListener("abort", onAbort);
			}
		}

		try {
			// Broadcasts fan out to live peers only (running | idle); reviving every
			// parked agent on a broadcast would be a stampede. Direct sends go
			// through the bus unfiltered so parked recipients are revived.
			const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
			const receipts = await Promise.all(
				targets.map(target =>
					bus.send(
						{ from: senderId, to: target, body: message, replyTo: params.replyTo },
						// Awaited sends mark the sender as blocked on an answer so a
						// busy recipient that cannot reach a step boundary (async
						// disabled) auto-replies instead of stranding the sender.
						params.await ? { expectsReply: true } : undefined,
					),
				),
			);

			const lines: string[] = [];
			const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
			if (targets.length === 0) {
				lines.push("No live peers to broadcast to.");
			} else if (delivered.length === 0) {
				lines.push("No recipients received the message.");
			} else {
				lines.push(`Delivered to ${delivered.length} peer(s):`);
			}
			for (const receipt of receipts) {
				lines.push(
					receipt.outcome === "failed"
						? `- ${receipt.to}: failed — ${receipt.error ?? "unknown error"}`
						: `- ${receipt.to}: ${receipt.outcome}`,
				);
			}

			if (params.await && waiting && timeoutMs !== undefined) {
				lines.push("");
				if (delivered.length > 0) {
					const reply = await waiting;
					if (reply.error) throw reply.error;
					waited = reply.message;
					if (waited) {
						lines.push(`Reply from ${waited.from}:`);
						lines.push(waited.body);
					} else {
						lines.push(
							`No reply from ${to} within ${formatDuration(timeoutMs)}. ` +
								"They may answer later — check `inbox` or `wait` again.",
						);
					}
				} else {
					awaitAbort?.abort(awaitCancelled);
					const reply = await waiting;
					if (reply.error) throw reply.error;
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					op: "send",
					from: senderId,
					to,
					receipts,
					...(waited !== undefined ? { waited } : {}),
				},
				isError: delivered.length === 0 && targets.length > 0,
			};
		} finally {
			awaitAbort?.abort(awaitCancelled);
			removeAwaitAbortListener?.();
		}
	}

	async #executeWait(senderId: string, params: IrcParams, signal?: AbortSignal): Promise<AgentToolResult<IrcDetails>> {
		const from = params.from?.trim() || undefined;
		const timeoutMs = this.#resolveTimeoutMs(params);
		const waited = await IrcBus.global().wait(senderId, { from }, timeoutMs, signal);
		if (!waited) {
			const filterNote = from ? ` from ${from}` : "";
			return {
				content: [{ type: "text", text: `No message${filterNote} within ${formatDuration(timeoutMs)}.` }],
				details: { op: "wait", from: senderId, waited: null },
				// A clean wait timeout carries no information once consumed.
				useless: true,
			};
		}
		return {
			content: [{ type: "text", text: formatIncoming(waited) }],
			details: { op: "wait", from: senderId, waited },
		};
	}

	#executeInbox(senderId: string, params: IrcParams): AgentToolResult<IrcDetails> {
		const messages = IrcBus.global().inbox(senderId, { peek: params.peek });
		if (messages.length === 0) {
			return {
				content: [{ type: "text", text: "Inbox empty." }],
				details: { op: "inbox", from: senderId, inbox: [] },
				// An empty inbox drain carries no information once consumed.
				useless: true,
			};
		}
		const header = params.peek ? `${messages.length} unread message(s):` : `${messages.length} message(s):`;
		const lines = [header, ...messages.map(msg => `- ${formatIncoming(msg)}`)];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "inbox", from: senderId, inbox: messages },
		};
	}

	#resolveTimeoutMs(params: IrcParams): number {
		if (params.timeoutMs !== undefined) {
			return normalizeIrcTimeoutMs(params.timeoutMs);
		}
		return normalizeIrcTimeoutMs(this.session.settings.get("irc.timeoutMs"));
	}
}

function errorResult(text: string, details: IrcDetails): AgentToolResult<IrcDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}

function normalizeIrcTimeoutMs(value: number): number {
	if (value === 0) return 0; // 0 = timeout disabled
	// Negative or non-finite settings are misconfigurations — fall back to the
	// default instead of producing an instant 1 ms timeout.
	if (!Number.isFinite(value) || value < 0) return DEFAULT_IRC_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}

// =============================================================================
// TUI Renderer
// =============================================================================

type IrcRenderArgs = Partial<IrcParams>;

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const BODY_LINE_WIDTH = 100;

const PEER_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function outcomeColor(outcome: IrcDeliveryReceipt["outcome"]): ToolUIColor {
	switch (outcome) {
		case "woken":
			return "success";
		case "revived":
			return "warning";
		case "injected":
			return "accent";
		case "failed":
			return "error";
	}
}

/** Glyph + status word, matching the agent-hub status conventions. */
function peerStatusBadge(status: string, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} running`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		default:
			return theme.fg("error", `${theme.status.aborted} ${status}`);
	}
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text?.trim() ?? "";
}

/**
 * Quote-bordered message body preview. `tone` separates outbound text (dim)
 * from received text (toolOutput); a trailing dim counter marks elided lines.
 */
function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	options: { indent?: string; tone?: "dim" | "toolOutput"; collapsedLines?: number } = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const max = expanded ? BODY_LINES_EXPANDED : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const total = body.split("\n").filter(line => line.trim()).length;
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const lines = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode).map(
		line => `${indent}${quote} ${theme.fg(tone, replaceTabs(line))}`,
	);
	const hidden = total - Math.min(total, max);
	if (hidden > 0) {
		lines.push(`${indent}${quote} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
	}
	return lines;
}

/** Header title carrying the op direction: `IRC ➤ peer` out, `IRC ⟵ peer` in. */
function callTitle(args: IrcRenderArgs | undefined, theme: Theme): string {
	switch (args?.op) {
		case "send":
			return `IRC ${theme.nav.selected} ${args.to?.trim() || "…"}`;
		case "wait":
			return `IRC ${theme.nav.back} ${args.from?.trim() || "anyone"}`;
		case "inbox":
			return "IRC inbox";
		case "list":
			return "IRC peers";
		default:
			return "IRC";
	}
}

function callMeta(args: IrcRenderArgs | undefined): string[] {
	const meta: string[] = [];
	if (args?.op === "send") {
		if (args.to === "all") meta.push("broadcast");
		if (args.await) meta.push("await reply");
		if (args.replyTo) meta.push("reply");
	}
	if (args?.op === "wait" && args.timeoutMs) meta.push(`timeout ${formatDuration(args.timeoutMs)}`);
	if (args?.op === "inbox" && args.peek) meta.push("peek");
	return meta;
}

/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Shares the tool renderer's glyph + quote-border conventions so
 * cards and `irc` tool output look identical in the transcript.
 */
export function createIrcMessageCard(
	card: {
		kind: "incoming" | "autoreply" | "relay";
		from?: string;
		to?: string;
		body?: string;
		replyTo?: string;
		timestamp?: number;
	},
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const from = card.from?.trim() || "?";
	const title =
		card.kind === "incoming"
			? `IRC ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `IRC ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
				: `IRC ${from} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) {
				lines.push(...bodyLines(body, expanded, uiTheme, { indent: "  ", collapsedLines: 3 }));
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

function renderSendResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const receipts = details.receipts ?? [];
	const to = details.to ?? args?.to?.trim() ?? "?";
	const title = `IRC ${theme.nav.selected} ${to}`;

	// Pre-delivery failures (validation) and empty broadcasts carry no receipts.
	if (receipts.length === 0) {
		const text = textContent(result) || (result.isError ? "Send failed." : "Nothing to deliver.");
		return [
			renderStatusLine({ icon: result.isError ? "error" : "warning", title }, theme),
			result.isError ? formatErrorDetail(text, theme) : `  ${theme.fg("muted", replaceTabs(text))}`,
		];
	}

	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	const failedCount = receipts.length - delivered.length;
	const waited = details.waited;
	const timedOut = waited === null;

	const meta: string[] = [];
	if (to === "all") meta.push("broadcast");
	if (receipts.length === 1) {
		const receipt = receipts[0]!;
		meta.push(theme.fg(outcomeColor(receipt.outcome), receipt.outcome));
	} else {
		if (delivered.length > 0) meta.push(theme.fg("success", `${delivered.length} delivered`));
		if (failedCount > 0) meta.push(theme.fg("error", `${failedCount} failed`));
	}
	if (timedOut) meta.push(theme.fg("warning", "no reply"));

	const icon = result.isError
		? { icon: "error" as const }
		: timedOut
			? { icon: "warning" as const }
			: { iconOverride: ircGlyph(theme) };
	const lines = [renderStatusLine({ ...icon, title, meta }, theme)];

	const sent = args?.message?.trim();
	if (sent) lines.push(...bodyLines(sent, expanded, theme, { indent: "  ", tone: "dim" }));

	if (receipts.length > 1 || failedCount > 0) {
		lines.push(
			...renderTreeList<IrcDeliveryReceipt>(
				{
					items: receipts,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "recipient",
					renderItem: receipt => {
						const badge = formatBadge(receipt.outcome, outcomeColor(receipt.outcome), theme);
						const error =
							receipt.outcome === "failed" && receipt.error
								? ` ${theme.fg("error", `${theme.format.dash} ${receipt.error}`)}`
								: "";
						return `${theme.fg("toolOutput", receipt.to)} ${badge}${error}`;
					},
				},
				theme,
			),
		);
	}

	if (waited) {
		const age = messageAge(waited.ts);
		lines.push(
			`  ${theme.fg("dim", theme.nav.back)} ${theme.fg("accent", waited.from)}${age ? ` ${theme.fg("dim", age)}` : ""}`,
		);
		lines.push(...bodyLines(waited.body, expanded, theme, { indent: "  " }));
	} else if (timedOut) {
		lines.push(`  ${theme.fg("warning", "No reply yet — they may answer later; check inbox or wait again.")}`);
	}
	return lines;
}

function renderWaitResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const waited = details.waited;
	if (!waited) {
		const text = textContent(result) || "No message arrived.";
		return [
			renderStatusLine(
				{ icon: "warning", title: `IRC ${theme.nav.back} ${args?.from?.trim() || "anyone"}`, meta: ["timed out"] },
				theme,
			),
			`  ${theme.fg("muted", replaceTabs(text))}`,
		];
	}
	const meta = [messageAge(waited.ts)];
	if (waited.replyTo) meta.push("reply");
	return [
		renderStatusLine({ iconOverride: ircGlyph(theme), title: `IRC ${theme.nav.back} ${waited.from}`, meta }, theme),
		...bodyLines(waited.body, expanded, theme, { indent: "  " }),
	];
}

function renderInboxResult(
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const messages = details.inbox ?? [];
	if (messages.length === 0) {
		return [renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta: ["empty"] }, theme)];
	}
	const meta = [`${messages.length} ${messages.length === 1 ? "message" : "messages"}`];
	if (args?.peek) meta.push("peek");
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta }, theme);
	const items = renderTreeList<IrcMessage>(
		{
			items: messages,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "message",
			renderItem: msg => {
				const age = messageAge(msg.ts);
				const replyBadge = msg.replyTo ? ` ${formatBadge("reply", "muted", theme)}` : "";
				const head = `${theme.fg("accent", msg.from)}${age ? ` ${theme.fg("dim", age)}` : ""}${replyBadge}`;
				return [head, ...bodyLines(msg.body, expanded, theme, { collapsedLines: 1 })];
			},
		},
		theme,
	);
	return [header, ...items];
}

function renderListResult(details: Partial<IrcDetails>, expanded: boolean, theme: Theme): string[] {
	const peers = [...(details.peers ?? [])].sort(
		(a, b) =>
			(PEER_STATUS_ORDER[a.status] ?? 9) - (PEER_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
	);
	if (peers.length === 0) {
		return [renderStatusLine({ icon: "info", title: "IRC peers", meta: ["no other agents"] }, theme)];
	}
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.status, (counts.get(peer.status) ?? 0) + 1);
	const meta = [...counts].map(([status, count]) => `${count} ${status}`);
	const unreadTotal = peers.reduce((sum, peer) => sum + peer.unread, 0);
	if (unreadTotal > 0) meta.push(theme.fg("warning", `${unreadTotal} unread`));
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC peers", meta }, theme);
	const items = renderTreeList(
		{
			items: peers,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "peer",
			renderItem: peer => {
				const kindText = peer.parentId ? `${peer.kind}${theme.sep.dot}of ${peer.parentId}` : peer.kind;
				const unread = peer.unread > 0 ? ` ${formatBadge(`${peer.unread} unread`, "warning", theme)}` : "";
				const age = messageAge(peer.lastActivity);
				return `${peerStatusBadge(peer.status, theme)} ${theme.bold(replaceTabs(peer.id))} ${theme.fg("dim", kindText)}${unread}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			},
		},
		theme,
	);
	return [header, ...items];
}

function buildResultLines(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<IrcDetails>,
	args: IrcRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	switch (details.op ?? args?.op) {
		case "send":
			return renderSendResult(result, details, args, expanded, theme);
		case "wait":
			return renderWaitResult(result, details, args, expanded, theme);
		case "inbox":
			return renderInboxResult(details, args, expanded, theme);
		case "list":
			return renderListResult(details, expanded, theme);
		default: {
			const text = textContent(result) || (result.isError ? "IRC call failed." : "Done.");
			return [
				renderStatusLine({ icon: result.isError ? "error" : "success", title: callTitle(args, theme) }, theme),
				result.isError ? formatErrorDetail(text, theme) : `  ${theme.fg("muted", replaceTabs(text))}`,
			];
		}
	}
}

export const ircToolRenderer = {
	inline: true,
	mergeCallAndResult: true,

	renderCall(args: IrcRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const lines = [
			renderStatusLine({ icon: "pending", title: callTitle(args, uiTheme), meta: callMeta(args) }, uiTheme),
		];
		if (args?.op === "send" && args.message?.trim()) {
			lines.push(...bodyLines(args.message, false, uiTheme, { indent: "  ", tone: "dim", collapsedLines: 1 }));
		}
		return new Text(lines.join("\n"), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: IrcDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: IrcRenderArgs,
	): Component {
		const details: Partial<IrcDetails> = result.details ?? {};
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) =>
				buildResultLines(result, details, args, expanded, uiTheme).map(line =>
					truncateToWidth(line, width, Ellipsis.Unicode),
				),
		);
	},
};
