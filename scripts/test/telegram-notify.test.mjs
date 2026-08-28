import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = await import(join(repoRoot, ".omk/extensions/telegram-notify/notify.ts"));
const { buildMessage, deriveOutcome, resolveConfig, shouldNotify, telegramApiUrl } = core;

const assistant = (stopReason) => ({ role: "assistant", stopReason });

/** Shape-valid and obviously fake: `<bot id>:<secret>`, which is what Telegram issues. */
const FAKE_TOKEN = "123456789:AAdummy-Token_value";

describe("resolveConfig", () => {
	it("is inert without credentials, rather than throwing on every run", () => {
		assert.equal(resolveConfig({}), null);
		assert.equal(resolveConfig({ TELEGRAM_BOT_TOKEN: "t" }), null, "a token alone has nowhere to send");
		assert.equal(resolveConfig({ TELEGRAM_CHAT_ID: "1" }), null);
	});

	it("reads credentials only from the environment", () => {
		const config = resolveConfig({ TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: "1" });
		assert.equal(config?.token, FAKE_TOKEN);
		assert.equal(config?.chatId, "1");
	});

	it("honours an explicit off switch", () => {
		const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: "1", OMK_TELEGRAM_NOTIFY: "0" };
		assert.equal(resolveConfig(env), null);
	});

	it("rejects a non-numeric duration floor instead of silently treating it as zero", () => {
		const env = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: "1", OMK_TELEGRAM_MIN_DURATION_MS: "abc" };
		assert.throws(() => resolveConfig(env), /OMK_TELEGRAM_MIN_DURATION_MS/);
	});

	it("rejects a malformed token where it was set, rather than at send time", () => {
		// The token becomes a URL path segment. Setting one is deliberate, so a
		// malformed value is a mistake to report, not a reason to go quiet.
		assert.throws(
			() => resolveConfig({ TELEGRAM_BOT_TOKEN: "not-a-token", TELEGRAM_CHAT_ID: "1" }),
			/TELEGRAM_BOT_TOKEN/,
		);
	});

	it("never puts the token in the error it throws", () => {
		const secret = "super-secret-not-a-token";
		try {
			resolveConfig({ TELEGRAM_BOT_TOKEN: secret, TELEGRAM_CHAT_ID: "1" });
			assert.fail("expected a throw");
		} catch (error) {
			assert.doesNotMatch(String(error), new RegExp(secret));
		}
	});
});

describe("deriveOutcome", () => {
	it("reads the last assistant message, since earlier ones may have failed and retried", () => {
		assert.equal(deriveOutcome([assistant("error"), assistant("stop")]), "completed");
		assert.equal(deriveOutcome([assistant("stop"), assistant("error")]), "failed");
	});

	it("maps every stop reason", () => {
		assert.equal(deriveOutcome([assistant("stop")]), "completed");
		assert.equal(deriveOutcome([assistant("toolUse")]), "completed");
		assert.equal(deriveOutcome([assistant("length")]), "completed");
		assert.equal(deriveOutcome([assistant("error")]), "failed");
		assert.equal(deriveOutcome([assistant("aborted")]), "aborted");
	});

	it("treats an absent assistant message as completed rather than inventing a failure", () => {
		assert.equal(deriveOutcome([]), "completed");
		assert.equal(deriveOutcome([{ role: "user", content: "hi" }]), "completed");
	});
});

describe("shouldNotify", () => {
	const config = { token: "t", chatId: "1", minDurationMs: 5000, onSuccess: true, onFailure: true, onAbort: true };

	it("holds a short successful run, which is the case that would spam", () => {
		assert.equal(shouldNotify({ config, outcome: "completed", durationMs: 4999 }), false);
		assert.equal(shouldNotify({ config, outcome: "completed", durationMs: 5000 }), true);
	});

	it("sends failures and aborts immediately, since waiting hides them", () => {
		assert.equal(shouldNotify({ config, outcome: "failed", durationMs: 1 }), true);
		assert.equal(shouldNotify({ config, outcome: "aborted", durationMs: 1 }), true);
	});

	it("respects per-outcome switches", () => {
		assert.equal(shouldNotify({ config: { ...config, onSuccess: false }, outcome: "completed", durationMs: 9e5 }), false);
		assert.equal(shouldNotify({ config: { ...config, onFailure: false }, outcome: "failed", durationMs: 1 }), false);
		assert.equal(shouldNotify({ config: { ...config, onAbort: false }, outcome: "aborted", durationMs: 1 }), false);
	});
});

/**
 * A bot chat is not a private channel, and a transcript carries source, paths, and
 * whatever the user pasted. The notification exists to say "it is done", which needs
 * none of that, so the payload builder is not given the messages at all.
 */
describe("buildMessage", () => {
	it("cannot leak transcript content, because it never receives any", () => {
		assert.equal(buildMessage.length <= 1, true, "buildMessage should take one options object");
		const text = buildMessage({ outcome: "completed", durationMs: 61_000 });
		assert.match(text, /completed/i);
		assert.doesNotMatch(text, /assistant|stopReason|content/i);
	});

	it("reports duration in a form a human reads at a glance", () => {
		assert.match(buildMessage({ outcome: "completed", durationMs: 1000 }), /1s/);
		assert.match(buildMessage({ outcome: "completed", durationMs: 61_000 }), /1m 1s/);
	});

	it("includes a label only when one was supplied", () => {
		assert.match(buildMessage({ outcome: "failed", durationMs: 1, label: "omk" }), /omk/);
		assert.doesNotMatch(buildMessage({ outcome: "failed", durationMs: 1 }), /undefined|null/);
	});
});

describe("telegramApiUrl", () => {
	it("puts the token in the URL, where Telegram requires it", () => {
		assert.equal(telegramApiUrl(FAKE_TOKEN), `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
	});

	it("is the only place the token appears, so a logged payload cannot carry it", () => {
		const text = buildMessage({ outcome: "completed", durationMs: 1, label: "x" });
		assert.doesNotMatch(text, new RegExp(FAKE_TOKEN));
	});

	it("cannot be pointed at another host", () => {
		// A token is attacker-controlled URL structure if it is never checked.
		// `..` segments normalize away rather than moving hosts, but the shape
		// check refuses them outright.
		for (const hostile of ["../../evil.com", "1:x/../../../evil", "@evil.com", ""]) {
			assert.throws(() => telegramApiUrl(hostile), /malformed token/);
		}
	});

	it("only ever addresses Telegram", () => {
		assert.equal(new URL(telegramApiUrl(FAKE_TOKEN)).origin, "https://api.telegram.org");
	});
});
