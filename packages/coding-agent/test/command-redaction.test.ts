import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as commandRedaction from "../src/guardrails/command-redaction.ts";
import {
	bindEvidenceCommandHmac,
	CommandRedactionError,
	createCommandHmacBinder,
	EVIDENCE_COMMAND_REDACTION_POLICY_ID,
	MAX_COMMAND_REDACTION_PLACEHOLDERS,
	parseCommandHmacBinding,
	parseCommandRedactionSummary,
	redactCommandDescriptor,
} from "../src/guardrails/command-redaction.ts";
import type { EvidenceCommandDescriptor } from "../src/types/evidence.ts";

function shell(script: string): EvidenceCommandDescriptor {
	return { kind: "shell", shell: "/bin/sh", script };
}

function argv(executable: string, args: string[]): EvidenceCommandDescriptor {
	return { kind: "argv", executable, argv: args };
}

describe("command redaction tokenizer", () => {
	it("tokenizes a split --token value argv pair as one typed placeholder", () => {
		const result = redactCommandDescriptor(
			argv("deploy", ["--token", "synthetic-secret-argv-value", "--region", "us"]),
		);
		expect(result.command).toEqual({
			kind: "argv",
			executable: "deploy",
			argv: ["--token", "[REDACTED]", "--region", "us"],
		});
		expect(result.summary.policyId).toBe(EVIDENCE_COMMAND_REDACTION_POLICY_ID);
		expect(result.summary.placeholders).toEqual([{ type: "cli-option-value", count: 1 }]);
	});

	it("tokenizes an attached --api-key=value argv element as an inline placeholder", () => {
		const result = redactCommandDescriptor(argv("deploy", ["--api-key=synthetic-secret-inline-value"]));
		expect(result.command).toEqual({ kind: "argv", executable: "deploy", argv: ["--api-key=[REDACTED]"] });
		expect(result.summary.placeholders).toEqual([{ type: "cli-option-inline", count: 1 }]);
	});

	it("tokenizes split and inline option forms inside a shell script", () => {
		const split = redactCommandDescriptor(shell("deploy --token synthetic-secret-shell-value --region us"));
		expect(split.command).toEqual(shell("deploy --token [REDACTED] --region us"));
		expect(split.summary.placeholders).toEqual([{ type: "cli-option-value", count: 1 }]);

		const inline = redactCommandDescriptor(shell("deploy --password=synthetic-secret-pass-value && echo ok"));
		expect(inline.command).toEqual(shell("deploy --password=[REDACTED] && echo ok"));
		expect(inline.summary.placeholders).toEqual([{ type: "cli-option-inline", count: 1 }]);
	});

	it("tokenizes secret-named environment assignments", () => {
		const scripted = redactCommandDescriptor(shell("API_TOKEN=synthetic-secret-env-value deploy --run"));
		expect(scripted.command).toEqual(shell("API_TOKEN=[REDACTED] deploy --run"));
		expect(scripted.summary.placeholders).toEqual([{ type: "env-assignment", count: 1 }]);

		const exported = redactCommandDescriptor(shell("export CLIENT_SECRET=synthetic-secret-export-value; deploy"));
		expect(exported.command).toEqual(shell("export CLIENT_SECRET=[REDACTED]; deploy"));
		expect(exported.summary.placeholders).toEqual([{ type: "env-assignment", count: 1 }]);

		const element = redactCommandDescriptor(argv("env", ["DEPLOY_PASSWORD=synthetic-secret-element-value", "run"]));
		expect(element.command).toEqual(argv("env", ["DEPLOY_PASSWORD=[REDACTED]", "run"]));
		expect(element.summary.placeholders).toEqual([{ type: "env-assignment", count: 1 }]);
	});

	it("tokenizes quoted env values without leaking fragments", () => {
		const result = redactCommandDescriptor(shell("API_TOKEN='synthetic secret with spaces' deploy"));
		expect(result.command).toEqual(shell("API_TOKEN='[REDACTED]' deploy"));
		expect(result.summary.placeholders).toEqual([{ type: "env-assignment", count: 1 }]);
		expect((result.command as { script: string }).script).not.toContain("spaces");
	});

	it("tokenizes Authorization headers while preserving the scheme", () => {
		const bearer = redactCommandDescriptor(
			shell("curl -H 'Authorization: Bearer synthetic-secret-bearer-value' https://example.test"),
		);
		expect(bearer.command).toEqual(shell("curl -H 'Authorization: Bearer [REDACTED]' https://example.test"));
		expect(bearer.summary.placeholders).toEqual([{ type: "authorization-header", count: 1 }]);

		const attached = redactCommandDescriptor(argv("curl", ["-HAuthorization: Bearer synthetic-secret-h-value"]));
		expect(attached.command).toEqual(argv("curl", ["-HAuthorization: Bearer [REDACTED]"]));
		expect(attached.summary.placeholders).toEqual([{ type: "authorization-header", count: 1 }]);

		const long = redactCommandDescriptor(
			argv("curl", ["--header=Proxy-Authorization: Basic synthetic-secret-basic"]),
		);
		expect(long.command).toEqual(argv("curl", ["--header=Proxy-Authorization: Basic [REDACTED]"]));
		expect(long.summary.placeholders).toEqual([{ type: "authorization-header", count: 1 }]);
	});

	it("tokenizes API-key headers across quoted, escaped, and curl argv forms", () => {
		const quoted = redactCommandDescriptor(
			shell('curl -H "X-API-Key: synthetic header canary" https://example.test'),
		);
		expect(quoted.command).toEqual(shell('curl -H "X-API-Key: [REDACTED]" https://example.test'));
		expect(quoted.summary.placeholders).toEqual([{ type: "api-key-header", count: 1 }]);

		const escaped = redactCommandDescriptor(
			shell("curl --header=X-Auth-Token:synthetic\\ escaped\\ canary https://example.test"),
		);
		expect(escaped.command).toEqual(shell("curl --header=X-Auth-Token:[REDACTED] https://example.test"));
		expect(escaped.summary.placeholders).toEqual([{ type: "api-key-header", count: 1 }]);

		const element = redactCommandDescriptor(
			argv("curl", ["-H", "Api-Key: synthetic argv canary", "https://example.test"]),
		);
		expect(element.command).toEqual(argv("curl", ["-H", "Api-Key: [REDACTED]", "https://example.test"]));
		expect(element.summary.placeholders).toEqual([{ type: "api-key-header", count: 1 }]);
	});

	it("normalizes static shell words before classifying header and query credentials", () => {
		const forms = [
			["printf '%s' X-API-Key\\:VALUE", "printf '%s' X-API-Key\\:[REDACTED]", "api-key-header"],
			["printf '%s' X-API-Key\\=VALUE", "printf '%s' X-API-Key\\=[REDACTED]", "api-key-header"],
			["printf '%s' 'X-API-Key':VALUE", "printf '%s' 'X-API-Key':[REDACTED]", "api-key-header"],
			["printf '%s' ?api_key\\=VALUE", "printf '%s' ?api_key\\=[REDACTED]", "url-query"],
			["printf '%s' '?api_key'=VALUE", "printf '%s' '?api_key'=[REDACTED]", "url-query"],
			["printf '%s' '?api%5Fkey=VALUE'", "printf '%s' '?api%5Fkey=[REDACTED]'", "url-query"],
		] as const;
		for (const [input, expected, type] of forms) {
			const result = redactCommandDescriptor(shell(input));
			expect(result.command).toEqual(shell(expected));
			expect(result.summary.placeholders).toEqual([{ type, count: 1 }]);
		}
	});

	it("fails closed on malformed, residual, or double percent-encoded query names", () => {
		for (const script of [
			"printf '%s' '?api%255Fkey=VALUE'",
			"printf '%s' '?api%25key=VALUE'",
			"printf '%s' '?api%ZZkey=VALUE'",
		]) {
			expect(() => redactCommandDescriptor(shell(script))).toThrow(CommandRedactionError);
		}
	});

	it("tokenizes secret URL queries and access/client secret options", () => {
		const query = redactCommandDescriptor(
			shell(
				"printf '%s' 'https://example.test/run?client_secret=synthetic-query-canary&region=us&access_token=synthetic-access-canary#done'",
			),
		);
		expect(query.command).toEqual(
			shell(
				"printf '%s' 'https://example.test/run?client_secret=[REDACTED]&region=us&access_token=[REDACTED]#done'",
			),
		);
		expect(query.summary.placeholders).toEqual([{ type: "url-query", count: 2 }]);

		const queryArgv = redactCommandDescriptor(
			argv("curl", ["https://example.test/run?api_key=synthetic argv query canary&region=us"]),
		);
		expect(queryArgv.command).toEqual(argv("curl", ["https://example.test/run?api_key=[REDACTED]&region=us"]));
		expect(queryArgv.summary.placeholders).toEqual([{ type: "url-query", count: 1 }]);

		const options = redactCommandDescriptor(
			shell('deploy --client-secret "synthetic client canary" --access-secret=synthetic\\ access\\ canary'),
		);
		expect(options.command).toEqual(shell('deploy --client-secret "[REDACTED]" --access-secret=[REDACTED]'));
		expect(options.summary.placeholders).toEqual([
			{ type: "cli-option-inline", count: 1 },
			{ type: "cli-option-value", count: 1 },
		]);

		const environment = redactCommandDescriptor(
			shell("ACCESS_SECRET=synthetic\\ env\\ canary CLIENT_SECRET='synthetic client env canary' deploy"),
		);
		expect(environment.command).toEqual(shell("ACCESS_SECRET=[REDACTED] CLIENT_SECRET='[REDACTED]' deploy"));
		expect(environment.summary.placeholders).toEqual([{ type: "env-assignment", count: 2 }]);

		const argvOption = redactCommandDescriptor(
			argv("deploy", ["--secret-access-key", "synthetic-secret-access-canary", "--region", "us"]),
		);
		expect(argvOption.command).toEqual(argv("deploy", ["--secret-access-key", "[REDACTED]", "--region", "us"]));
		expect(argvOption.summary.placeholders).toEqual([{ type: "cli-option-value", count: 1 }]);
	});

	it("fails closed on dynamic or malformed shell words without echoing them", () => {
		for (const script of [
			"printf '%s' 'X-API-Key: synthetic-unterminated-canary",
			"printf '%s' X-API-Key:$(printf synthetic-substitution-canary)",
			`printf '%s' X-API-Key:\${TOKEN:-synthetic-parameter-canary}`,
			"printf '%s' <(printf synthetic-process-canary)",
			"printf '%s' `printf synthetic-backtick-canary`",
			"printf '%s' '?api%ZZkey=synthetic-percent-canary'",
			"printf '%s' '?api_key=synthetic-trailing-canary\\",
		]) {
			let message = "";
			try {
				redactCommandDescriptor(shell(script));
			} catch (error) {
				expect(error).toBeInstanceOf(CommandRedactionError);
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toMatch(/ambiguous|failing closed/i);
			expect(message).not.toContain("canary");
		}
	});

	it("bounds static shell normalization work", () => {
		expect(() => redactCommandDescriptor(shell(`printf '%s' '${"x".repeat(70_000)}'`))).toThrow(
			CommandRedactionError,
		);
		expect(() => redactCommandDescriptor(shell(Array.from({ length: 5_000 }, () => "word").join(" ")))).toThrow(
			CommandRedactionError,
		);
	});

	it("matches vendor and custom credential headers without redacting benign headers", () => {
		for (const name of [
			"X-Goog-Api-Key",
			"X-Amz-Security-Token",
			"X-Vault-Token",
			"X-GitHub-Token",
			"X-Acme-Auth-Token",
			"X-Acme-Api-Key",
			"Api-Token",
		]) {
			const result = redactCommandDescriptor(argv("curl", ["-H", `${name}: synthetic-vendor-canary`]));
			expect(result.command).toEqual(argv("curl", ["-H", `${name}: [REDACTED]`]));
			expect(result.summary.placeholders).toHaveLength(1);
		}
		for (const name of ["Accept", "X-Request-Id", "X-Token-Count", "X-Key-Name", "Sec-WebSocket-Key"]) {
			const command = argv("curl", ["-H", `${name}: benign-value`]);
			expect(redactCommandDescriptor(command).command).toEqual(command);
		}
	});

	it("tokenizes the complete cookie header value as one placeholder", () => {
		const scripted = redactCommandDescriptor(
			shell("curl -H 'Cookie: sid=synthetic-cookie-value; theme=dark' https://example.test"),
		);
		expect(scripted.command).toEqual(shell("curl -H 'Cookie: [REDACTED]' https://example.test"));
		expect(scripted.summary.placeholders).toEqual([{ type: "cookie-header", count: 1 }]);

		const element = redactCommandDescriptor(argv("curl", ["-H", "Cookie: sid=synthetic-cookie-element; theme=dark"]));
		expect(element.command).toEqual(argv("curl", ["-H", "Cookie: [REDACTED]"]));
		expect(element.summary.placeholders).toEqual([{ type: "cookie-header", count: 1 }]);
	});

	it("tokenizes curl basic-auth values in split, attached, and pair forms", () => {
		const scripted = redactCommandDescriptor(shell("curl --user user:synthetic-basic-pass https://example.test"));
		expect(scripted.command).toEqual(shell("curl --user [REDACTED] https://example.test"));
		expect(scripted.summary.placeholders).toEqual([{ type: "basic-auth", count: 1 }]);

		const pair = redactCommandDescriptor(argv("curl", ["-u", "user:synthetic-basic-pair", "https://example.test"]));
		expect(pair.command).toEqual(argv("curl", ["-u", "[REDACTED]", "https://example.test"]));
		expect(pair.summary.placeholders).toEqual([{ type: "basic-auth", count: 1 }]);

		const attached = redactCommandDescriptor(argv("curl", ["--proxy-user=user:synthetic-basic-attached"]));
		expect(attached.command).toEqual(argv("curl", ["--proxy-user=[REDACTED]"]));
		expect(attached.summary.placeholders).toEqual([{ type: "basic-auth", count: 1 }]);
	});

	it("tokenizes URL credentials, bare bearer tokens, and known token literals", () => {
		const url = redactCommandDescriptor(shell("git clone https://alice:synthetic-url-pass@example.test/repo.git"));
		expect(url.command).toEqual(shell("git clone https://alice:[REDACTED]@example.test/repo.git"));
		expect(url.summary.placeholders).toEqual([{ type: "url-credential", count: 1 }]);

		const bearer = redactCommandDescriptor(shell("printf '%s' 'bearer synthetic.bearer.token.value1234'"));
		expect(bearer.command).toEqual(shell("printf '%s' 'bearer [REDACTED]'"));
		expect(bearer.summary.placeholders).toEqual([{ type: "bearer-token", count: 1 }]);

		const known = redactCommandDescriptor(shell("printf '%s' sk-syntheticsyntheticsynth"));
		expect(known.command).toEqual(shell("printf '%s' [REDACTED]"));
		expect(known.summary.placeholders).toEqual([{ type: "known-token", count: 1 }]);

		for (const token of [`github_pat_${"A".repeat(24)}`, `AIza${"B".repeat(35)}`]) {
			const result = redactCommandDescriptor(shell(`printf '%s' ${token}`));
			expect(result.command).toEqual(shell("printf '%s' [REDACTED]"));
			expect(result.summary.placeholders).toEqual([{ type: "known-token", count: 1 }]);
		}
	});

	it("tokenizes inside sh -c composite argv elements", () => {
		const result = redactCommandDescriptor(argv("sh", ["-c", "deploy --token synthetic-composite-value; echo ok"]));
		expect(result.command).toEqual(argv("sh", ["-c", "deploy --token [REDACTED]; echo ok"]));
		expect(result.summary.placeholders).toEqual([{ type: "cli-option-value", count: 1 }]);
	});

	it("preserves placeholder count and type across mixed forms, sorted by type", () => {
		const result = redactCommandDescriptor(
			shell(
				"API_TOKEN=synthetic-env-one deploy --token synthetic-cli-one --password synthetic-cli-two && " +
					"curl -H 'Authorization: Bearer synthetic-bearer-one' https://example.test",
			),
		);
		expect(result.summary.placeholders).toEqual([
			{ type: "authorization-header", count: 1 },
			{ type: "cli-option-value", count: 2 },
			{ type: "env-assignment", count: 1 },
		]);
		const script = (result.command as { script: string }).script;
		for (const secret of ["synthetic-env-one", "synthetic-cli-one", "synthetic-cli-two", "synthetic-bearer-one"]) {
			expect(script).not.toContain(secret);
		}
	});

	it("fails closed on oversize placeholder metadata without echoing values", () => {
		const script = Array.from(
			{ length: MAX_COMMAND_REDACTION_PLACEHOLDERS + 1 },
			(_, index) => `tool --token synthetic-oversize-${index}`,
		).join("; ");
		let message = "";
		try {
			redactCommandDescriptor(shell(script));
		} catch (error) {
			expect(error).toBeInstanceOf(CommandRedactionError);
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/placeholder/i);
		expect(message).not.toContain("synthetic-oversize");
	});

	it("fails closed on unrepresentable command shapes", () => {
		expect(() => redactCommandDescriptor(shell("echo \0"))).toThrow(CommandRedactionError);
		expect(() => redactCommandDescriptor(shell(""))).toThrow(CommandRedactionError);
		expect(() => redactCommandDescriptor(null)).toThrow(CommandRedactionError);
		expect(() => redactCommandDescriptor({ kind: "argv", executable: "node" })).toThrow(CommandRedactionError);
	});
});

describe("command redaction summary validation", () => {
	const valid = {
		policyId: EVIDENCE_COMMAND_REDACTION_POLICY_ID,
		placeholders: [
			{ type: "cli-option-value", count: 1 },
			{ type: "env-assignment", count: 2 },
		],
	};

	it("rejects structurally unbounded or malformed summaries", () => {
		const rejected: unknown[] = [
			{ ...valid, placeholders: [{ type: "unknown-type", count: 1 }] },
			{ ...valid, placeholders: [{ type: "cli-option-value", count: 0 }] },
			{ ...valid, placeholders: [{ type: "cli-option-value", count: -1 }] },
			{ ...valid, placeholders: [{ type: "cli-option-value", count: 1.5 }] },
			{
				...valid,
				placeholders: [
					{ type: "env-assignment", count: 1 },
					{ type: "cli-option-value", count: 1 },
				],
			},
			{
				...valid,
				placeholders: [
					{ type: "cli-option-value", count: 1 },
					{ type: "cli-option-value", count: 2 },
				],
			},
			{ ...valid, placeholders: [{ type: "cli-option-value", count: MAX_COMMAND_REDACTION_PLACEHOLDERS + 1 }] },
			{ ...valid, placeholders: [{ type: "cli-option-value", count: 1, extra: true }] },
			{ ...valid, extra: true },
			{ ...valid, policyId: "" },
			{ policyId: valid.policyId },
			null,
			[],
		];
		for (const candidate of rejected) {
			expect(() => parseCommandRedactionSummary(candidate)).toThrow();
		}
	});
});

describe("command HMAC binding", () => {
	const command = shell("curl --token synthetic-bind-secret-value https://example.test");

	it("produces a structurally bounded binding with no secret material", () => {
		const binding = bindEvidenceCommandHmac(command);
		expect(binding.algorithm).toBe("hmac-sha256");
		expect(binding.keyId).toMatch(/^[0-9a-f]{16}$/);
		expect(binding.nonce).toMatch(/^[0-9a-f]{32}$/);
		expect(binding.mac).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(binding)).not.toContain("synthetic-bind-secret-value");
		expect(parseCommandHmacBinding(binding)).toEqual(binding);
	});

	it("never equals a plain SHA-256 of the secret-bearing command", () => {
		const binding = bindEvidenceCommandHmac(command);
		const plainDigests = [
			createHash("sha256")
				.update((command as { script: string }).script, "utf8")
				.digest("hex"),
			createHash("sha256").update(JSON.stringify(command), "utf8").digest("hex"),
		];
		expect(plainDigests).not.toContain(binding.mac);
	});

	it("is non-deterministic per binding, so persisted MACs are not a comparison oracle", () => {
		const first = bindEvidenceCommandHmac(command);
		const second = bindEvidenceCommandHmac(command);
		expect(first.nonce).not.toBe(second.nonce);
		expect(first.mac).not.toBe(second.mac);
		expect(first.keyId).toBe(second.keyId);
	});

	it("differs across keys and only verifies with the binding key", () => {
		const binderA = createCommandHmacBinder();
		const binderB = createCommandHmacBinder();
		expect(binderA.keyId).not.toBe(binderB.keyId);

		const binding = binderA.bind(command);
		expect(binderA.verify(command, binding)).toBe(true);
		expect(binderB.verify(command, binding)).toBe(false);
		expect(binderA.verify(shell("curl https://example.test"), binding)).toBe(false);
		expect(
			binderA.verify(
				{ kind: "argv", executable: "/bin/sh", argv: [(command as { script: string }).script] },
				binding,
			),
		).toBe(false);
		expect(
			binderA.verify(
				command,
				parseCommandHmacBinding({
					...binding,
					mac: binding.mac.replace(/^./, binding.mac.startsWith("0") ? "1" : "0"),
				}),
			),
		).toBe(false);
	});

	it("rejects malformed persisted bindings", () => {
		const binding = bindEvidenceCommandHmac(command);
		const rejected: unknown[] = [
			{ ...binding, algorithm: "sha256" },
			{ ...binding, keyId: "xyz" },
			{ ...binding, nonce: "00" },
			{ ...binding, mac: binding.mac.toUpperCase() },
			{ ...binding, extra: true },
			{ algorithm: "hmac-sha256" },
			null,
		];
		for (const candidate of rejected) {
			expect(() => parseCommandHmacBinding(candidate)).toThrow();
		}
	});

	it("exposes no key material or process-key verification oracle", () => {
		const exportNames = Object.keys(commandRedaction).sort();
		expect(exportNames).toEqual(
			[
				"CommandRedactionError",
				"EVIDENCE_COMMAND_REDACTION_POLICY_ID",
				"MAX_COMMAND_REDACTION_PLACEHOLDERS",
				"assertCredentialFreeEvidenceCommand",
				"bindEvidenceCommandHmac",
				"createCommandHmacBinder",
				"parseCommandHmacBinding",
				"parseCommandRedactionSummary",
				"parseEvidenceCommandShape",
				"redactCommandDescriptor",
			].sort(),
		);
		for (const value of Object.values(commandRedaction)) {
			expect(value).not.toBeInstanceOf(Uint8Array);
		}
	});
});
