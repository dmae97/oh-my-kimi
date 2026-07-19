import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type CreateEvidenceReceiptInput,
	computeEvidenceReceiptCoreSha256,
	constantTimeSha256Equal,
	createEvidenceReceipt,
	type EvidenceReceiptCoreInputFields,
	evidenceReceiptReplayPayload,
	MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES,
	parseEvidenceReceipt,
	parseEvidenceReceiptCore,
	parseSha256Hex,
	serializeEvidenceReceipt,
	validateEvidenceReceipt,
	withEvidenceReceiptEnvelope,
} from "../src/guardrails/evidence-receipt.ts";
import { EvidenceGate } from "../src/guardrails/evidence-system.ts";
import {
	computeGitWorkspaceDirtySha256,
	computeGitWorkspaceManifestSha256,
	computeWorkspaceManifestSha256,
} from "../src/guardrails/workspace-fingerprint.ts";
import type {
	ArtifactState,
	EvidenceReceiptStatus,
	FileArtifactState,
	TaskContract,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../src/types/evidence.ts";

function sha256(value: string): ReturnType<typeof parseSha256Hex> {
	return parseSha256Hex(createHash("sha256").update(value).digest("hex"));
}

function fingerprint(contents = "artifact-v1"): WorkspaceFingerprint {
	const scope: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };
	const artifacts: ArtifactState[] = [
		{ path: "dist/result.txt", state: "file", sha256: sha256(contents), size: Buffer.byteLength(contents) },
	];
	return {
		kind: "artifact-set",
		scope,
		artifacts,
		manifestSha256: computeWorkspaceManifestSha256(scope, artifacts),
	};
}

const BASE_FIELDS: EvidenceReceiptCoreInputFields = {
	receiptId: "receipt-001",
	goalId: "goal-001",
	laneId: "lane-001",
	claim: "focused verification passed",
	command: { kind: "argv", executable: "node", argv: ["--run", "alpha beta"] },
	cwd: "/workspace",
	timeoutMs: 30_000,
	startedAt: "2026-07-15T10:00:00.000Z",
	finishedAt: "2026-07-15T10:00:01.250Z",
	durationMs: 1_250,
	workspaceBefore: fingerprint(),
	workspaceAfter: fingerprint(),
	alreadyRedactedOutput: {
		redactionPolicyId: "policy-v1",
		stdout: Buffer.from("already-redacted stdout\n"),
		stderr: Buffer.from(""),
	},
	executor: "internal",
	toolCallId: "tool-call-001",
};

type ReceiptOverrides = Partial<EvidenceReceiptCoreInputFields> & {
	readonly status?: EvidenceReceiptStatus;
	readonly exitCode?: number | null;
};

function receipt(overrides: ReceiptOverrides = {}) {
	return createEvidenceReceipt({
		...BASE_FIELDS,
		status: "passed",
		exitCode: 0,
		...overrides,
	} as CreateEvidenceReceiptInput);
}

function gitFingerprint(headCommit: string | null, untrackedContents = "untracked-v1"): WorkspaceFingerprint {
	const scope: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };
	const artifacts: FileArtifactState[] = [
		{
			path: "dist/result.txt",
			state: "file",
			sha256: sha256(untrackedContents),
			size: Buffer.byteLength(untrackedContents),
		},
	];
	const changedPaths = ["dist/result.txt"];
	const stagedDiffSha256 = sha256("");
	const unstagedDiffSha256 = sha256("");
	const git = {
		headCommit,
		changedPaths,
		stagedDiffSha256,
		unstagedDiffSha256,
		dirtySha256: computeGitWorkspaceDirtySha256(changedPaths, stagedDiffSha256, unstagedDiffSha256, artifacts),
	};
	return {
		kind: "git",
		scope,
		artifacts,
		git,
		manifestSha256: computeGitWorkspaceManifestSha256(scope, artifacts, git),
	};
}

