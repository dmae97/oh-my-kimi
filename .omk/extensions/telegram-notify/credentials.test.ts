import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	defaultCredentialPath,
	isPermissive,
	loadCredentialFile,
	parseEnvFile,
	withCredentialFile,
} from "./credentials.ts";

function writeTempFile(contents: string, mode = 0o600): string {
	const path = join(mkdtempSync(join(tmpdir(), "omk-telegram-")), "telegram.env");
	writeFileSync(path, contents, { mode });
	return path;
}

describe("parseEnvFile", () => {
	it("reads key/value pairs", () => {
		// Given
		const source = "TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=456\n";

		// When
		const values = parseEnvFile(source);

		// Then
		assert.deepEqual(values, { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "456" });
	});

	it("ignores comments and blank lines", () => {
		// Given
		const source = "# a comment\n\n  \nTELEGRAM_CHAT_ID=456\n";

		// When
		const values = parseEnvFile(source);

		// Then
		assert.deepEqual(values, { TELEGRAM_CHAT_ID: "456" });
	});

	it("keeps separators inside a value", () => {
		// Given a bot token, which contains the separator character.
		const source = "TELEGRAM_BOT_TOKEN=8838296047:AAH-dZz_t0\n";

		// When
		const values = parseEnvFile(source);

		// Then
		assert.equal(values.TELEGRAM_BOT_TOKEN, "8838296047:AAH-dZz_t0");
	});

	it("strips surrounding quotes", () => {
		// Given
		const source = `A="quoted"\nB='single'\nC=un"quoted"\n`;

		// When
		const values = parseEnvFile(source);

		// Then
		assert.deepEqual(values, { A: "quoted", B: "single", C: `un"quoted"` });
	});

	it("skips lines that are not assignments", () => {
		// Given
		const source = "export TELEGRAM_CHAT_ID=456\nnot a line\n=novalue\nOK=1\n";

		// When
		const values = parseEnvFile(source);

		// Then only the plain identifier survives; `export` is shell, not this format.
		assert.deepEqual(values, { OK: "1" });
	});
});

describe("isPermissive", () => {
	it("accepts owner-only", () => {
		// Given / When / Then
		assert.equal(isPermissive(0o600), false);
	});

	it("rejects group- and world-readable modes", () => {
		// Given / When / Then
		assert.equal(isPermissive(0o640), true);
		assert.equal(isPermissive(0o604), true);
	});
});

describe("loadCredentialFile", () => {
	it("returns nothing when the file is absent", () => {
		// Given
		const path = join(tmpdir(), "omk-telegram-does-not-exist", "telegram.env");

		// When
		const loaded = loadCredentialFile(path);

		// Then absence is the normal case and must not throw.
		assert.deepEqual(loaded, { values: {} });
	});

	it("reads an owner-only file without complaint", () => {
		// Given
		const path = writeTempFile("TELEGRAM_CHAT_ID=456\n", 0o600);

		// When
		const loaded = loadCredentialFile(path);

		// Then
		assert.deepEqual(loaded, { values: { TELEGRAM_CHAT_ID: "456" } });
	});

	it("reports a file readable beyond its owner", () => {
		// Given
		const path = writeTempFile("TELEGRAM_CHAT_ID=456\n", 0o644);

		// When
		const loaded = loadCredentialFile(path);

		// Then the values are still returned: refusing to notify is not a security win.
		assert.equal(loaded.values.TELEGRAM_CHAT_ID, "456");
		assert.equal(loaded.permissiveMode, 0o644);
	});
});

describe("withCredentialFile", () => {
	it("supplies values the environment does not have", () => {
		// Given
		const path = writeTempFile("TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=456\n");

		// When
		const { env } = withCredentialFile({ OMK_TELEGRAM_ENV_FILE: path });

		// Then
		assert.equal(env.TELEGRAM_BOT_TOKEN, "123:abc");
		assert.equal(env.TELEGRAM_CHAT_ID, "456");
	});

	it("lets the environment win", () => {
		// Given a stored chat and a one-off override in front of the command.
		const path = writeTempFile("TELEGRAM_CHAT_ID=456\n");

		// When
		const { env } = withCredentialFile({ OMK_TELEGRAM_ENV_FILE: path, TELEGRAM_CHAT_ID: "999" });

		// Then the explicit instruction is the more specific one.
		assert.equal(env.TELEGRAM_CHAT_ID, "999");
	});

	it("returns the environment unchanged when there is no file", () => {
		// Given
		const env = { OMK_TELEGRAM_ENV_FILE: join(tmpdir(), "omk-telegram-absent", "telegram.env") };

		// When
		const result = withCredentialFile(env);

		// Then
		assert.equal(result.env, env);
		assert.equal(result.permissiveMode, undefined);
	});

	it("passes the permissive mode through to the caller", () => {
		// Given
		const path = writeTempFile("TELEGRAM_CHAT_ID=456\n", 0o644);

		// When
		const { permissiveMode } = withCredentialFile({ OMK_TELEGRAM_ENV_FILE: path });

		// Then
		assert.equal(permissiveMode, 0o644);
	});
});

describe("defaultCredentialPath", () => {
	it("lands in the agent home", () => {
		// Given / When
		const path = defaultCredentialPath({});

		// Then it is outside any repository: a token in a checkout is a token in every checkout.
		assert.match(path, /\.omk[/\\]telegram\.env$/);
	});

	it("honours an explicit override", () => {
		// Given
		const env = { OMK_TELEGRAM_ENV_FILE: "/tmp/custom.env" };

		// When / Then
		assert.equal(defaultCredentialPath(env), "/tmp/custom.env");
	});
});
