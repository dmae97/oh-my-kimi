import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalLiveE2e = process.env.LIVE_E2E;
let home: string;

async function loadResolver() {
	vi.resetModules();
	return import("./oauth.ts");
}

describe("OAuth test helper hermeticity", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "omk-ai-oauth-test-"));
		process.env.HOME = home;
		delete process.env.LIVE_E2E;
		const authDir = join(home, ".omk", "agent");
		mkdirSync(authDir, { recursive: true });
		writeFileSync(
			join(authDir, "auth.json"),
			JSON.stringify({ "openai-codex": { type: "api_key", key: "stored-test-key" } }),
		);
	});

	afterEach(() => {
		vi.resetModules();
		rmSync(home, { recursive: true, force: true });
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalLiveE2e === undefined) delete process.env.LIVE_E2E;
		else process.env.LIVE_E2E = originalLiveE2e;
	});

	it("does not read the real auth store during default unit tests", async () => {
		const { resolveApiKey } = await loadResolver();
		await expect(resolveApiKey("openai-codex")).resolves.toBeUndefined();
	});

	it("allows stored credentials only for explicit live E2E runs", async () => {
		process.env.LIVE_E2E = "1";
		const { resolveApiKey } = await loadResolver();
		await expect(resolveApiKey("openai-codex")).resolves.toBe("stored-test-key");
	});
});
