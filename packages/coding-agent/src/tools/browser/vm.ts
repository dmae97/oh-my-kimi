import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "linkedom";
import type { ElementHandle, KeyInput, Page, SerializedAXNode } from "puppeteer-core";
import type { ToolSession } from "../../sdk";
import { resizeImage } from "../../utils/image-resize";
import { expandPath, resolveToCwd } from "../path-utils";
import { formatScreenshot } from "../render-utils";
import { ToolError, throwIfAborted } from "../tool-errors";
import { DEFAULT_VIEWPORT } from "./launch";
import { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./readable";
import { clearElementCache, resolveCachedHandle, type TabHandle } from "./registry";

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
	};
}

export interface ObservationEntry {
	id: number;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

export interface Observation {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: {
		x: number;
		y: number;
		width: number;
		height: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	elements: ObservationEntry[];
}

const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

function normalizeSelector(selector: string): string {
	if (!selector) return selector;
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) {
		return `text/${selector.slice("p-text/".length)}`;
	}
	if (selector.startsWith("p-xpath/")) {
		return `xpath/${selector.slice("p-xpath/".length)}`;
	}
	if (selector.startsWith("p-pierce/")) {
		return `pierce/${selector.slice("p-pierce/".length)}`;
	}
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

function isInteractiveNode(node: SerializedAXNode): boolean {
	if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

async function collectObservationEntries(
	tab: TabHandle,
	node: SerializedAXNode,
	entries: ObservationEntry[],
	options: { viewportOnly: boolean; includeAll: boolean },
): Promise<void> {
	if (options.includeAll || isInteractiveNode(node)) {
		const handle = await node.elementHandle();
		if (handle) {
			let inViewport = true;
			if (options.viewportOnly) {
				try {
					inViewport = await handle.isIntersectingViewport();
				} catch {
					inViewport = false;
				}
			}
			if (inViewport) {
				const id = ++tab.elementCounter;
				const states: string[] = [];
				if (node.disabled) states.push("disabled");
				if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
				if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
				if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
				if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
				if (node.required) states.push("required");
				if (node.readonly) states.push("readonly");
				if (node.multiselectable) states.push("multiselectable");
				if (node.multiline) states.push("multiline");
				if (node.modal) states.push("modal");
				if (node.focused) states.push("focused");
				tab.elementCache.set(id, handle);
				entries.push({
					id,
					role: node.role,
					name: node.name,
					value: node.value,
					description: node.description,
					keyshortcuts: node.keyshortcuts,
					states,
				});
			} else {
				await handle.dispose();
			}
		}
	}
	for (const child of node.children ?? []) {
		await collectObservationEntries(tab, child, entries, options);
	}
}

export async function collectObservation(
	tab: TabHandle,
	options: { includeAll?: boolean; viewportOnly?: boolean; signal?: AbortSignal },
): Promise<Observation> {
	clearElementCache(tab);
	const includeAll = options.includeAll ?? false;
	const viewportOnly = options.viewportOnly ?? false;
	const snapshot = (await untilAborted(options.signal, () =>
		tab.page.accessibility.snapshot({ interestingOnly: !includeAll }),
	)) as SerializedAXNode | null;
	if (!snapshot) {
		throw new ToolError("Accessibility snapshot unavailable");
	}
	const entries: ObservationEntry[] = [];
	await collectObservationEntries(tab, snapshot, entries, { includeAll, viewportOnly });
	const scroll = (await untilAborted(options.signal, () =>
		tab.page.evaluate(() => {
			const win = globalThis as unknown as {
				scrollX: number;
				scrollY: number;
				innerWidth: number;
				innerHeight: number;
				document: { documentElement: { scrollWidth: number; scrollHeight: number } };
			};
			const doc = win.document.documentElement;
			return {
				x: win.scrollX,
				y: win.scrollY,
				width: win.innerWidth,
				height: win.innerHeight,
				scrollWidth: doc.scrollWidth,
				scrollHeight: doc.scrollHeight,
			};
		}),
	)) as Observation["scroll"];
	const url = tab.page.url();
	const title = (await untilAborted(options.signal, () => tab.page.title())) as string;
	const viewport = tab.page.viewport() ?? DEFAULT_VIEWPORT;
	return { url, title, viewport, scroll, elements: entries };
}

export function formatObservation(observation: Observation): string {
	const viewport = `${observation.viewport.width}x${observation.viewport.height}`;
	const scroll = `x=${observation.scroll.x} y=${observation.scroll.y} viewport=${observation.scroll.width}x${observation.scroll.height} doc=${observation.scroll.scrollWidth}x${observation.scroll.scrollHeight}`;
	const lines = [
		`URL: ${observation.url}`,
		observation.title ? `Title: ${observation.title}` : "Title:",
		`Viewport: ${viewport}`,
		`Scroll: ${scroll}`,
		"Elements:",
	];
	for (const entry of observation.elements) {
		const name = entry.name ? ` "${entry.name}"` : "";
		const value = entry.value !== undefined ? ` value=${JSON.stringify(entry.value)}` : "";
		const description = entry.description ? ` desc=${JSON.stringify(entry.description)}` : "";
		const shortcuts = entry.keyshortcuts ? ` shortcuts=${JSON.stringify(entry.keyshortcuts)}` : "";
		const state = entry.states.length ? ` (${entry.states.join(", ")})` : "";
		lines.push(`${entry.id}. ${entry.role}${name}${value}${description}${shortcuts}${state}`);
	}
	return lines.join("\n");
}

// =====================================================================
// Click resolution helpers (text/aria selectors with visibility filtering)
// =====================================================================

type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };

async function resolveActionableQueryHandlerClickTarget(handles: ElementHandle[]): Promise<ElementHandle | null> {
	const candidates: Array<{
		handle: ElementHandle;
		rect: { x: number; y: number; w: number; h: number };
		ownedProxy?: ElementHandle;
	}> = [];

	for (const handle of handles) {
		let clickable: ElementHandle = handle;
		let clickableProxy: ElementHandle | null = null;
		try {
			const proxy = await handle.evaluateHandle(el => {
				const target =
					(el as Element).closest(
						'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]',
					) ?? el;
				return target;
			});
			const nodeHandle = proxy.asElement();
			clickableProxy = nodeHandle ? (nodeHandle as unknown as ElementHandle) : null;
			if (clickableProxy) {
				clickable = clickableProxy;
			}
		} catch {
			// ignore
		}

		try {
			const intersecting = await clickable.isIntersectingViewport();
			if (!intersecting) continue;
			const rect = (await clickable.evaluate(el => {
				const r = (el as Element).getBoundingClientRect();
				return { x: r.left, y: r.top, w: r.width, h: r.height };
			})) as { x: number; y: number; w: number; h: number };
			if (rect.w < 1 || rect.h < 1) continue;
			candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? undefined });
		} catch {
			// ignore
		} finally {
			if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
				try {
					await clickableProxy.dispose();
				} catch {}
			}
		}
	}

	if (!candidates.length) return null;

	candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const winner = candidates[0]?.handle ?? null;
	for (let i = 1; i < candidates.length; i++) {
		const c = candidates[i]!;
		if (c.ownedProxy) {
			try {
				await c.ownedProxy.dispose();
			} catch {}
		}
	}
	return winner;
}

