import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession, ElementHandle, Page } from "puppeteer-core";
import { ToolAbortError, ToolError } from "../tool-errors";
import {
	findFreeCdpPort,
	findReusableCdp,
	gracefulKillTreeOnce,
	killExistingByPath,
	pickElectronTarget,
	waitForCdp,
} from "./attach";
import {
	applyStealthPatches,
	applyViewport,
	launchHeadlessBrowser,
	loadPuppeteer,
	type UserAgentOverride,
} from "./launch";

export type BrowserKind =
	| { kind: "headless"; headless: boolean }
	| { kind: "spawned"; path: string }
	| { kind: "connected"; cdpUrl: string };

export type BrowserKindTag = BrowserKind["kind"];

export interface BrowserHandle {
	key: string;
	kind: BrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	subprocess?: Subprocess;
	refCount: number;
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

export type DialogPolicy = "accept" | "dismiss";

export interface TabHandle {
	name: string;
	browser: BrowserHandle;
	page: Page;
	elementCache: Map<number, ElementHandle>;
	elementCounter: number;
	dialogPolicy?: DialogPolicy;
	dialogHandler?: (dialog: { accept: () => Promise<void>; dismiss: () => Promise<void> }) => void;
}

const browsers = new Map<string, BrowserHandle>();
const tabs = new Map<string, TabHandle>();

export function getTab(name: string): TabHandle | undefined {
	return tabs.get(name);
}

export function listTabs(): TabHandle[] {
	return [...tabs.values()];
}

export function listBrowsers(): BrowserHandle[] {
	return [...browsers.values()];
}

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	const existing = browsers.get(key);
	if (existing) {
		// Headless: connection check; spawned/connected: connection check.
		if (existing.browser.connected) return existing;
		// Stale handle — purge and rebuild.
		browsers.delete(key);
		await disposeBrowserHandle(existing, { kill: false });
	}

	const handle = await openBrowserHandle(kind, opts);
	browsers.set(key, handle);
	return handle;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "headless") {
		const browser = await launchHeadlessBrowser({ headless: kind.headless, viewport: opts.viewport });
		return {
			key: browserKey(kind),
			kind,
			browser,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = kind.cdpUrl.replace(/\/+$/, "");
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	// spawned
	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const reused = await findReusableCdp(exe, opts.signal);
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", {
			exe,
			pid: reused.pid,
			cdpUrl: reused.cdpUrl,
		});
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const killed = await killExistingByPath(exe, opts.signal);
		if (killed > 0) {
			logger.debug("Killed existing instances before attach", { exe, killed });
		}
		const port = await findFreeCdpPort();
		const launchArgs = [...(opts.appArgs ?? []), `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
}

export interface AcquireTabResult {
	tab: TabHandle;
	created: boolean;
}

export async function acquireTab(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser !== browser) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} already exists on a different browser (${existing.browser.kind.kind}). Close it first.`,
			);
		}
		if (!existing.page.isClosed()) {
			if (opts.dialogs !== undefined) applyDialogPolicy(existing, opts.dialogs);
			if (opts.url) {
				clearElementCache(existing);
				await existing.page.goto(opts.url, {
					waitUntil: opts.waitUntil ?? "networkidle2",
					timeout: opts.timeoutMs,
				});
			}
			return { tab: existing, created: false };
		}
		// Stale tab — purge and recreate.
		tabs.delete(name);
		browser.refCount = Math.max(0, browser.refCount - 1);
	}

	let page: Page;
	if (browser.kind.kind === "headless") {
		page = await browser.browser.newPage();
		await applyStealthPatches(browser.browser, page, browser.stealth);
		if (browser.kind.headless || opts.viewport) {
			await applyViewport(page, opts.viewport);
		}
	} else {
		// spawned/connected — don't open a new tab in the user's app; pick an existing target.
		page = await pickElectronTarget(browser.browser, opts.target);
	}

	const tab: TabHandle = {
		name,
		browser,
		page,
		elementCache: new Map(),
		elementCounter: 0,
	};
	tabs.set(name, tab);
	browser.refCount++;
	if (opts.dialogs !== undefined) applyDialogPolicy(tab, opts.dialogs);

	if (opts.url) {
		await page.goto(opts.url, {
			waitUntil: opts.waitUntil ?? "networkidle2",
			timeout: opts.timeoutMs,
		});
	}

	return { tab, created: true };
}

