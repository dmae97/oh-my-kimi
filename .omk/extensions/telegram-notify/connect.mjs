#!/usr/bin/env node
/**
 * One-time Telegram setup for the completion notifier.
 *
 * Pairing a bot needs a chat id, and a chat id cannot be looked up: Telegram
 * only reveals it once the human has sent the bot a message. So this waits for
 * that message rather than asking the user to read a raw `getUpdates` payload
 * and copy a number out of it.
 *
 * Usage:
 *   node connect.mjs --token '<bot id>:<secret>'   # pair, waiting for a message
 *   node connect.mjs --chat-id 12345 --token ...   # pair with a known chat
 *   node connect.mjs --test                        # send a test to stored config
 *
 * The token is written to ~/.omk/telegram.env with mode 600 and is never
 * printed: this script's own output ends up in scrollback, logs, and CI output.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnvFile } from "./credentials.ts";

const TELEGRAM_ORIGIN = "https://api.telegram.org";
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
/** Telegram caps long polling at 50s; the deadline is how long a human gets. */
const POLL_SECONDS = 50;
const DEFAULT_DEADLINE_MS = 180_000;
/** Telegram rejects a second poll while one is open, and briefly after it ends. */
const CONFLICT_CODE = 409;
const CONFLICT_BACKOFF_MS = 3000;

const USAGE = [
	"node connect.mjs --token '<bot id>:<secret>'   pair, waiting for a message",
	"node connect.mjs --chat-id 12345 --token ...   pair with a known chat",
	"node connect.mjs --test                        send a test to stored config",
	"",
	"  --file <path>     credential file (default ~/.omk/telegram.env)",
	"  --timeout <secs>  how long to wait for a message (default 180)",
].join("\n");

function parseArgs(argv) {
	const args = { test: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--help" || flag === "-h") args.help = true;
		else if (flag === "--test") args.test = true;
		else if (flag === "--token") args.token = argv[++index];
		else if (flag === "--chat-id") args.chatId = argv[++index];
		else if (flag === "--file") args.file = argv[++index];
		else if (flag === "--timeout") args.deadlineMs = Number(argv[++index]) * 1000;
		else throw new Error(`unknown argument: ${flag}`);
	}
	return args;
}

/** Telegram authenticates by path segment, so the token belongs in the URL and nowhere else. */
async function call(token, method, body) {
	const url = new URL(`/bot${token}/${method}`, TELEGRAM_ORIGIN);
	if (url.origin !== TELEGRAM_ORIGIN) throw new Error(`refusing to send outside ${TELEGRAM_ORIGIN}`);

	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const payload = await response.json();
	// The failure is reported by `description`, never by echoing the request:
	// the URL carries the token.
	if (!payload.ok) {
		const error = new Error(`${method} failed: ${payload.description ?? response.status}`);
		error.code = payload.error_code ?? response.status;
		throw error;
	}
	return payload.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for someone to message the bot, and return where they messaged from.
 *
 * Updates are consumed as they are read (`offset`), so a stale message from an
 * earlier attempt is not re-delivered and cannot pair the wrong chat.
 */
async function waitForChat(token, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	let offset;
	while (Date.now() < deadline) {
		let updates;
		try {
			updates = await call(token, "getUpdates", { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] });
		} catch (error) {
			// A poll left open by a previous attempt makes the first request here
			// fail, and it clears itself within seconds. Waiting is the whole fix;
			// anything else is a real error and belongs to the caller.
			if (error.code !== CONFLICT_CODE) throw error;
			await sleep(CONFLICT_BACKOFF_MS);
			continue;
		}

		for (const update of updates) {
			offset = update.update_id + 1;
			const chat = update.message?.chat;
			if (chat) return chat;
		}
	}
	return undefined;
}

function describeChat(chat) {
	const name = chat.username ? `@${chat.username}` : [chat.first_name, chat.last_name].filter(Boolean).join(" ");
	return `${chat.type}${name ? ` ${name}` : ""} (${chat.id})`;
}

/**
 * Rewrite the credential file, preserving unrelated keys.
 *
 * Re-pairing must not silently drop an `OMK_TELEGRAM_LABEL` or a tuned duration
 * floor that the owner set by hand.
 */
function writeCredentials(path, values) {
	let existing = {};
	try {
		existing = parseEnvFile(readFileSync(path, "utf8"));
	} catch {
		// First run. An unreadable file is replaced rather than merged: it
		// cannot be the source of settings worth keeping.
	}

	const merged = { ...existing, ...values };
	const body = Object.entries(merged)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");

	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Created 600 rather than created and then chmod'd: between the two there is
	// a window where the token is world-readable.
	writeFileSync(path, `# OMK Telegram credentials. Owner-only; never commit.\n${body}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function loadCredentials(path) {
	try {
		return parseEnvFile(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`no credentials at ${path} — run this without --test first`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}

	const path = args.file ?? join(homedir(), ".omk", "telegram.env");

	const stored = args.test ? loadCredentials(path) : {};
	const token = (args.token ?? process.env.TELEGRAM_BOT_TOKEN ?? stored.TELEGRAM_BOT_TOKEN ?? "").trim();
	if (!token) throw new Error("no token: pass --token or set TELEGRAM_BOT_TOKEN");
	if (!TOKEN_PATTERN.test(token)) throw new Error("not a Telegram bot token (expected <bot id>:<secret>)");

	const bot = await call(token, "getMe");
	console.log(`bot @${bot.username} (${bot.id})`);

	let chatId = args.chatId ?? stored.TELEGRAM_CHAT_ID;
	if (!chatId) {
		const seconds = Math.round((args.deadlineMs ?? DEFAULT_DEADLINE_MS) / 1000);
		console.log(`send @${bot.username} any message from Telegram (waiting up to ${seconds}s)...`);
		const chat = await waitForChat(token, args.deadlineMs ?? DEFAULT_DEADLINE_MS);
		if (!chat) throw new Error("no message arrived; re-run and message the bot while it waits");
		console.log(`paired with ${describeChat(chat)}`);
		chatId = String(chat.id);
	}

	if (!args.test) {
		writeCredentials(path, { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId });
		console.log(`wrote ${path} (mode 600)`);
	}

	await call(token, "sendMessage", {
		chat_id: chatId,
		text: args.test ? "OMK test message" : "OMK is connected. You will get one message when a run finishes.",
	});
	console.log("sent a message to that chat");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