async function isClickActionable(handle: ElementHandle): Promise<ActionabilityResult> {
	return (await handle.evaluate(el => {
		const element = el as HTMLElement;
		const style = globalThis.getComputedStyle(element);
		if (style.display === "none") return { ok: false as const, reason: "display:none" };
		if (style.visibility === "hidden") return { ok: false as const, reason: "visibility:hidden" };
		if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
		if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };

		const r = element.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return { ok: false as const, reason: "zero-size" };

		const vw = globalThis.innerWidth;
		const vh = globalThis.innerHeight;
		const left = Math.max(0, Math.min(vw, r.left));
		const right = Math.max(0, Math.min(vw, r.right));
		const top = Math.max(0, Math.min(vh, r.top));
		const bottom = Math.max(0, Math.min(vh, r.bottom));
		if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };

		const x = Math.floor((left + right) / 2);
		const y = Math.floor((top + bottom) / 2);
		const topEl = globalThis.document.elementFromPoint(x, y);
		if (!topEl) return { ok: false as const, reason: "elementFromPoint-null" };
		if (topEl === element || element.contains(topEl) || (topEl as Element).contains(element)) {
			return { ok: true as const, x, y };
		}
		return { ok: false as const, reason: "obscured" };
	})) as ActionabilityResult;
}

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const start = Date.now();
	let lastSeen = 0;
	let lastReason: string | null = null;

	while (Date.now() - start < timeoutMs) {
		throwIfAborted(clickSignal);
		const handles = (await untilAborted(clickSignal, () => page.$$(selector))) as ElementHandle[];
		try {
			lastSeen = handles.length;
			const target = await resolveActionableQueryHandlerClickTarget(handles);
			if (!target) {
				lastReason = handles.length ? "no-visible-candidate" : "no-matches";
				await Bun.sleep(100);
				continue;
			}
			const actionability = await isClickActionable(target);
			if (!actionability.ok) {
				lastReason = actionability.reason;
				await Bun.sleep(100);
				continue;
			}

			try {
				await untilAborted(clickSignal, () => target.click());
				return;
			} catch (err) {
				lastReason = err instanceof Error ? err.message : String(err);
				await Bun.sleep(100);
			}
		} finally {
			await Promise.all(
				handles.map(async h => {
					try {
						await h.dispose();
					} catch {}
				}),
			);
		}
	}

	throw new ToolError(
		`Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). ` +
			"If there are multiple matching elements, use observe + tab.id() or a more specific selector.",
	);
}

