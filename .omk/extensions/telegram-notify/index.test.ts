/**
 * Wiring test for the notifier.
 *
 * `notify.ts` and `credentials.ts` are covered on their own; what is left is the
 * part that has to be right for the extension to be connected at all: a
 * credential file on disk turns into one request to Telegram, and a missing one
 * turns into no subscriptions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "open-multi-agent-kit";
import telegramNotifyExtension from "./index.ts";

const TOKEN = "1234567890:AAHtest_token";

interface Recorded {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

/** Records subscriptions instead of running an agent. */
function fakeApi(): { api: ExtensionAPI; events: Map<string, (event: unknown, ctx: unknown) => unknown> } {
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const api = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(name, handler) };
	return { api: api as unknown as ExtensionAPI, events };
}

function writeCredentials(lines: readonly string[]): string {
	const path = join(mkdtempSync(join(tmpdir(), "omk-telegram-ext-")), "telegram.env");
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	return path;
}

const originalFetch = globalThis.fetch;
const originalEnvFile = process.env.OMK_TELEGRAM_ENV_FILE;

/** Capture the outbound request; nothing in this suite may touch the network. */
function captureFetch(sent: Recorded[]): void {
	globalThis.fetch = (async (input: string | URL, init?: { body?: string }) => {
		sent.push({ url: String(input), body: JSON.parse(init?.body ?? "{}") });
		return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
	}) as typeof globalThis.fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEnvFile === undefined) delete process.env.OMK_TELEGRAM_ENV_FILE;
	else process.env.OMK_TELEGRAM_ENV_FILE = originalEnvFile;
});

describe("telegramNotifyExtension", () => {
	it("sends one message for a settled run configured by file alone", async () => {
		// Given credentials on disk and no Telegram variables in the environment.
		process.env.OMK_TELEGRAM_ENV_FILE = writeCredentials([
			`TELEGRAM_BOT_TOKEN=${TOKEN}`,
			"TELEGRAM_CHAT_ID=4242",
			"OMK_TELEGRAM_MIN_DURATION_MS=0",
		]);
		const sent: Recorded[] = [];
		captureFetch(sent);
		const { api, events } = fakeApi();

		// When a run starts and settles.
		telegramNotifyExtension(api);
		await events.get("agent_start")?.({}, {});
		await events.get("agent_settled")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, {});

		// Then exactly one request went to Telegram, addressed to the stored chat.
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
		assert.equal(sent[0]?.body.chat_id, "4242");
		assert.match(String(sent[0]?.body.text), /^OMK completed after/);
	});

	it("stays inert without credentials", () => {
		// Given a path with no file at it.
		process.env.OMK_TELEGRAM_ENV_FILE = join(tmpdir(), "omk-telegram-absent", "telegram.env");
		const { api, events } = fakeApi();

		// When the extension loads.
		telegramNotifyExtension(api);

		// Then it subscribes to nothing: not being set up is the normal case.
		assert.equal(events.size, 0);
	});

	it("warns once when the credential file is readable beyond its owner", () => {
		// Given a world-readable credential file.
		const path = join(mkdtempSync(join(tmpdir(), "omk-telegram-mode-")), "telegram.env");
		writeFileSync(path, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=4242\n`, { mode: 0o644 });
		process.env.OMK_TELEGRAM_ENV_FILE = path;
		const { api, events } = fakeApi();

		// When the session starts.
		telegramNotifyExtension(api);
		const notices: string[] = [];
		events.get("session_start")?.({}, { ui: { notify: (message: string) => notices.push(message) } });

		// Then the mode is named along with the fix, and the token is not.
		assert.equal(notices.length, 1);
		assert.match(String(notices[0]), /mode 644/);
		assert.match(String(notices[0]), /chmod 600/);
		assert.ok(!String(notices[0]).includes(TOKEN));
	});
});