export interface ReleaseTabOptions {
	kill?: boolean;
}

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	tabs.delete(name);
	await disposeTab(tab);
	tab.browser.refCount = Math.max(0, tab.browser.refCount - 1);
	if (tab.browser.refCount === 0) {
		browsers.delete(tab.browser.key);
		await disposeBrowserHandle(tab.browser, { kill: opts.kill ?? false });
	}
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

/** Drop only headless browsers and their tabs. Used by the headless-toggle slash command. */
export async function dropHeadlessBrowsers(): Promise<void> {
	const targets = [...tabs.values()].filter(t => t.browser.kind.kind === "headless");
	for (const tab of targets) {
		await releaseTab(tab.name);
	}
	// Drop any zero-refcount headless browsers that survived (shouldn't happen, defensive).
	for (const [key, browser] of browsers) {
		if (browser.kind.kind === "headless" && browser.refCount === 0) {
			browsers.delete(key);
			await disposeBrowserHandle(browser, { kill: false });
		}
	}
}

function applyDialogPolicy(tab: TabHandle, policy: DialogPolicy): void {
	if (tab.dialogPolicy === policy && tab.dialogHandler) return;
	if (tab.dialogHandler) {
		try {
			tab.page.off("dialog", tab.dialogHandler);
		} catch {}
	}
	const handler = (dialog: { accept: () => Promise<void>; dismiss: () => Promise<void> }): void => {
		const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
		void action.catch(err => {
			logger.debug("Dialog auto-handler failed", { policy, error: (err as Error).message });
		});
	};
	tab.page.on("dialog", handler);
	tab.dialogPolicy = policy;
	tab.dialogHandler = handler;
}

async function disposeTab(tab: TabHandle): Promise<void> {
	clearElementCache(tab);
	if (tab.dialogHandler && !tab.page.isClosed()) {
		try {
			tab.page.off("dialog", tab.dialogHandler);
		} catch {}
		tab.dialogHandler = undefined;
		tab.dialogPolicy = undefined;
	}
	if (tab.browser.kind.kind === "headless") {
		// Owned tab — close it.
		if (!tab.page.isClosed()) {
			try {
				await tab.page.close();
			} catch (err) {
				logger.debug("Failed to close page", { error: (err as Error).message });
			}
		}
	}
	// spawned/connected: page belongs to user's app — never close.
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: { kill: boolean }): Promise<void> {
	if (handle.kind.kind === "headless") {
		if (handle.browser.connected) {
			try {
				await handle.browser.close();
			} catch (err) {
				logger.debug("Failed to close headless browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.kind.kind === "connected") {
		// Never close a remote app — only disconnect.
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	// spawned
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: (err as Error).message });
		}
	}
	if (opts.kill && handle.pid !== undefined) {
		await gracefulKillTreeOnce(handle.pid);
	}
}

export function clearElementCache(tab: TabHandle): void {
	if (tab.elementCache.size === 0) {
		tab.elementCounter = 0;
		return;
	}
	const handles = [...tab.elementCache.values()];
	tab.elementCache.clear();
	tab.elementCounter = 0;
	for (const handle of handles) {
		// Fire and forget; disposal failures don't affect correctness.
		void handle.dispose().catch(() => undefined);
	}
}

export async function resolveCachedHandle(tab: TabHandle, id: number): Promise<ElementHandle> {
	const handle = tab.elementCache.get(id);
	if (!handle) {
		throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
	}
	try {
		const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
		if (!isConnected) {
			clearElementCache(tab);
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
	} catch (err) {
		if (err instanceof ToolError) throw err;
		clearElementCache(tab);
		throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
	}
	return handle;
}
