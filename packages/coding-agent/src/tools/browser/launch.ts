import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getPuppeteerDir, logger } from "@oh-my-pi/pi-utils";
import * as browsers from "@puppeteer/browsers";
import type { Browser, CDPSession, Page, default as Puppeteer } from "puppeteer-core";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import stealthTamperingScript from "../puppeteer/00_stealth_tampering.txt" with { type: "text" };
import stealthActivityScript from "../puppeteer/01_stealth_activity.txt" with { type: "text" };
import stealthHairlineScript from "../puppeteer/02_stealth_hairline.txt" with { type: "text" };
import stealthBotdScript from "../puppeteer/03_stealth_botd.txt" with { type: "text" };
import stealthIframeScript from "../puppeteer/04_stealth_iframe.txt" with { type: "text" };
import stealthWebglScript from "../puppeteer/05_stealth_webgl.txt" with { type: "text" };
import stealthScreenScript from "../puppeteer/06_stealth_screen.txt" with { type: "text" };
import stealthFontsScript from "../puppeteer/07_stealth_fonts.txt" with { type: "text" };
import stealthAudioScript from "../puppeteer/08_stealth_audio.txt" with { type: "text" };
import stealthLocaleScript from "../puppeteer/09_stealth_locale.txt" with { type: "text" };
import stealthPluginsScript from "../puppeteer/10_stealth_plugins.txt" with { type: "text" };
import stealthHardwareScript from "../puppeteer/11_stealth_hardware.txt" with { type: "text" };
import stealthCodecsScript from "../puppeteer/12_stealth_codecs.txt" with { type: "text" };
import stealthWorkerScript from "../puppeteer/13_stealth_worker.txt" with { type: "text" };
import { ToolError } from "../tool-errors";

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };
export const STEALTH_IGNORE_DEFAULT_ARGS = [
	"--disable-extensions",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
];
export const STEALTH_ACCEPT_LANGUAGE = "en-US,en";

const PUPPETEER_SOURCE_URL_SUFFIX = "//# sourceURL=__puppeteer_evaluation_script__";

/**
 * Lazy-import puppeteer from a safe CWD so cosmiconfig doesn't choke
 * on malformed package.json files in the user's project tree.
 *
 * Dynamic import is required because puppeteer-core probes the cwd at module
 * load time; we must `process.chdir` to a safe scratch dir before loading and
 * restore cwd afterwards. A static import would run at module-init time before
 * cwd is safe.
 */
let puppeteerModule: typeof Puppeteer | undefined;
export async function loadPuppeteer(): Promise<typeof Puppeteer> {
	if (puppeteerModule) return puppeteerModule;
	const prev = process.cwd();
	const safeDir = getPuppeteerDir();
	await Bun.write(path.join(safeDir, "package.json"), "{}");
	try {
		process.chdir(safeDir);
		puppeteerModule = (await import("puppeteer-core")).default;
		return puppeteerModule;
	} finally {
		process.chdir(prev);
	}
}

/**
 * Lazily download Chromium on first browser launch via @puppeteer/browsers.
 * Skipped when a system Chromium (NixOS) or PUPPETEER_EXECUTABLE_PATH is set.
 * The browser is cached under ~/.omp/puppeteer (getPuppeteerDir).
 */
let chromiumExecutablePromise: Promise<string | undefined> | undefined;
export async function ensureChromiumExecutable(): Promise<string | undefined> {
	const sysChrome = resolveSystemChromium();
	if (sysChrome) return sysChrome;
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	if (chromiumExecutablePromise) return chromiumExecutablePromise;

	chromiumExecutablePromise = (async () => {
		const platform = browsers.detectBrowserPlatform();
		if (!platform) {
			logger.warn("Could not detect browser platform; relying on puppeteer default resolution");
			return undefined;
		}
		const cacheDir = getPuppeteerDir();
		const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
		const executablePath = browsers.computeExecutablePath({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
		});
		if (fs.existsSync(executablePath)) return executablePath;

		logger.warn("Downloading Chromium for puppeteer (first browser use)", {
			buildId,
			platform,
			cacheDir,
		});
		let lastReportedPercent = -1;
		await browsers.install({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
			downloadProgressCallback: (downloaded, total) => {
				if (total <= 0) return;
				const pct = Math.floor((downloaded / total) * 100);
				if (pct >= lastReportedPercent + 10 || downloaded === total) {
					lastReportedPercent = pct;
					logger.debug(
						`Chromium download: ${pct}% (${Math.round(downloaded / 1_000_000)} / ${Math.round(total / 1_000_000)} MB)`,
					);
				}
			},
		});
		return executablePath;
	})().catch(err => {
		chromiumExecutablePromise = undefined;
		throw new ToolError(
			`Failed to install Chromium for puppeteer: ${(err as Error).message}. ` +
				"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});
	return chromiumExecutablePromise;
}

let _resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		return st.isFile();
	} catch {
		return false;
	}
}

function systemChromiumCandidates(): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	switch (process.platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = $which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

export function resolveSystemChromium(): string | undefined {
	if (_resolvedChromium !== undefined) return _resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (isExecutableFile(candidate)) {
			_resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	_resolvedChromium = null;
	return undefined;
}

export interface LaunchHeadlessOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export async function launchHeadlessBrowser(opts: LaunchHeadlessOptions): Promise<Browser> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const initialViewport = {
		width: vp.width,
		height: vp.height,
		deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	};
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
		if (bypassLoopback === "true" || bypassLoopback === "1" || bypassLoopback === "yes" || bypassLoopback === "on") {
			launchArgs.push("--proxy-bypass-list=<-loopback>");
		}
	}
	const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
	if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
		launchArgs.push("--ignore-certificate-errors");
	}
	return await puppeteer.launch({
		headless: opts.headless,
		defaultViewport: opts.headless ? initialViewport : null,
		executablePath: await ensureChromiumExecutable(),
		args: launchArgs,
		ignoreDefaultArgs: [...STEALTH_IGNORE_DEFAULT_ARGS],
	});
}