// =====================================================================
// Tab API surface (visible to user code as `tab`)
// =====================================================================

export interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	save?: string;
	silent?: boolean;
}

export interface ScreenshotResult {
	dest: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
}

export interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<Observation>;
	screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
	extract(format?: ReadableFormat): Promise<ReadableResult | null>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: KeyInput, opts?: { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	drag(fromSelector: string, toSelector: string): Promise<void>;
	waitFor(selector: string): Promise<void>;
	id(n: number): Promise<ElementHandle>;
}

export interface RunInTabOptions {
	tab: TabHandle;
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface RunInTabResult {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ScreenshotResult[];
}

const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export async function runInTab(opts: RunInTabOptions): Promise<RunInTabResult> {
	const { tab, code, timeoutMs, signal, session } = opts;
	const displays: Array<TextContent | ImageContent> = [];
	const screenshots: ScreenshotResult[] = [];

	const display = (value: unknown): void => {
		if (value === undefined || value === null) return;
		if (
			typeof value === "object" &&
			value !== null &&
			"type" in (value as Record<string, unknown>) &&
			(value as { type?: unknown }).type === "image"
		) {
			const img = value as { data?: unknown; mimeType?: unknown };
			if (typeof img.data === "string" && typeof img.mimeType === "string") {
				displays.push({ type: "image", data: img.data, mimeType: img.mimeType });
				return;
			}
		}
		if (typeof value === "string") {
			displays.push({ type: "text", text: value });
			return;
		}
		try {
			displays.push({ type: "text", text: JSON.stringify(value, null, 2) });
		} catch {
			displays.push({ type: "text", text: String(value) });
		}
	};

	const assertFn = (cond: unknown, msg?: string): void => {
		if (!cond) throw new ToolError(msg ?? "Assertion failed");
	};

	const wait = (ms: number): Promise<void> => Bun.sleep(ms);

	const tabApi: TabApi = {
		name: tab.name,
		page: tab.page,
		signal,
		url: () => tab.page.url(),
		title: () => tab.page.title(),
		goto: async (url, gOpts) => {
			clearElementCache(tab);
			await untilAborted(signal, () =>
				tab.page.goto(url, {
					waitUntil: gOpts?.waitUntil ?? "networkidle2",
					timeout: timeoutMs,
				}),
			);
		},
		observe: opts2 => collectObservation(tab, { ...opts2, signal }),
		screenshot: async opts2 => {
			const result = await captureScreenshot(tab, session, displays, screenshots, signal, opts2);
			return result;
		},
		extract: async (format = "markdown") => {
			const html = (await untilAborted(signal, () => tab.page.content())) as string;
			return extractReadableFromHtml(html, tab.page.url(), format);
		},
		click: async selector => {
			const resolved = normalizeSelector(selector);
			if (resolved.startsWith("text/")) {
				await clickQueryHandlerText(tab.page, resolved, timeoutMs, signal);
			} else {
				const locator = tab.page.locator(resolved).setTimeout(timeoutMs);
				await untilAborted(signal, () => locator.click());
			}
		},
		type: async (selector, text) => {
			const resolved = normalizeSelector(selector);
			const locator = tab.page.locator(resolved).setTimeout(timeoutMs);
			const handle = (await untilAborted(signal, () => locator.waitHandle())) as ElementHandle;
			try {
				await untilAborted(signal, () => handle.type(text, { delay: 0 }));
			} finally {
				await handle.dispose();
			}
		},
		fill: async (selector, value) => {
			const resolved = normalizeSelector(selector);
			const locator = tab.page.locator(resolved).setTimeout(timeoutMs);
			await untilAborted(signal, () => locator.fill(value));
		},
		press: async (key, opts2) => {
			if (opts2?.selector) {
				const resolved = normalizeSelector(opts2.selector);
				await untilAborted(signal, () => tab.page.focus(resolved));
			}
			await untilAborted(signal, () => tab.page.keyboard.press(key));
		},
		scroll: async (deltaX, deltaY) => {
			await untilAborted(signal, () => tab.page.mouse.wheel({ deltaX, deltaY }));
		},
		drag: async (fromSelector, toSelector) => {
			const fromResolved = normalizeSelector(fromSelector);
			const toResolved = normalizeSelector(toSelector);
			const fromHandle = (await untilAborted(signal, () => tab.page.$(fromResolved))) as ElementHandle | null;
			const toHandle = (await untilAborted(signal, () => tab.page.$(toResolved))) as ElementHandle | null;
			if (!fromHandle || !toHandle) {
				throw new ToolError("Drag selectors did not resolve to elements");
			}
			try {
				const fromBox = (await untilAborted(signal, () => fromHandle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				const toBox = (await untilAborted(signal, () => toHandle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!fromBox || !toBox) {
					throw new ToolError("Drag elements are not visible");
				}
				const startX = fromBox.x + fromBox.width / 2;
				const startY = fromBox.y + fromBox.height / 2;
				const endX = toBox.x + toBox.width / 2;
				const endY = toBox.y + toBox.height / 2;
				await untilAborted(signal, () => tab.page.mouse.move(startX, startY));
				await untilAborted(signal, () => tab.page.mouse.down());
				await untilAborted(signal, () => tab.page.mouse.move(endX, endY, { steps: 12 }));
				await untilAborted(signal, () => tab.page.mouse.up());
			} finally {
				await fromHandle.dispose().catch(() => undefined);
				await toHandle.dispose().catch(() => undefined);
			}
		},
		waitFor: async selector => {
			const resolved = normalizeSelector(selector);
			const locator = tab.page.locator(resolved).setTimeout(timeoutMs);
			await untilAborted(signal, () => locator.wait());
		},
		id: async n => resolveCachedHandle(tab, n),
	};

	const fn = new AsyncFunctionCtor("page", "browser", "tab", "display", "assert", "wait", code);
	const returnValue = await fn(tab.page, tab.browser.browser, tabApi, display, assertFn, wait);
	return { displays, returnValue, screenshots };
}

async function captureScreenshot(
	tab: TabHandle,
	session: ToolSession,
	displays: Array<TextContent | ImageContent>,
	screenshots: ScreenshotResult[],
	signal: AbortSignal | undefined,
	opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
	const fullPage = opts.selector ? false : (opts.fullPage ?? false);
	let buffer: Buffer;
	if (opts.selector) {
		const resolved = normalizeSelector(opts.selector);
		const handle = (await untilAborted(signal, () => tab.page.$(resolved))) as ElementHandle | null;
		if (!handle) {
			throw new ToolError("Screenshot selector did not resolve to an element");
		}
		try {
			buffer = (await untilAborted(signal, () => handle.screenshot({ type: "png" }))) as Buffer;
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	} else {
		buffer = (await untilAborted(signal, () => tab.page.screenshot({ type: "png", fullPage }))) as Buffer;
	}

	// Compress aggressively for the model copy.
	const resized = await resizeImage(
		{ type: "image", data: buffer.toBase64(), mimeType: "image/png" },
		{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
	);

	const screenshotDir = (() => {
		const v = session.settings.get("browser.screenshotDir") as string | undefined;
		return v ? expandPath(v) : undefined;
	})();
	const explicitPath = opts.save ? resolveToCwd(opts.save, session.cwd) : undefined;
	let dest: string;
	if (explicitPath) {
		dest = explicitPath;
	} else if (screenshotDir) {
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
		dest = path.join(screenshotDir, `screenshot-${ts}.png`);
	} else {
		dest = path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.png`);
	}
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	const saveFullRes = !!(explicitPath || screenshotDir);
	const savedBuffer = saveFullRes ? buffer : resized.buffer;
	const savedMimeType = saveFullRes ? "image/png" : resized.mimeType;
	await Bun.write(dest, savedBuffer);

	const info: ScreenshotResult = {
		dest,
		mimeType: savedMimeType,
		bytes: savedBuffer.length,
		width: resized.width,
		height: resized.height,
	};
	screenshots.push(info);

	if (!opts.silent) {
		const lines = formatScreenshot({
			saveFullRes,
			savedMimeType,
			savedByteLength: savedBuffer.length,
			dest,
			resized,
		});
		displays.push({ type: "text", text: lines.join("\n") });
		displays.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
	}

	return info;
}
