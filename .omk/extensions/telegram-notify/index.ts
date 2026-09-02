/**
 * Telegram completion notifier.
 *
 * Sends one message when an agent run settles, so a long task can be started and
 * walked away from. It is one-way: nothing here reads Telegram, and no message
 * can drive OMK. Inbound control would mean anyone who can message the bot gets
 * command execution on this machine, which is a different feature with a
 * different threat model and is deliberately not this one.
 *
 * Configuration comes from the environment, or from an owner-only credential
 * file when the environment is silent; see README.md.
 */

import type { ExtensionAPI } from "open-multi-agent-kit";
import { defaultCredentialPath, withCredentialFile } from "./credentials.ts";
import { buildMessage, deriveOutcome, resolveConfig, shouldNotify, telegramApiUrl } from "./notify.ts";

/** Bound so a hung request cannot outlive the run that triggered it. */
const REQUEST_TIMEOUT_MS = 10_000;

export default function telegramNotifyExtension(omk: ExtensionAPI): void {
	// Read once at startup. The credential file is configuration, and re-reading
	// it would put a disk read on the settle path of every run.
	const { env, permissiveMode } = withCredentialFile(process.env);

	// Missing credentials are the normal case for anyone who has not set this
	// up, so the extension registers nothing rather than failing every run.
	const config = resolveConfig(env);
	if (!config) return;

	const label = env.OMK_TELEGRAM_LABEL?.trim() || undefined;
	let startedAt: number | undefined;

	if (permissiveMode !== undefined) {
		// Once, at startup. A warning attached to every notification is a warning
		// that gets filtered out.
		omk.on("session_start", (_event, ctx) => {
			const mode = permissiveMode.toString(8).padStart(3, "0");
			ctx.ui.notify(`Telegram credential file is mode ${mode}; run chmod 600 ${defaultCredentialPath(env)}`, "warning");
		});
	}

	omk.on("agent_start", () => {
		startedAt = Date.now();
	});

	omk.on("agent_settled", async (event) => {
		const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt;
		startedAt = undefined;

		const outcome = deriveOutcome(event.messages);
		if (!shouldNotify({ config, outcome, durationMs })) return;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			await fetch(telegramApiUrl(config.token), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: config.chatId,
					text: buildMessage({ outcome, durationMs, label }),
					disable_notification: outcome === "completed",
				}),
				signal: controller.signal,
			});
		} catch {
			// A notification is not the work. Telegram being unreachable, rate
			// limiting, or a revoked token must not fail the run that just
			// finished, and the error is not surfaced because its message can
			// carry the request URL, which carries the token.
		} finally {
			clearTimeout(timer);
		}
	});
}
