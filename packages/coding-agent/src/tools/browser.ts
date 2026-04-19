import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readability } from "@mozilla/readability";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { $which, getPuppeteerDir, logger, prompt, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { type HTMLElement, parseHTML } from "linkedom";
import type {
	Browser,
	CDPSession,
	ElementHandle,
	KeyInput,
	Page,
	default as Puppeteer,
	SerializedAXNode,
} from "puppeteer";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { resizeImage } from "../utils/image-resize";
import { htmlToBasicMarkdown } from "../web/scrapers/types";
import type { OutputMeta } from "./output-meta";
import { expandPath, resolveToCwd } from "./path-utils";
import stealthTamperingScript from "./puppeteer/00_stealth_tampering.txt" with { type: "text" };
import stealthActivityScript from "./puppeteer/01_stealth_activity.txt" with { type: "text" };
import stealthHairlineScript from "./puppeteer/02_stealth_hairline.txt" with { type: "text" };
import stealthBotdScript from "./puppeteer/03_stealth_botd.txt" with { type: "text" };
import stealthIframeScript from "./puppeteer/04_stealth_iframe.txt" with { type: "text" };
import stealthWebglScript from "./puppeteer/05_stealth_webgl.txt" with { type: "text" };
import stealthScreenScript from "./puppeteer/06_stealth_screen.txt" with { type: "text" };
import stealthFontsScript from "./puppeteer/07_stealth_fonts.txt" with { type: "text" };
import stealthAudioScript from "./puppeteer/08_stealth_audio.txt" with { type: "text" };
import stealthLocaleScript from "./puppeteer/09_stealth_locale.txt" with { type: "text" };
import stealthPluginsScript from "./puppeteer/10_stealth_plugins.txt" with { type: "text" };
import stealthHardwareScript from "./puppeteer/11_stealth_hardware.txt" with { type: "text" };
import stealthCodecsScript from "./puppeteer/12_stealth_codecs.txt" with { type: "text" };
import stealthWorkerScript from "./puppeteer/13_stealth_worker.txt" with { type: "text" };
import { formatScreenshot } from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

/**
 * Lazy-import puppeteer from a safe CWD so cosmiconfig doesn't choke
 * on malformed package.json files in the user's project tree.
 */
let puppeteerModule: typeof Puppeteer | undefined;
async function loadPuppeteer(): Promise<typeof Puppeteer> {
	if (puppeteerModule) return puppeteerModule;
	const prev = process.cwd();
	const safeDir = getPuppeteerDir();
	await Bun.write(path.join(safeDir, "package.json"), "{}");
	try {
		process.chdir(safeDir);
		puppeteerModule = (await import("puppeteer")).default;
		return puppeteerModule;
	} finally {
		process.chdir(prev);
	}
}

/**
 * On NixOS, Puppeteer's bundled Chromium is a dynamically-linked FHS binary and
 * cannot run as-is. Detect the platform and resolve a system-installed Chromium
 * so `puppeteer.launch()` can use it instead of the bundled one.
 *
 * Detection order:
 *   1. `chromium` on PATH
 *   2. `chromium-browser` on PATH
 *   3. ~/.nix-profile/bin/chromium  (user profile)
 *   4. /run/current-system/sw/bin/chromium  (system profile)
 *
 * Returns `undefined` on non-NixOS systems or when no binary is found, which
 * causes Puppeteer to fall back to its default resolution.
 */
let _resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found
function resolveSystemChromium(): string | undefined {
	if (_resolvedChromium !== undefined) return _resolvedChromium ?? undefined;
	try {
		if (!fs.existsSync("/etc/NIXOS")) {
			_resolvedChromium = null;
			return undefined;
		}
	} catch {
		_resolvedChromium = null;
		return undefined;
	}
	const candidates = [
		$which("chromium"),
		$which("chromium-browser"),
		path.join(os.homedir(), ".nix-profile/bin/chromium"),
		"/run/current-system/sw/bin/chromium",
	];
	for (const candidate of candidates) {
		if (candidate) {
			try {
				if (fs.existsSync(candidate)) {
					_resolvedChromium = candidate;
					logger.debug("NixOS: using system Chromium", { path: candidate });
					return candidate;
				}
			} catch {}
		}
	}
	_resolvedChromium = null;
	logger.debug("NixOS detected but no Chromium binary found; Puppeteer may fail to launch");
	return undefined;
}

const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };
const STEALTH_IGNORE_DEFAULT_ARGS = [
	"--disable-extensions",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
];
const STEALTH_ACCEPT_LANGUAGE = "en-US,en";
const PUPPETEER_SOURCE_URL_SUFFIX = "//# sourceURL=__puppeteer_evaluation_script__";
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

declare global {
	interface Element extends HTMLElement {}

	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
	};
}

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
		// Playwright-style: p-aria/[name="Sign in"] → aria/Sign in
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

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

	// Prefer top-most visible element (nav/header usually wins), tie-break by left-most.
	candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const winner = candidates[0]?.handle ?? null;
	// Dispose owned proxies for non-winning candidates
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
			"If there are multiple matching elements, use observe+click_id or a more specific selector.",
	);
}

/**
 * Stealth init scripts for Puppeteer.
 */

