import { join } from "path";
import { CliError } from "../util/cli-contract.js";
import { getProjectRoot } from "../util/fs.js";

export interface BrowserSession {
  sessionId: string;
  url: string;
  page: unknown; // Playwright Page — typed as unknown to avoid hard dep
  browser: unknown; // Playwright Browser
  createdAt: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
}

export interface CreateSessionOptions {
  url: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
}

let activeSession: BrowserSession | undefined;

export function getActiveBrowserSession(): BrowserSession | undefined {
  return activeSession;
}

export function setActiveBrowserSession(session: BrowserSession | undefined): void {
  activeSession = session;
}

export function getBrowserSessionDir(projectRoot?: string, sessionId?: string): string {
  const root = projectRoot ?? getProjectRoot();
  if (sessionId) {
    return join(root, ".omk", "browser", sessionId);
  }
  return join(root, ".omk", "browser");
}

export async function createBrowserSession(options: CreateSessionOptions): Promise<BrowserSession> {
  const playwrightModuleName = process.env.NODE_ENV === "test"
    ? process.env.OMK_PLAYWRIGHT_MODULE ?? "playwright"
    : "playwright";
  let playwright: unknown;
  try {
    playwright = await import(playwrightModuleName);
  } catch {
    throw new CliError("Playwright is not installed. Run: npm install -D playwright");
  }

  const pw = playwright as {
    chromium: {
      launch: (opts: { headless?: boolean }) => Promise<{
        newContext: (opts: {
          viewport?: { width: number; height: number };
          deviceScaleFactor?: number;
        }) => Promise<{
          newPage: () => Promise<{
            goto: (url: string, opts?: { waitUntil?: string }) => Promise<unknown>;
          }>;
        }>;
      }>;
    };
  };

  const browser = await pw.chromium.launch({
    headless: options.headless ?? true,
  });

  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
  });

  const page = await context.newPage();
  await page.goto(options.url, { waitUntil: "networkidle" });

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: BrowserSession = {
    sessionId,
    url: options.url,
    page,
    browser,
    createdAt: new Date().toISOString(),
    viewport: options.viewport ?? { width: 1280, height: 720 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
  };

  activeSession = session;
  return session;
}

export async function closeBrowserSession(session?: BrowserSession): Promise<void> {
  const target = session ?? activeSession;
  if (!target) return;
  const browser = target.browser as { close: () => Promise<void> } | undefined;
  if (browser && typeof browser.close === "function") {
    await browser.close();
  }
  if (activeSession?.sessionId === target.sessionId) {
    activeSession = undefined;
  }
}