function receiptWithAllOptionalFields() {
	return withEvidenceReceiptEnvelope(receipt(), {
		ledgerBinding: { seq: 4, eventHash: sha256("ledger-event") },
		trustedAttestation: {
			attesterId: "trusted-executor-1",
			keyId: "key-1",
			algorithm: "ed25519",
			signature: "synthetic-public-signature",
			issuedAt: "2026-07-15T10:00:02.000Z",
		},
	});
}

const OPTIONAL_RECEIPT_FIELDS = [
	["core", "laneId"],
	["core", "toolCallId"],
	["envelope", "ledgerBinding"],
	["envelope", "trustedAttestation"],
] as const;

type MutableReceipt = {
	core: Record<string, unknown>;
	envelope: Record<string, unknown>;
};

describe("evidence receipt v3", () => {
	it("round-trips receipts carrying git workspace fingerprints", () => {
		// Given: receipts whose fingerprints use the git kind, including an unborn HEAD.
		const bornHead = "a".repeat(40);
		const gitReceipt = receipt({
			workspaceBefore: gitFingerprint(null, "before"),
			workspaceAfter: gitFingerprint(bornHead, "after"),
		});

		// When: the receipt is serialized and strictly re-parsed.
		const reparsed = parseEvidenceReceipt(serializeEvidenceReceipt(gitReceipt));

		// Then: the git fingerprints survive the round trip exactly.
		expect(reparsed).toEqual(gitReceipt);
		expect(reparsed.core.workspaceBefore.kind).toBe("git");
		expect(reparsed.core.workspaceAfter.kind).toBe("git");

		// Then: the digest binds git fingerprint content.
		expect(receipt({ workspaceAfter: gitFingerprint(bornHead, "other") }).envelope.coreSha256).not.toBe(
			gitReceipt.envelope.coreSha256,
		);

		// When/Then: a tampered HEAD inside the receipt fails validation.
		const tampered = structuredClone(gitReceipt) as unknown as {
			core: { workspaceAfter: { git: { headCommit: string } } };
		};
		tampered.core.workspaceAfter.git.headCommit = "b".repeat(40);
		expect(() => validateEvidenceReceipt(tampered)).toThrow(/manifest digest mismatch/);
	});

	it("accepts receipts mixing artifact-set and git fingerprint kinds", () => {
		// Given: a workspace that became a git repository between captures.
		const mixed = receipt({
			workspaceBefore: fingerprint("plain"),
			workspaceAfter: gitFingerprint("c".repeat(40)),
		});

		// When/Then: each fingerprint is validated by its own kind.
		expect(parseEvidenceReceipt(serializeEvidenceReceipt(mixed)).core.workspaceBefore.kind).toBe("artifact-set");
		expect(mixed.core.workspaceAfter.kind).toBe("git");
	});

	it("produces a deterministic domain-separated core digest", () => {
		const first = receipt();
		const second = receipt();
		expect(first.envelope.coreSha256).toBe(second.envelope.coreSha256);
		expect(first.envelope.coreSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(computeEvidenceReceiptCoreSha256(first.core)).toBe(first.envelope.coreSha256);
	});

	it("binds every execution field and exact argv boundaries", () => {
		const baseline = receipt().envelope.coreSha256;
		const changed = [
			receipt({ command: { kind: "argv", executable: "nodejs", argv: ["--run", "alpha beta"] } }),
			receipt({ command: { kind: "argv", executable: "node", argv: ["--run", "alpha", "beta"] } }),
			receipt({ cwd: "/workspace/subdir" }),
			receipt({ timeoutMs: 30_001 }),
			receipt({
				alreadyRedactedOutput: {
					redactionPolicyId: "policy-v1",
					stdout: Buffer.from("different redacted output\n"),
					stderr: Buffer.from(""),
				},
			}),
			receipt({ status: "failed", exitCode: 7 }),
			receipt({ workspaceAfter: fingerprint("artifact-v2") }),
		];
		for (const candidate of changed) expect(candidate.envelope.coreSha256).not.toBe(baseline);
	});

	it("preserves shell identity and script whitespace exactly", () => {
		const first = receipt({ command: { kind: "shell", shell: "/bin/sh", script: "printf '%s\\n' ok" } });
		const whitespaceChanged = receipt({
			command: { kind: "shell", shell: "/bin/sh", script: "printf  '%s\\n' ok" },
		});
		const shellChanged = receipt({
			command: { kind: "shell", shell: "/bin/bash", script: "printf '%s\\n' ok" },
		});
		expect(whitespaceChanged.envelope.coreSha256).not.toBe(first.envelope.coreSha256);
		expect(shellChanged.envelope.coreSha256).not.toBe(first.envelope.coreSha256);
	});

	it("stores only output digests, byte counts, and redaction policy metadata", () => {
		const value = receipt({
			alreadyRedactedOutput: {
				redactionPolicyId: "policy-v2",
				stdout: Buffer.from("ordinary-visible-output"),
				stderr: Buffer.from("ordinary-visible-error"),
			},
		});
		const serialized = serializeEvidenceReceipt(value);
		expect(serialized).not.toContain("ordinary-visible-output");
		expect(serialized).not.toContain("ordinary-visible-error");
		expect(value.core.output.stdout.byteCount).toBe(Buffer.byteLength("ordinary-visible-output"));
		expect(value.core.output.redactionPolicyId).toBe("policy-v2");
	});

	it("rejects contradictory status/exit combinations", () => {
		expect(() => receipt({ status: "passed", exitCode: 1 })).toThrow(/passed.*exitCode 0/);
		expect(() => receipt({ status: "failed", exitCode: 0 })).toThrow(/failed.*non-zero/);
		expect(() => receipt({ status: "timeout", exitCode: 1 })).toThrow(/timeout.*null/);
		expect(() => receipt({ status: "aborted", exitCode: 130 })).toThrow(/aborted.*null/);
	});

	it("strictly rejects malformed and uppercase digests", () => {
		const encoded = JSON.parse(serializeEvidenceReceipt(receipt())) as {
			core: Record<string, unknown>;
			envelope: { coreSha256: string };
		};
		encoded.envelope.coreSha256 = encoded.envelope.coreSha256.toUpperCase();
		expect(() => parseEvidenceReceipt(JSON.stringify(encoded))).toThrow(/lowercase SHA-256/);
		encoded.envelope.coreSha256 = "0".repeat(63);
		expect(() => parseEvidenceReceipt(JSON.stringify(encoded))).toThrow(/64 lowercase/);
		encoded.core.unrecognized = true;
		expect(() => parseEvidenceReceipt(JSON.stringify(encoded))).toThrow(/invalid key set/);
		expect(constantTimeSha256Equal("xyz", sha256("x"))).toBe(false);
	});

	it("rejects inline credential-shaped command descriptors without echoing them", () => {
		const inlineValue = "synthetic-inline-secret-value";
		let message = "";
		try {
			receipt({ command: { kind: "shell", shell: "/bin/sh", script: `curl --token ${inlineValue}` } });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/credential-shaped/);
		expect(message).not.toContain(inlineValue);
		expect(() =>
			receipt({ command: { kind: "argv", executable: "tool", argv: ["--api-key", inlineValue] } }),
		).toThrow(/credential-shaped/);
		expect(() =>
			receipt({ command: { kind: "argv", executable: "tool", argv: ["--api-key", "$API_KEY"] } }),
		).not.toThrow();
	});

	it("accepts real variable provenance or explicit redaction markers in credential fields", () => {
		const scripts = [
			`curl -H "Authorization: Bearer \${TOKEN}" https://example.test`,
			`curl -H"Authorization: Bearer \${TOKEN}" https://example.test`,
			`curl --header="Authorization: Basic \${BASIC_AUTH}" https://example.test`,
			"printf '%s' 'Authorization: Bearer [REDACTED]'",
			`printf '%s' "Proxy-Authorization: Basic \${BASIC_AUTH}"`,
			`printf '%s' "Authorization: Basic \${BASIC_AUTH}"`,
			"curl -H 'Cookie: [REDACTED]' https://example.test",
			`curl -H"Cookie: \${COOKIE}" https://example.test`,
			"COOKIE=$COOKIE; printf done",
			"printf '%s' X-API-Key\\:[REDACTED]",
			"printf '%s' 'X-API-Key':[REDACTED]",
			"printf '%s' ?api_key\\=[REDACTED]",
			"printf '%s' '?api_key'=[REDACTED]",
			"printf '%s' '?api%5Fkey=[REDACTED]'",
		];
		for (const script of scripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).not.toThrow();
		}
	});

	it("requires the complete cookie header value to be one placeholder", () => {
		const rejectedScripts = [
			"curl -H 'Cookie: $COOKIE' https://example.test",
			"curl -H 'Cookie: $COOKIE; sid=synthetic-literal' https://example.test",
			"curl -H 'Cookie: $COOKIE;sid=synthetic-literal' https://example.test",
			"curl -H 'Cookie: sid=synthetic-literal; $COOKIE' https://example.test",
			"curl -H 'Cookie: $COOKIE trailing-literal' https://example.test",
			"curl -H 'Cookie: leading-literal $COOKIE' https://example.test",
			"curl -H 'Cookie: $FIRST_COOKIE; $SECOND_COOKIE' https://example.test",
			"curl --header='Set-Cookie: $COOKIE; Secure' https://example.test",
			"curl -H 'Cookie:' https://example.test",
			"curl -H 'Cookie: $COOKIE' https://example.test; curl -H 'Cookie: sid=synthetic-literal' https://example.test",
		];
		for (const script of rejectedScripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).toThrow(/credential-shaped/);
		}

		const rejectedArgv = [
			["-H", "Cookie: $COOKIE; sid=synthetic-literal"],
			["--header=Cookie: $COOKIE;sid=synthetic-literal"],
			["-HCookie: sid=synthetic-literal; $COOKIE"],
			["-HCookie: $COOKIE", "-HCookie: sid=synthetic-literal"],
		];
		for (const argv of rejectedArgv) {
			expect(() => receipt({ command: { kind: "argv", executable: "curl", argv } })).toThrow(/credential-shaped/);
		}

		const exactPlaceholderScripts = [
			`curl -H "Cookie: \${COOKIE}" https://example.test`,
			"curl --header='Set-Cookie: [REDACTED]' https://example.test",
		];
		for (const script of exactPlaceholderScripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).not.toThrow();
		}

		const exactPlaceholderArgv = [["-H", "Cookie: $COOKIE"], ["--header=Set-Cookie: <masked>"]];
		for (const argv of exactPlaceholderArgv) {
			expect(() => receipt({ command: { kind: "argv", executable: "curl", argv } })).not.toThrow();
		}
	});

	it("rejects literal and unquoted split pseudo-header values in isolation", () => {
		const scripts = [
			"curl -H 'Authorization: Bearer synthetic-literal' https://example.test",
			"curl -HAuthorization: Bearer $TOKEN https://example.test",
			`curl --header=Authorization: Basic \${BASIC_AUTH} https://example.test`,
			"curl -HCookie: $COOKIE https://example.test",
			"curl -HAuthorization: Bearer synthetic-literal https://example.test",
			"curl -HCookie: session=synthetic-literal https://example.test",
			"curl --header=Authorization: Basic synthetic-literal https://example.test",
			"printf '%s' 'Authorization: Basic synthetic-literal'",
			"printf '%s' 'Proxy-Authorization: Bearer synthetic-literal'",
			"AUTHORIZATION=synthetic-literal",
			"curl -H 'Cookie: session=synthetic-literal' https://example.test",
			"COOKIE=synthetic-literal",
			"printf '%s' X-API-Key\\:VALUE",
			"printf '%s' 'X-API-Key':VALUE",
			"printf '%s' ?api_key\\=VALUE",
			"printf '%s' '?api_key'=VALUE",
			"printf '%s' '?api%5Fkey=VALUE'",
		];
		for (const script of scripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).toThrow(/credential-shaped/);
		}
	});

	it("scans attached header forms and every composite header in direct argv", () => {
		const rejectedArgv = [
			["-HAuthorization: Bearer synthetic-literal"],
			["-HCookie: session=synthetic-literal"],
			["--header=Authorization: Basic synthetic-literal"],
			["Proxy-Authorization: Bearer synthetic-literal"],
			["-HAuthorization: Bearer $TOKEN", "-HCookie: session=synthetic-literal"],
		];
		for (const argv of rejectedArgv) {
			expect(() => receipt({ command: { kind: "argv", executable: "curl", argv } })).toThrow(/credential-shaped/);
		}

		const placeholderArgv = [
			["-HAuthorization: Bearer $TOKEN"],
			["-HCookie: [REDACTED]"],
			[`--header=Authorization: Basic \${BASIC_AUTH}`],
			["Proxy-Authorization: Bearer <masked>"],
		];
		for (const argv of placeholderArgv) {
			expect(() => receipt({ command: { kind: "argv", executable: "curl", argv } })).not.toThrow();
		}
	});

	it("scans attached headers in sh -c composites without matching unrelated words", () => {
		expect(() =>
			receipt({
				command: {
					kind: "argv",
					executable: "sh",
					argv: ["-c", "curl -HAuthorization: Bearer $TOKEN; curl --header=Cookie: session=synthetic-literal"],
				},
			}),
		).toThrow(/credential-shaped/);

		for (const command of [
			{ kind: "argv" as const, executable: "tool", argv: ["preauthorization: synthetic", "cookiecutter=synthetic"] },
			{
				kind: "shell" as const,
				shell: "/bin/sh",
				script: "printf '%s' 'preauthorization: synthetic cookiecutter=synthetic'",
			},
		]) {
			expect(() => receipt({ command })).not.toThrow();
		}
	});

	it("rejects split and inline basic-auth argv literals after any placeholders", () => {
		const inlineValue = "synthetic-basic-auth-value";
		const rejectedArgv = [
			["-u", inlineValue],
			["-U", inlineValue],
			["--user", inlineValue],
			["--proxy-user", inlineValue],
			[`-u${inlineValue}`],
			[`-U${inlineValue}`],
			[`-u=${inlineValue}`],
			[`-U=${inlineValue}`],
			[`--user=${inlineValue}`],
			[`--proxy-user=${inlineValue}`],
			["-u$BASIC_AUTH", `-U${inlineValue}`],
			["-U[REDACTED]", `-u${inlineValue}`],
			["-u", "$BASIC_AUTH", "--user", inlineValue],
			["--user=$BASIC_AUTH", `--proxy-user=${inlineValue}`],
		];
		for (const argv of rejectedArgv) {
			expect(() => receipt({ command: { kind: "argv", executable: "curl", argv } })).toThrow(/credential-shaped/);
		}

		const placeholderArgv = [
			["-u", "$BASIC_AUTH"],
			["-U", `\${PROXY_AUTH}`],
			["-u$BASIC_AUTH"],
			["-U[REDACTED]"],
			[`-u=\${BASIC_AUTH}`],
			["-U=<masked>"],
			["--user", `\${BASIC_AUTH}`],
			["--proxy-user", "[REDACTED]"],
			["--user=<masked>"],
			["--proxy-user=$PROXY_AUTH"],
		];
		for (const argv of placeholderArgv) {
			expect(() => receipt({ command: { kind: "argv", executable: "curl", argv } })).not.toThrow();
		}
	});

	it("rejects every shell basic and proxy-auth form while permitting explicit placeholders", () => {
		const literal = "user:synthetic-password";
		const rejectedScripts = [
			`curl -u${literal} https://example.test`,
			`curl -U${literal} https://example.test`,
			`curl -u ${literal} https://example.test`,
			`curl -U ${literal} https://example.test`,
			`curl -u=${literal} https://example.test`,
			`curl -U=${literal} https://example.test`,
			`curl --user=${literal} https://example.test`,
			`curl --user ${literal} https://example.test`,
			`curl --proxy-user=${literal} https://example.test`,
			`curl --proxy-user ${literal} https://example.test`,
			`curl -u$BASIC_AUTH https://example.test; curl -U${literal} https://example.test`,
		];
		for (const script of rejectedScripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).toThrow(/credential-shaped/);
		}

		const placeholderScripts = [
			"curl -u$BASIC_AUTH https://example.test",
			`curl -U\${PROXY_AUTH} https://example.test`,
			"curl -uuser:$PASSWORD https://example.test",
			"curl -Uuser:[REDACTED] https://example.test",
			"curl --user=<masked> https://example.test",
			`curl --proxy-user user:\${PROXY_PASSWORD} https://example.test`,
		];
		for (const script of placeholderScripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).not.toThrow();
		}
	});

	it("rejects a later literal basic-auth occurrence inside an sh -c composite", () => {
		expect(() =>
			receipt({
				command: {
					kind: "argv",
					executable: "sh",
					argv: [
						"-c",
						"curl --user=$BASIC_AUTH https://example.test; curl --proxy-user user:synthetic-password https://example.test",
					],
				},
			}),
		).toThrow(/credential-shaped/);
	});

	it("scans every shell-script credential occurrence after placeholders", () => {
		const inlineValue = "synthetic-later-inline-value";
		const knownToken = `sk-${"x".repeat(16)}`;
		const scripts = [
			`API_TOKEN=$API_TOKEN; API_TOKEN=${inlineValue}`,
			`tool --token $TOKEN; tool --token ${inlineValue}`,
			`Authorization: Bearer [REDACTED]; Authorization: Bearer ${inlineValue}`,
			`Authorization: Basic [MASKED]; Authorization: Basic ${inlineValue}`,
			`fetch https://user:[REDACTED]@example.test; fetch https://user:${inlineValue}@example.test`,
			`printf '%s' $TOKEN; printf '%s' ${knownToken}`,
		];
		for (const script of scripts) {
			expect(() => receipt({ command: { kind: "shell", shell: "/bin/sh", script } })).toThrow(/credential-shaped/);
		}
	});

	it("scans every credential occurrence inside an sh -c argv", () => {
		expect(() =>
			receipt({
				command: {
					kind: "argv",
					executable: "sh",
					argv: ["-c", "tool --api-key $API_KEY; tool --api-key synthetic-later-inline-value"],
				},
			}),
		).toThrow(/credential-shaped/);
	});

	it("rejects command accessors without invoking their getters", () => {
		for (const key of ["kind", "executable", "argv"] as const) {
			const command: Record<string, unknown> = { kind: "argv", executable: "node", argv: ["--version"] };
			const field = command[key];
			let getterInvoked = false;
			delete command[key];
			Object.defineProperty(command, key, {
				enumerable: true,
				get: () => {
					getterInvoked = true;
					return field;
				},
			});
			expect(() => receipt({ command: command as unknown as EvidenceReceiptCoreInputFields["command"] })).toThrow(
				/invalid key set/,
			);
			expect(getterInvoked).toBe(false);
		}
	});

	it("rejects inherited, sparse, non-enumerable, and accessor argv indices without invoking getters", () => {
		const mutations: Array<(argv: unknown[], onGetter: () => void) => void> = [
			(argv) => {
				const inherited = Object.create(Array.prototype) as Record<string, unknown>;
				inherited[0] = argv[0];
				delete argv[0];
				Object.setPrototypeOf(argv, inherited);
			},
			(argv) => {
				delete argv[0];
			},
			(argv) => {
				Object.defineProperty(argv, "0", { value: argv[0], enumerable: false });
			},
			(argv, onGetter) => {
				const value = argv[0];
				Object.defineProperty(argv, "0", {
					enumerable: true,
					get: () => {
						onGetter();
						return value;
					},
				});
			},
		];

		for (const mutate of mutations) {
			const core = structuredClone(receipt().core) as unknown as { command: { argv: unknown[] } };
			let getterInvoked = false;
			mutate(core.command.argv, () => {
				getterInvoked = true;
			});
			expect(() => parseEvidenceReceiptCore(core)).toThrow(/own enumerable data index/);
			expect(getterInvoked).toBe(false);
		}
	});

	it("requires required fields to be own enumerable properties", () => {
		const core = structuredClone(receipt().core) as unknown as Record<string, unknown>;
		const goalId = core.goalId;
		delete core.goalId;
		Object.setPrototypeOf(core, { goalId });
		expect(() => parseEvidenceReceiptCore(core)).toThrow(/invalid key set/);

		Object.defineProperty(core, "goalId", { value: goalId, enumerable: false });
		expect(() => parseEvidenceReceiptCore(core)).toThrow(/invalid key set/);
	});

	it("rejects inherited optional fields", () => {
		for (const [location, key] of OPTIONAL_RECEIPT_FIELDS) {
			const candidate = structuredClone(receiptWithAllOptionalFields()) as unknown as MutableReceipt;
			const target = candidate[location];
			const field = target[key];
			delete target[key];
			Object.setPrototypeOf(target, { [key]: field });
			expect(() => validateEvidenceReceipt(candidate)).toThrow(/invalid key set/);
		}
	});

	it("rejects non-enumerable optional fields", () => {
		for (const [location, key] of OPTIONAL_RECEIPT_FIELDS) {
			const candidate = structuredClone(receiptWithAllOptionalFields()) as unknown as MutableReceipt;
			const target = candidate[location];
			const field = target[key];
			delete target[key];
			Object.defineProperty(target, key, { value: field, enumerable: false });
			expect(() => validateEvidenceReceipt(candidate)).toThrow(/invalid key set/);
		}
	});

	it("rejects optional accessors without invoking their getters", () => {
		for (const [location, key] of OPTIONAL_RECEIPT_FIELDS) {
			const candidate = structuredClone(receiptWithAllOptionalFields()) as unknown as MutableReceipt;
			const target = candidate[location];
			const field = target[key];
			let getterInvoked = false;
			delete target[key];
			Object.defineProperty(target, key, {
				enumerable: true,
				get: () => {
					getterInvoked = true;
					return field;
				},
			});
			expect(() => validateEvidenceReceipt(candidate)).toThrow(/invalid key set/);
			expect(getterInvoked).toBe(false);
		}
	});

	it("rejects output above the fixed capture limit", () => {
		expect(() =>
			receipt({
				alreadyRedactedOutput: {
					redactionPolicyId: "policy-v1",
					stdout: Buffer.alloc(MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES + 1),
					stderr: Buffer.alloc(0),
				},
			}),
		).toThrow(/exceeds/);
	});

	it("keeps ledger and optional attestation metadata outside the core digest", () => {
		const initial = receipt();
		const finalized = receiptWithAllOptionalFields();
		expect(finalized.envelope.coreSha256).toBe(initial.envelope.coreSha256);
		expect(finalized.core.laneId).toBe("lane-001");
		expect(finalized.core.toolCallId).toBe("tool-call-001");
		expect(finalized.envelope.ledgerBinding?.seq).toBe(4);
		expect(finalized.envelope.trustedAttestation?.attesterId).toBe("trusted-executor-1");
		expect(evidenceReceiptReplayPayload(finalized)).toEqual({
			receiptId: "receipt-001",
			coreSha256: initial.envelope.coreSha256,
		});
	});

	it("binds command redaction metadata and HMAC binding into the core digest", () => {
		const commandRedaction = {
			policyId: "omk-command-redaction-v1",
			placeholders: [{ type: "cli-option-value" as const, count: 1 }],
		};
		const commandBinding = {
			algorithm: "hmac-sha256" as const,
			keyId: "0123456789abcdef",
			nonce: "0123456789abcdef0123456789abcdef",
			mac: sha256("synthetic-mac-source"),
		};
		const redacted = receipt({
			command: { kind: "argv", executable: "curl", argv: ["--token", "[REDACTED]"] },
			commandRedaction,
			commandBinding,
		});

		// Round-trip: strict parse preserves both persisted structures exactly.
		const reparsed = parseEvidenceReceipt(serializeEvidenceReceipt(redacted));
		expect(reparsed.core.commandRedaction).toEqual(commandRedaction);
		expect(reparsed.core.commandBinding).toEqual(commandBinding);

		// The core digest covers placeholder metadata and the binding MAC.
		const placeholderChanged = receipt({
			command: { kind: "argv", executable: "curl", argv: ["--token", "[REDACTED]"] },
			commandRedaction: {
				policyId: "omk-command-redaction-v1",
				placeholders: [{ type: "cli-option-value" as const, count: 2 }],
			},
			commandBinding,
		});
		const macChanged = receipt({
			command: { kind: "argv", executable: "curl", argv: ["--token", "[REDACTED]"] },
			commandRedaction,
			commandBinding: { ...commandBinding, mac: sha256("synthetic-other-mac-source") },
		});
		expect(placeholderChanged.envelope.coreSha256).not.toBe(redacted.envelope.coreSha256);
		expect(macChanged.envelope.coreSha256).not.toBe(redacted.envelope.coreSha256);
	});

	it("fails closed when redaction metadata and binding are inconsistent", () => {
		const commandBinding = {
			algorithm: "hmac-sha256" as const,
			keyId: "0123456789abcdef",
			nonce: "0123456789abcdef0123456789abcdef",
			mac: sha256("synthetic-mac-source"),
		};
		// Applied placeholders without a binding of the original command are rejected.
		expect(() =>
			receipt({
				command: { kind: "argv", executable: "curl", argv: ["--token", "[REDACTED]"] },
				commandRedaction: {
					policyId: "omk-command-redaction-v1",
					placeholders: [{ type: "cli-option-value" as const, count: 1 }],
				},
			}),
		).toThrow(/commandBinding/);
		// A binding without its redaction summary is rejected.
		expect(() => receipt({ commandBinding })).toThrow(/commandRedaction/);
		// Oversize placeholder metadata is rejected at the persistence boundary.
		expect(() =>
			receipt({
				command: { kind: "argv", executable: "curl", argv: ["--token", "[REDACTED]"] },
				commandRedaction: {
					policyId: "omk-command-redaction-v1",
					placeholders: [{ type: "cli-option-value" as const, count: 10_000 }],
				},
				commandBinding,
			}),
		).toThrow(/placeholder/i);
	});

	it("retains legacy metadata behavior only in explicit legacy mode", () => {
		const contract: TaskContract = {
			goalId: "goal-001",
			completionClaim: "dark receipt metadata is ignored",
			requiredEvidence: [
				{
					claim: "legacy evidence",
					category: "feature",
					artifactPath: "dist/result.txt",
					verificationCommand: "node --run test",
					hash: "legacy-nonempty-hash",
					timestamp: "2026-07-15T10:00:02.000Z",
					status: "satisfied",
					receiptId: "receipt-001",
					receiptSchemaVersion: 3,
				},
			],
			finalRisk: "",
			verdict: "pass",
			createdAt: "2026-07-15T10:00:02.000Z",
			updatedAt: "2026-07-15T10:00:02.000Z",
		};
		expect(new EvidenceGate({ receiptMode: "legacy" }).check(contract).status).toBe("open");
		expect(new EvidenceGate().check(contract).status).toBe("conditional");
	});
});