type PuppeteerCdpClient = {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

type UserAgentOverride = {
	userAgent: string;
	platform: string;
	acceptLanguage: string;
	userAgentMetadata: {
		brands: Array<{ brand: string; version: string }>;
		fullVersion: string;
		platform: string;
		platformVersion: string;
		architecture: string;
		model: string;
		mobile: boolean;
	};
};

function resolvePageClient(page: Page): PuppeteerCdpClient | null {
	const pageWithClient = page as Page & {
		_client?: (() => PuppeteerCdpClient) | PuppeteerCdpClient;
	};
	if (!pageWithClient._client) return null;
	return typeof pageWithClient._client === "function" ? pageWithClient._client() : pageWithClient._client;
}

const puppeteerGetArgsSchema = Type.Array(
	Type.Object({
		selector: Type.String({
			description:
				"Selector for the target element (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
		attribute: Type.Optional(Type.String({ description: "Attribute name (get_attribute)" })),
	}),
	{ description: "Batch arguments for get_* actions", minItems: 1 },
);

const browserSchema = Type.Object({
	action: StringEnum(
		[
			"open",
			"goto",
			"observe",
			"click",
			"click_id",
			"type",
			"type_id",
			"fill",
			"fill_id",
			"press",
			"scroll",
			"drag",
			"wait_for_selector",
			"evaluate",
			"get_text",
			"get_html",
			"get_attribute",
			"extract_readable",
			"screenshot",
			"close",
		],
		{ description: "Action to perform" },
	),
	url: Type.Optional(Type.String({ description: "URL to navigate to (goto)" })),
	selector: Type.Optional(
		Type.String({
			description:
				"Selector for the target element (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
	),
	element_id: Type.Optional(Type.Number({ description: "Element ID from observe" })),
	include_all: Type.Optional(Type.Boolean({ description: "Include non-interactive nodes in observe" })),
	viewport_only: Type.Optional(Type.Boolean({ description: "Limit observe output to elements in the viewport" })),
	args: Type.Optional(puppeteerGetArgsSchema),
	script: Type.Optional(Type.String({ description: "JavaScript to evaluate (evaluate)" })),
	text: Type.Optional(Type.String({ description: "Text to type (type)" })),
	value: Type.Optional(Type.String({ description: "Value to set (fill)" })),
	attribute: Type.Optional(Type.String({ description: "Attribute name to read (get_attribute)" })),
	key: Type.Optional(Type.String({ description: "Keyboard key to press (press)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds", default: 30 })),
	wait_until: Type.Optional(
		StringEnum(["load", "domcontentloaded", "networkidle0", "networkidle2"], {
			description: "Navigation wait condition (goto)",
		}),
	),
	full_page: Type.Optional(Type.Boolean({ description: "Capture full page screenshot (screenshot)" })),
	format: Type.Optional(
		StringEnum(["text", "markdown"], {
			description: "Output format for extract_readable (text/markdown)",
		}),
	),
	path: Type.Optional(Type.String({ description: "Optional path to save screenshot (relative to cwd)" })),
	viewport: Type.Optional(
		Type.Object({
			width: Type.Number({ description: "Viewport width in pixels" }),
			height: Type.Number({ description: "Viewport height in pixels" }),
			device_scale_factor: Type.Optional(Type.Number({ description: "Device scale factor" })),
		}),
	),
	delta_x: Type.Optional(Type.Number({ description: "Scroll delta X (scroll)" })),
	delta_y: Type.Optional(Type.Number({ description: "Scroll delta Y (scroll)" })),
	from_selector: Type.Optional(
		Type.String({
			description:
				"Drag start selector (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
	),
	to_selector: Type.Optional(
		Type.String({
			description:
				"Drag end selector (CSS, or puppeteer query handler like aria/, text/, xpath/, pierce/; also accepts legacy p- prefixes)",
		}),
	),
});

/** Input schema for the Puppeteer tool. */
export type BrowserParams = Static<typeof browserSchema>;

/** Details describing a Puppeteer tool execution result. */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	url?: string;
	selector?: string;
	elementId?: number;
	result?: string | string[];
	screenshotPath?: string;
	mimeType?: string;
	bytes?: number;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	readable?: ReadableResult;
	meta?: OutputMeta;
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

export interface ReadableResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	contentLength: number;
	text?: string;
	markdown?: string;
}

type ReadableFormat = "text" | "markdown";

/** Trim to non-empty string or undefined. */
function normalize(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

/**
 * Extract readable content from raw HTML.
 * Tries Readability (article-isolation scoring) first, then falls back to a
 * CSS selector chain over the same pre-parsed DOM. Returns null if neither
 * path yields usable content.
 */
export function extractReadableFromHtml(html: string, url: string, format: ReadableFormat): ReadableResult | null {
	const { document } = parseHTML(html);

	// --- Primary: Readability article extraction ---
	const article = new Readability(document).parse();
	if (article) {
		const result = toReadableResult(url, format, article.textContent, article.content, {
			title: article.title,
			byline: article.byline,
			excerpt: article.excerpt,
			length: article.length,
		});
		if (result) return result;
	}

	// --- Fallback: CSS selector chain ---
	const candidates = [
		document.querySelector("[data-pagefind-body]"),
		document.querySelector("main article"),
		document.querySelector("article"),
		document.querySelector("main"),
		document.querySelector("[role='main']"),
		document.body,
	];
	for (const el of candidates) {
		if (!el) continue;
		const innerHTML = el.innerHTML?.trim();
		const textContent = el.textContent?.trim();
		if (!innerHTML || !textContent) continue;
		const result = toReadableResult(url, format, textContent, innerHTML, {
			title: document.title,
			excerpt: textContent.slice(0, 240),
			length: textContent.length,
		});
		if (result) return result;
	}

	return null;
}

/** Shared builder for both extraction paths. */
function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
): ReadableResult | null {
	const text = normalize(textContent);
	const markdown = format === "markdown" ? (normalize(htmlToBasicMarkdown(htmlContent ?? "")) ?? text) : undefined;
	const normalizedText = format === "text" ? text : undefined;
	if (!normalizedText && !markdown) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: meta.length ?? text?.length ?? markdown?.length ?? 0,
		text: normalizedText,
		markdown,
	};
}

function ensureParam<T>(value: T | undefined, name: string, action: string): T {
	if (value === undefined || value === null || value === "") {
		throw new ToolError(`Missing required parameter '${name}' for action '${action}'.`);
	}
	return value;
}

function formatEvaluateResult(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? "undefined";
	} catch {
		return String(value);
	}
}

/**
 * Puppeteer tool for headless browser automation.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "puppeteer";
	readonly label = "Puppeteer";
	readonly description: string;
	readonly parameters = browserSchema;
	readonly strict = true;
	#browser: Browser | null = null;
	#page: Page | null = null;
	#currentHeadless: boolean | null = null;
	#browserSession: CDPSession | null = null;
	#userAgentOverride: UserAgentOverride | null = null;
	#elementIdCounter = 0;
	readonly #elementCache = new Map<number, ElementHandle>();
	readonly #patchedClients = new WeakSet<object>();

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(browserDescription, {});
	}

	async #closeBrowser(): Promise<void> {
		await this.#clearElementCache();
		if (this.#page && !this.#page.isClosed()) {
			await this.#page.close();
		}
		this.#page = null;
		if (this.#browser?.connected) {
			await this.#browser.close();
		}
		this.#browser = null;
		this.#browserSession = null;
		this.#userAgentOverride = null;
	}

	async #resetBrowser(params?: BrowserParams): Promise<Page> {
		await this.#closeBrowser();
		this.#currentHeadless = this.session.settings.get("browser.headless");
		const vp = params?.viewport;
		const initialViewport = vp
			? {
					width: vp.width,
					height: vp.height,
					deviceScaleFactor: vp.device_scale_factor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
				}
			: DEFAULT_VIEWPORT;
		const puppeteer = await loadPuppeteer();
		const launchArgs = [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-blink-features=AutomationControlled",
			`--window-size=${initialViewport.width},${initialViewport.height}`,
		];
		const proxy = process.env.PUPPETEER_PROXY;
		if (proxy) {
			launchArgs.push(`--proxy-server=${proxy}`);
			// Chrome (since v72) bypasses proxies for localhost by default. When PUPPETEER_PROXY_BYPASS_LOOPBACK
			// is true, add <-loopback> so traffic to localhost reaches the proxy (e.g. for mitmdump/auth capture).
			const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
			if (
				bypassLoopback === "true" ||
				bypassLoopback === "1" ||
				bypassLoopback === "yes" ||
				bypassLoopback === "on"
			) {
				launchArgs.push("--proxy-bypass-list=<-loopback>");
			}
		}
		const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
		if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
			launchArgs.push("--ignore-certificate-errors");
		}
		this.#browser = await puppeteer.launch({
			headless: this.#currentHeadless,
			defaultViewport: this.#currentHeadless ? initialViewport : null,
			executablePath: resolveSystemChromium(),
			args: launchArgs,
			ignoreDefaultArgs: [...STEALTH_IGNORE_DEFAULT_ARGS],
		});
		this.#page = await this.#browser.newPage();
		await this.#applyStealthPatches(this.#page);
		if (this.#currentHeadless || params?.viewport) {
			await this.#applyViewport(this.#page, params?.viewport);
		}
		return this.#page;
	}

	async #ensurePage(params?: BrowserParams): Promise<Page> {
		const desiredHeadless = this.session.settings.get("browser.headless");
		if (this.#currentHeadless !== null && this.#currentHeadless !== desiredHeadless) {
			return this.#resetBrowser(params);
		}
		if (this.#page && !this.#page.isClosed()) {
			return this.#page;
		}
		if (!this.#browser?.isConnected()) {
			return this.#resetBrowser(params);
		}
		this.#page = await this.#browser.newPage();
		await this.#applyStealthPatches(this.#page);
		if (this.#currentHeadless || params?.viewport) {
			await this.#applyViewport(this.#page, params?.viewport);
		}
		return this.#page;
	}

	async #applyViewport(page: Page, viewport?: BrowserParams["viewport"]): Promise<void> {
		if (!viewport) {
			await page.setViewport(DEFAULT_VIEWPORT);
			return;
		}
		await page.setViewport({
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: viewport.device_scale_factor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
		});
	}

	async #clearElementCache(): Promise<void> {
		if (this.#elementCache.size === 0) {
			this.#elementIdCounter = 0;
			return;
		}
		const handles = Array.from(this.#elementCache.values());
		this.#elementCache.clear();
		this.#elementIdCounter = 0;
		await Promise.all(
			handles.map(async handle => {
				try {
					await handle.dispose();
				} catch {
					return;
				}
			}),
		);
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const handle = this.#elementCache.get(id);
		if (!handle) {
			throw new ToolError(`Unknown element_id ${id}. Run observe to refresh the element list.`);
		}
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				await this.#clearElementCache();
				throw new ToolError(`Element_id ${id} is stale. Run observe again.`);
			}
		} catch {
			await this.#clearElementCache();
			throw new ToolError(`Element_id ${id} is stale. Run observe again.`);
		}
		return handle;
	}

	#isInteractiveNode(node: SerializedAXNode): boolean {
		if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
		return (
			node.checked !== undefined ||
			node.pressed !== undefined ||
			node.selected !== undefined ||
			node.expanded !== undefined ||
			node.focused === true
		);
	}

	async #collectObservationEntries(
		node: SerializedAXNode,
		entries: ObservationEntry[],
		options: { viewportOnly: boolean; includeAll: boolean },
	): Promise<void> {
		if (options.includeAll || this.#isInteractiveNode(node)) {
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
					const id = ++this.#elementIdCounter;
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
					this.#elementCache.set(id, handle);
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
			await this.#collectObservationEntries(child, entries, options);
		}
	}

	#formatObservation(observation: Observation): string {
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

	/**
	 * Restart the browser to apply changes like headless mode.
	 */
	async restartForModeChange(): Promise<void> {
		await this.#resetBrowser();
	}

	async #applyStealthPatches(page: Page): Promise<void> {
		this.#patchSourceUrl(page);
		await this.#applyUserAgentOverride(page);
		await this.#injectStealthScripts(page);
	}

	async #applyUserAgentOverride(page: Page): Promise<void> {
		const client = resolvePageClient(page);
		if (!client) return;
		const override = await this.#resolveUserAgentOverride(page);
		await this.#sendUserAgentOverride(client, override);
		await this.#configureUserAgentTargets(override);
	}

	async #resolveUserAgentOverride(page: Page): Promise<UserAgentOverride> {
		if (this.#userAgentOverride) return this.#userAgentOverride;
		const rawUserAgent = await page.browser().userAgent();
		let userAgent = rawUserAgent.replace("HeadlessChrome/", "Chrome/");
		if (userAgent.includes("Linux") && !userAgent.includes("Android")) {
			userAgent = userAgent.replace(/\(([^)]+)\)/, "(Windows NT 10.0; Win64; x64)");
		}

		const uaVersionMatch = userAgent.match(/Chrome\/([\d|.]+)/);
		const fallbackVersionMatch = uaVersionMatch ?? (await page.browser().version()).match(/\/([\d|.]+)/);
		const uaVersion = fallbackVersionMatch?.[1] ?? "0";
		const majorVersion = Number.parseInt(uaVersion.split(".")[0] ?? "0", 10) || 0;
		const isAndroid = userAgent.includes("Android");
		const platform = userAgent.includes("Mac OS X")
			? "MacIntel"
			: isAndroid
				? "Android"
				: userAgent.includes("Linux")
					? "Linux"
					: "Win32";
		const platformFull = userAgent.includes("Mac OS X")
			? "Mac OS X"
			: isAndroid
				? "Android"
				: userAgent.includes("Linux")
					? "Linux"
					: "Windows";
		const platformVersion = userAgent.includes("Mac OS X ")
			? (userAgent.match(/Mac OS X ([^)]+)/)?.[1] ?? "")
			: userAgent.includes("Android ")
				? (userAgent.match(/Android ([^;]+)/)?.[1] ?? "")
				: userAgent.includes("Windows ")
					? (userAgent.match(/Windows .*?([\d|.]+);?/)?.[1] ?? "")
					: "";
		const architecture = isAndroid ? "" : "x86";
		const model = isAndroid ? (userAgent.match(/Android.*?;\s([^)]+)/)?.[1] ?? "") : "";

		const brandOrders = [
			[0, 1, 2],
			[0, 2, 1],
			[1, 0, 2],
			[1, 2, 0],
			[2, 0, 1],
			[2, 1, 0],
		];
		const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0];
		const escapedChars = [" ", " ", ";"];
		const greaseyBrand = `${escapedChars[order[0]]}Not${escapedChars[order[1]]}A${escapedChars[order[2]]}Brand`;
		const brands: { brand: string; version: string }[] = [];
		brands[order[0]] = { brand: greaseyBrand, version: "99" };
		brands[order[1]] = { brand: "Chromium", version: String(majorVersion) };
		brands[order[2]] = { brand: "Google Chrome", version: String(majorVersion) };

		this.#userAgentOverride = {
			userAgent,
			platform,
			acceptLanguage: STEALTH_ACCEPT_LANGUAGE,
			userAgentMetadata: {
				brands,
				fullVersion: uaVersion,
				platform: platformFull,
				platformVersion,
				architecture,
				model,
				mobile: isAndroid,
			},
		};
		return this.#userAgentOverride;
	}

	async #configureUserAgentTargets(override: UserAgentOverride): Promise<void> {
		if (!this.#browser) return;
		if (!this.#browserSession) {
			this.#browserSession = await this.#browser.target().createCDPSession();
			await this.#browserSession.send("Target.setAutoAttach", {
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
			});
			this.#browserSession.on("Target.attachedToTarget", async (event: { sessionId: string }) => {
				const connection = this.#browserSession?.connection();
				const session = connection?.session(event.sessionId);
				if (!session || !this.#userAgentOverride) return;
				await this.#sendUserAgentOverride(this.#wrapSession(session), this.#userAgentOverride);
			});
		}

		const targets = this.#browser.targets();
		await Promise.all(
			targets.map(async target => {
				const session = await target.createCDPSession();
				await this.#sendUserAgentOverride(this.#wrapSession(session), override);
			}),
		);
	}

	#wrapSession(session: CDPSession): PuppeteerCdpClient {
		return {
			send: async (method, params) => session.send(method as never, params as never),
		};
	}

	async #sendUserAgentOverride(client: PuppeteerCdpClient, override: UserAgentOverride): Promise<void> {
		try {
			await client.send("Network.enable");
		} catch {}
		try {
			await client.send("Network.setUserAgentOverride", override);
		} catch (error) {
			logger.debug("Failed to apply Network user agent override", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		try {
			await client.send("Emulation.setUserAgentOverride", override);
		} catch (error) {
			logger.debug("Failed to apply Emulation user agent override", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#patchSourceUrl(page: Page): void {
		const client = resolvePageClient(page);
		if (!client) return;
		const clientKey = client as object;
		if (this.#patchedClients.has(clientKey)) return;
		this.#patchedClients.add(clientKey);
		const originalSend = client.send.bind(client);
		client.send = async (method: string, params?: Record<string, unknown>) => {
			const next = async (payload?: Record<string, unknown>) => {
				try {
					return await originalSend(method, payload);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message.includes(
							"Protocol error (Network.getResponseBody): No resource with given identifier found",
						)
					) {
						return undefined;
					}
					throw error;
				}
			};
			if (!method || !params) {
				return next(params);
			}
			const key =
				method === "Runtime.evaluate"
					? "expression"
					: method === "Runtime.callFunctionOn"
						? "functionDeclaration"
						: null;
			if (!key) {
				return next(params);
			}
			const value = params[key];
			if (typeof value !== "string" || !value.includes(PUPPETEER_SOURCE_URL_SUFFIX)) {
				return next(params);
			}
			const patchedParams = { ...params, [key]: value.replace(PUPPETEER_SOURCE_URL_SUFFIX, "") };
			return next(patchedParams);
		};
	}

	/** Injects stealth scripts that cover common puppeteer detection surfaces. */
	async #injectStealthScripts(page: Page): Promise<void> {
		const scripts = [
			stealthTamperingScript,
			stealthActivityScript,
			stealthHairlineScript,
			stealthBotdScript,
			stealthIframeScript,
			stealthWebglScript,
			stealthScreenScript,
			stealthFontsScript,
			stealthAudioScript,
			stealthLocaleScript,
			stealthPluginsScript,
			stealthHardwareScript,
			stealthCodecsScript,
			stealthWorkerScript,
		];

		const joint = scripts
			.map(
				script => `
		try {
			${script};
		} catch (e) {}
	`,
			)
			.join(";\n");

		await page.evaluateOnNewDocument(`(() => {
				// Native function cache - captured before any tampering
				const iframe = document.createElement("iframe");
				iframe.style.display = "none";
				document.head.appendChild(iframe);
				const nativeWindow = iframe.contentWindow;
				if (!nativeWindow) return;

				// Cache pristine native functions
				const Function_toString = nativeWindow.Function.prototype.toString;
				const Object_getOwnPropertyDescriptor = nativeWindow.Object.getOwnPropertyDescriptor;
				const Object_getOwnPropertyDescriptors = nativeWindow.Object.getOwnPropertyDescriptors;
				const Object_getPrototypeOf = nativeWindow.Object.getPrototypeOf;
				const Object_defineProperty = nativeWindow.Object.defineProperty;
				const Object_getOwnPropertyDescriptorOriginal = nativeWindow.Object.getOwnPropertyDescriptor;
				const Object_create = nativeWindow.Object.create;
				const Object_keys = nativeWindow.Object.keys;
				const Object_getOwnPropertyNames = nativeWindow.Object.getOwnPropertyNames;
				const Object_entries = nativeWindow.Object.entries;
				const Object_setPrototypeOf = nativeWindow.Object.setPrototypeOf;
				const Object_assign = nativeWindow.Object.assign;
				const Window_setTimeout = nativeWindow.setTimeout;
				const Math_random = nativeWindow.Math.random;
				const Math_floor = nativeWindow.Math.floor;
				const Math_max = nativeWindow.Math.max;
				const Math_min = nativeWindow.Math.min;
				const Window_Event = nativeWindow.Event;
				const Promise_resolve = nativeWindow.Promise.resolve.bind(nativeWindow.Promise);
				const Window_Blob = nativeWindow.Blob;
				const Window_Proxy = nativeWindow.Proxy;
				const Intl_DateTimeFormat = nativeWindow.Intl.DateTimeFormat;
				const Date_constructor = nativeWindow.Date;

				
				${joint}

				document.head.removeChild(iframe);})();`);
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout);
			const timeoutMs = timeoutSeconds * 1000;
			const details: BrowserToolDetails = { action: params.action };

			switch (params.action) {
				case "open": {
					const page = await untilAborted(signal, () => this.#resetBrowser(params));
					const viewport = page.viewport();
					details.viewport = viewport ?? DEFAULT_VIEWPORT;
					return toolResult(details).text("Opened headless browser session").done();
				}
				case "close": {
					await untilAborted(signal, () => this.#closeBrowser());
					return toolResult(details).text("Closed headless browser session").done();
				}
				case "goto": {
					const url = ensureParam(params.url, "url", params.action);
					details.url = url;
					const page = await this.#ensurePage(params);
					const waitUntil = params.wait_until ?? "networkidle2";
					await this.#clearElementCache();
					await untilAborted(signal, () => page.goto(url, { waitUntil, timeout: timeoutMs }));
					const finalUrl = page.url();
					const title = (await untilAborted(signal, () => page.title())) as string;
					details.url = finalUrl;
					details.result = title;
					return toolResult(details)
						.text(`Navigated to ${finalUrl}${title ? `\nTitle: ${title}` : ""}`)
						.done();
				}
				case "observe": {
					const page = await this.#ensurePage(params);
					const timeoutSignal = AbortSignal.timeout(timeoutMs);
					const observeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
					await this.#clearElementCache();
					const snapshot = (await untilAborted(observeSignal, () =>
						page.accessibility.snapshot({ interestingOnly: !(params.include_all ?? false) }),
					)) as SerializedAXNode | null;
					if (!snapshot) {
						throw new ToolError("Accessibility snapshot unavailable");
					}
					const entries: ObservationEntry[] = [];
					await this.#collectObservationEntries(snapshot, entries, {
						viewportOnly: params.viewport_only ?? false,
						includeAll: params.include_all ?? false,
					});
					const scroll = (await untilAborted(observeSignal, () =>
						page.evaluate(() => {
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
					const url = page.url();
					const title = (await untilAborted(observeSignal, () => page.title())) as string;
					const viewport = page.viewport() ?? DEFAULT_VIEWPORT;
					const observation: Observation = {
						url,
						title,
						viewport,
						scroll,
						elements: entries,
					};
					details.url = url;
					details.viewport = viewport;
					details.observation = observation;
					details.result = `${entries.length} elements`;
					return toolResult(details).text(this.#formatObservation(observation)).done();
				}
				case "click": {
					const selector = ensureParam(params.selector, "selector", params.action);
					details.selector = selector;
					const page = await this.#ensurePage(params);
					const resolvedSelector = normalizeSelector(selector);
					if (resolvedSelector.startsWith("text/")) {
						await clickQueryHandlerText(page, resolvedSelector, timeoutMs, signal);
					} else {
						const locator = page.locator(resolvedSelector).setTimeout(timeoutMs);
						await untilAborted(signal, () => locator.click());
					}
					return toolResult(details).text(`Clicked ${selector}`).done();
				}
				case "click_id": {
					const elementId = ensureParam(params.element_id, "element_id", params.action);
					details.elementId = elementId;
					const handle = await this.#resolveCachedHandle(elementId);
					try {
						await untilAborted(signal, () => handle.click());
					} catch {
						await this.#clearElementCache();
						throw new ToolError(`Element_id ${elementId} is stale. Run observe again.`);
					}
					return toolResult(details).text(`Clicked element ${elementId}`).done();
				}
				case "type": {
					const selector = ensureParam(params.selector, "selector", params.action);
					const text = ensureParam(params.text, "text", params.action);
					details.selector = selector;
					const page = await this.#ensurePage(params);
					const resolvedSelector = normalizeSelector(selector);
					const locator = page.locator(resolvedSelector).setTimeout(timeoutMs);
					const handle = (await untilAborted(signal, () => locator.waitHandle())) as ElementHandle;
					await untilAborted(signal, () => handle.type(text, { delay: 0 }));
					await handle.dispose();
					return toolResult(details).text(`Typed into ${selector}`).done();
				}
				case "type_id": {
					const elementId = ensureParam(params.element_id, "element_id", params.action);
					const text = ensureParam(params.text, "text", params.action);
					details.elementId = elementId;
					const page = await this.#ensurePage(params);
					const handle = await this.#resolveCachedHandle(elementId);
					try {
						await untilAborted(signal, () => handle.focus());
						await untilAborted(signal, () => page.keyboard.type(text, { delay: 0 }));
					} catch {
						await this.#clearElementCache();
						throw new ToolError(`Element_id ${elementId} is stale. Run observe again.`);
					}
					return toolResult(details).text(`Typed into element ${elementId}`).done();
				}
				case "fill": {
					const selector = ensureParam(params.selector, "selector", params.action);
					const value = ensureParam(params.value, "value", params.action);
					details.selector = selector;
					const page = await this.#ensurePage(params);
					const resolvedSelector = normalizeSelector(selector);
					const locator = page.locator(resolvedSelector).setTimeout(timeoutMs);
					await untilAborted(signal, () => locator.fill(value));
					return toolResult(details).text(`Filled ${selector}`).done();
				}
				case "fill_id": {
					const elementId = ensureParam(params.element_id, "element_id", params.action);
					const value = ensureParam(params.value, "value", params.action);
					details.elementId = elementId;
					const handle = await this.#resolveCachedHandle(elementId);
					try {
						await untilAborted(signal, () =>
							handle.evaluate((el, inputValue) => {
								const element = el as { value?: string; dispatchEvent: (event: Event) => boolean };
								if (!("value" in element)) {
									throw new Error("Target element is not a form input");
								}
								element.value = String(inputValue);
								element.dispatchEvent(new Event("input", { bubbles: true }));
								element.dispatchEvent(new Event("change", { bubbles: true }));
							}, value),
						);
					} catch {
						await this.#clearElementCache();
						throw new ToolError(`Element_id ${elementId} is stale. Run observe again.`);
					}
					return toolResult(details).text(`Filled element ${elementId}`).done();
				}
				case "press": {
					const key = ensureParam(params.key, "key", params.action) as KeyInput;
					const page = await this.#ensurePage(params);
					if (params.selector) {
						const resolvedSelector = normalizeSelector(params.selector as string);
						await untilAborted(signal, () => page.focus(resolvedSelector));
					}
					await untilAborted(signal, () => page.keyboard.press(key));
					return toolResult(details).text(`Pressed ${key}`).done();
				}
				case "scroll": {
					const deltaY = ensureParam(params.delta_y, "delta_y", params.action);
					const deltaX = params.delta_x ?? 0;
					const page = await this.#ensurePage(params);
					await untilAborted(signal, () => page.mouse.wheel({ deltaX, deltaY }));
					return toolResult(details).text(`Scrolled by ${deltaX}, ${deltaY}`).done();
				}
				case "drag": {
					const fromSelector = ensureParam(params.from_selector, "from_selector", params.action);
					const toSelector = ensureParam(params.to_selector, "to_selector", params.action);
					const page = await this.#ensurePage(params);
					const resolvedFromSelector = normalizeSelector(fromSelector);
					const resolvedToSelector = normalizeSelector(toSelector);
					const fromHandle = (await untilAborted(signal, () =>
						page.$(resolvedFromSelector),
					)) as ElementHandle | null;
					const toHandle = (await untilAborted(signal, () => page.$(resolvedToSelector))) as ElementHandle | null;
					if (!fromHandle || !toHandle) {
						throw new ToolError("Drag selectors did not resolve to elements");
					}
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
					await fromHandle.dispose();
					await toHandle.dispose();
					if (!fromBox || !toBox) {
						throw new ToolError("Drag elements are not visible");
					}
					const startX = fromBox.x + fromBox.width / 2;
					const startY = fromBox.y + fromBox.height / 2;
					const endX = toBox.x + toBox.width / 2;
					const endY = toBox.y + toBox.height / 2;
					await untilAborted(signal, () => page.mouse.move(startX, startY));
					await untilAborted(signal, () => page.mouse.down());
					await untilAborted(signal, () => page.mouse.move(endX, endY, { steps: 12 }));
					await untilAborted(signal, () => page.mouse.up());
					return toolResult(details).text(`Dragged from ${fromSelector} to ${toSelector}`).done();
				}
				case "wait_for_selector": {
					const selector = ensureParam(params.selector, "selector", params.action);
					details.selector = selector;
					const page = await this.#ensurePage(params);
					const resolvedSelector = normalizeSelector(selector);
					const locator = page.locator(resolvedSelector).setTimeout(timeoutMs);
					await untilAborted(signal, () => locator.wait());
					return toolResult(details).text(`Selector ready: ${selector}`).done();
				}
				case "evaluate": {
					const script = ensureParam(params.script, "script", params.action);
					const page = await this.#ensurePage(params);
					const value = (await untilAborted(signal, () =>
						page.evaluate(async (source: string) => {
							try {
								return await new Function(`return (async () => (${source}))();`)();
							} catch {
								return await new Function(`return (async () => { ${source} })();`)();
							}
						}, script),
					)) as unknown;
					const output = formatEvaluateResult(value);
					details.result = output;
					return toolResult(details).text(output).done();
				}
				case "get_text": {
					const page = await this.#ensurePage(params);
					if (params.args?.length) {
						const values = (await Promise.all(
							params.args.map((arg, index) => {
								const selector = ensureParam(arg.selector, `args[${index}].selector`, params.action);
								const resolvedSelector = normalizeSelector(selector);
								return untilAborted(signal, () =>
									page.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerText),
								);
							}),
						)) as string[];
						details.result = values;
						return toolResult(details)
							.text(JSON.stringify(values, null, 2))
							.done();
					}
					const selector = ensureParam(params.selector, "selector", params.action);
					details.selector = selector;
					const resolvedSelector = normalizeSelector(selector);
					const value = (await untilAborted(signal, () =>
						page.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerText),
					)) as string;
					details.result = value;
					return toolResult(details).text(value).done();
				}
				case "get_html": {
					const page = await this.#ensurePage(params);
					if (params.args?.length) {
						const values = (await Promise.all(
							params.args.map((arg, index) => {
								const selector = ensureParam(arg.selector, `args[${index}].selector`, params.action);
								const resolvedSelector = normalizeSelector(selector);
								return untilAborted(signal, () =>
									page.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerHTML),
								);
							}),
						)) as string[];
						details.result = values;
						return toolResult(details)
							.text(JSON.stringify(values, null, 2))
							.done();
					}
					const selector = ensureParam(params.selector, "selector", params.action);
					details.selector = selector;
					const resolvedSelector = normalizeSelector(selector);
					const value = (await untilAborted(signal, () =>
						page.$eval(resolvedSelector, (el: Element) => (el as HTMLElement).innerHTML),
					)) as string;
					details.result = value;
					return toolResult(details).text(value).done();
				}
				case "get_attribute": {
					const page = await this.#ensurePage(params);
					if (params.args?.length) {
						const values = (await Promise.all(
							params.args.map((arg, index) => {
								const selector = ensureParam(arg.selector, `args[${index}].selector`, params.action);
								const attribute = ensureParam(arg.attribute, `args[${index}].attribute`, params.action);
								const resolvedSelector = normalizeSelector(selector);
								return untilAborted(signal, () =>
									page.$eval(
										resolvedSelector,
										(el: Element, attr: string) => (el as HTMLElement).getAttribute(String(attr)),
										attribute,
									),
								);
							}),
						)) as string[];
						details.result = values;
						return toolResult(details)
							.text(JSON.stringify(values, null, 2))
							.done();
					}
					const selector = ensureParam(params.selector, "selector", params.action);
					const attribute = ensureParam(params.attribute, "attribute", params.action);
					details.selector = selector;
					const resolvedSelector = normalizeSelector(selector);
					const value = (await untilAborted(signal, () =>
						page.$eval(
							resolvedSelector,
							(el: { getAttribute: (name: string) => string | null }, attr: string) =>
								el.getAttribute(String(attr)),
							attribute,
						),
					)) as string | null;
					const output = value ?? "";
					details.result = output;
					return toolResult(details).text(output).done();
				}
				case "extract_readable": {
					const page = await this.#ensurePage(params);
					const format = params.format ?? "markdown";
					const html = (await untilAborted(signal, () => page.content())) as string;
					const url = page.url();
					const readable = extractReadableFromHtml(html, url, format);
					if (!readable) {
						throw new ToolError("Readable content not found");
					}
					details.url = url;
					details.readable = readable;
					details.result = format === "markdown" ? (readable.markdown ?? "") : (readable.text ?? "");
					return toolResult(details)
						.text(JSON.stringify(readable, null, 2))
						.done();
				}
				case "screenshot": {
					const page = await this.#ensurePage(params);
					const fullPage = params.selector ? false : (params.full_page ?? false);
					let buffer: Buffer;

					if (params.selector) {
						const resolvedSelector = normalizeSelector(params.selector as string);
						const handle = (await untilAborted(signal, () => page.$(resolvedSelector))) as ElementHandle | null;
						if (!handle) {
							throw new ToolError("Screenshot selector did not resolve to an element");
						}
						buffer = (await untilAborted(signal, () => handle.screenshot({ type: "png" }))) as Buffer;
						await handle.dispose();
						details.selector = params.selector;
					} else {
						buffer = (await untilAborted(signal, () => page.screenshot({ type: "png", fullPage }))) as Buffer;
					}

					// Compress aggressively for API content — screenshots are the most
					// frequent image source and land directly in the next LLM request.
					// 1024px is plenty for OCR/UI inspection; 150KB keeps payloads lean.
					const resized = await resizeImage(
						{ type: "image", data: buffer.toBase64(), mimeType: "image/png" },
						{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
					);
					// Resolve destination: user-defined path > screenshotDir (auto-named) > temp file.
					const screenshotDir = (() => {
						const v = this.session.settings.get("browser.screenshotDir") as string | undefined;
						return v ? expandPath(v) : undefined;
					})();
					const paramPath = params.path ? resolveToCwd(params.path as string, this.session.cwd) : undefined;
					let dest: string;
					if (paramPath) {
						dest = paramPath;
					} else if (screenshotDir) {
						const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
						dest = path.join(screenshotDir, `screenshot-${ts}.png`);
					} else {
						dest = path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.png`);
					}
					await fs.promises.mkdir(path.dirname(dest), { recursive: true });
					// Full-res buffer when saving to a user-defined location; resized (API copy) for temp-only.
					const saveFullRes = !!(paramPath || screenshotDir);
					const savedBuffer = saveFullRes ? buffer : resized.buffer;
					const savedMimeType = saveFullRes ? "image/png" : resized.mimeType;
					await Bun.write(dest, savedBuffer);
					details.screenshotPath = dest;
					details.mimeType = savedMimeType;
					details.bytes = savedBuffer.length;

					const lines = formatScreenshot({
						saveFullRes,
						savedMimeType,
						savedByteLength: savedBuffer.length,
						dest,
						resized,
					});
					return toolResult(details)
						.content([
							{ type: "text", text: lines.join("\n") },
							{ type: "image", data: resized.data, mimeType: resized.mimeType },
						])
						.done();
				}
				default:
					throw new ToolError(`Unsupported action: ${params.action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}
}