export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	if (!viewport) {
		await page.setViewport(DEFAULT_VIEWPORT);
		return;
	}
	await page.setViewport({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	});
}

// =====================================================================
// Stealth patches
// =====================================================================

interface PuppeteerCdpClient {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export interface UserAgentOverride {
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
}

function resolvePageClient(page: Page): PuppeteerCdpClient | null {
	const pageWithClient = page as Page & {
		_client?: (() => PuppeteerCdpClient) | PuppeteerCdpClient;
	};
	if (!pageWithClient._client) return null;
	return typeof pageWithClient._client === "function" ? pageWithClient._client() : pageWithClient._client;
}

const patchedClients = new WeakSet<object>();

function patchSourceUrl(page: Page): void {
	const client = resolvePageClient(page);
	if (!client) return;
	const clientKey = client as object;
	if (patchedClients.has(clientKey)) return;
	patchedClients.add(clientKey);
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

async function resolveUserAgentOverride(page: Page): Promise<UserAgentOverride> {
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
	const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0]!;
	const escapedChars = [" ", " ", ";"];
	const greaseyBrand = `${escapedChars[order[0]!]}Not${escapedChars[order[1]!]}A${escapedChars[order[2]!]}Brand`;
	const brands: { brand: string; version: string }[] = [];
	brands[order[0]!] = { brand: greaseyBrand, version: "99" };
	brands[order[1]!] = { brand: "Chromium", version: String(majorVersion) };
	brands[order[2]!] = { brand: "Google Chrome", version: String(majorVersion) };

	return {
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
}

function wrapSession(session: CDPSession): PuppeteerCdpClient {
	return {
		send: async (method, params) => session.send(method as never, params as never),
	};
}

async function sendUserAgentOverride(client: PuppeteerCdpClient, override: UserAgentOverride): Promise<void> {
	try {
		await client.send("Network.enable");
	} catch {}
	try {
		await client.send("Network.setUserAgentOverride", override as unknown as Record<string, unknown>);
	} catch (error) {
		logger.debug("Failed to apply Network user agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		await client.send("Emulation.setUserAgentOverride", override as unknown as Record<string, unknown>);
	} catch (error) {
		logger.debug("Failed to apply Emulation user agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export interface UserAgentSession {
	override: UserAgentOverride;
	browserSession: CDPSession | null;
}

/** Configure UA override on the browser + auto-attach to new targets. */
async function configureUserAgentTargets(
	browser: Browser,
	state: { browserSession: CDPSession | null; override: UserAgentOverride },
): Promise<void> {
	if (!state.browserSession) {
		state.browserSession = await browser.target().createCDPSession();
		await state.browserSession.send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		state.browserSession.on("Target.attachedToTarget", async (event: { sessionId: string }) => {
			const connection = state.browserSession?.connection();
			const session = connection?.session(event.sessionId);
			if (!session) return;
			await sendUserAgentOverride(wrapSession(session), state.override);
		});
	}

	const targets = browser.targets();
	await Promise.all(
		targets.map(async target => {
			const session = await target.createCDPSession();
			await sendUserAgentOverride(wrapSession(session), state.override);
		}),
	);
}

async function injectStealthScripts(page: Page): Promise<void> {
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

/** Apply stealth patches + UA override to a headless page. Idempotent within a tab. */
export async function applyStealthPatches(
	browser: Browser,
	page: Page,
	state: { browserSession: CDPSession | null; override: UserAgentOverride | null },
): Promise<void> {
	patchSourceUrl(page);
	if (!state.override) {
		state.override = await resolveUserAgentOverride(page);
	}
	const client = resolvePageClient(page);
	if (client) {
		await sendUserAgentOverride(client, state.override);
	}
	const targetState = { browserSession: state.browserSession, override: state.override };
	await configureUserAgentTargets(browser, targetState);
	state.browserSession = targetState.browserSession;
	await injectStealthScripts(page);
}
