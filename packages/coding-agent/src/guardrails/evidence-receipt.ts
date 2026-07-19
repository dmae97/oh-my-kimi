import { createHash, timingSafeEqual } from "node:crypto";
import type {
	CommandHmacBinding,
	CommandRedactionSummary,
	EvidenceCommandDescriptor,
	EvidenceExecutor,
	EvidenceOutputCapture,
	EvidenceReceipt,
	EvidenceReceiptCore,
	EvidenceReceiptCoreFields,
	EvidenceReceiptDisposition,
	EvidenceReceiptEnvelope,
	EvidenceReceiptLedgerBinding,
	EvidenceReceiptReplayPayload,
	Sha256Hex,
	TrustedEvidenceAttestation,
	WorkspaceFingerprint,
} from "../types/evidence.ts";
import {
	assertCredentialFreeEvidenceCommand,
	parseCommandHmacBinding,
	parseCommandRedactionSummary,
	parseEvidenceCommandShape,
} from "./command-redaction.ts";
import { parseWorkspaceFingerprint } from "./workspace-fingerprint.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CORE_DIGEST_DOMAIN = "omk:evidence:receipt-v3:core\0";
const COMMAND_DIGEST_DOMAIN = "omk:evidence:receipt-v3:command\0";
const EXECUTORS: ReadonlySet<string> = new Set(["bash-tool", "ci-runner", "mcp", "internal"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Combined stdout/stderr bytes accepted from an already-redacted caller. */
export const MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES = 64 * 1024;

export interface AlreadyRedactedOutputBytes {
	readonly redactionPolicyId: string;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}

export interface EvidenceReceiptCoreInputFields {
	readonly receiptId: string;
	readonly goalId: string;
	readonly laneId?: string;
	readonly claim: string;
	readonly command: EvidenceCommandDescriptor;
	readonly cwd: string;
	readonly timeoutMs: number | null;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly workspaceBefore: WorkspaceFingerprint;
	readonly workspaceAfter: WorkspaceFingerprint;
	readonly alreadyRedactedOutput: AlreadyRedactedOutputBytes;
	readonly executor: EvidenceExecutor;
	readonly toolCallId?: string;
	readonly commandRedaction?: CommandRedactionSummary;
	readonly commandBinding?: CommandHmacBinding;
}

export type CreateEvidenceReceiptInput = EvidenceReceiptCoreInputFields &
	EvidenceReceiptDisposition & {
		readonly ledgerBinding?: EvidenceReceiptLedgerBinding;
		readonly trustedAttestation?: TrustedEvidenceAttestation;
	};

export interface EvidenceReceiptEnvelopeMetadata {
	readonly ledgerBinding?: EvidenceReceiptLedgerBinding;
	readonly trustedAttestation?: TrustedEvidenceAttestation;
}

export function isSha256Hex(value: unknown): value is Sha256Hex {
	return typeof value === "string" && SHA256_HEX.test(value);
}

export function parseSha256Hex(value: unknown, label = "digest"): Sha256Hex {
	if (!isSha256Hex(value)) {
		throw new Error(`${label} must be exactly 64 lowercase SHA-256 hexadecimal characters`);
	}
	return value;
}

/** Decode validated hex before comparing, avoiding string timing and malformed-buffer pitfalls. */
export function constantTimeSha256Equal(left: unknown, right: unknown): boolean {
	if (!isSha256Hex(left) || !isSha256Hex(right)) return false;
	return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function isSafeEvidenceReceiptId(value: unknown): value is string {
	return typeof value === "string" && SAFE_RECEIPT_ID.test(value);
}

function exactObject(
	value: unknown,
	label: string,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	const record = value as Record<string, unknown>;
	const descriptors = Object.getOwnPropertyDescriptors(record);
	const actual = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key)
		.sort();
	const allowed = new Set([...requiredKeys, ...optionalKeys]);
	const isOwnEnumerableDataProperty = (key: string): boolean => {
		const descriptor = descriptors[key];
		return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
	};
	if (
		actual.some((key) => !allowed.has(key)) ||
		requiredKeys.some((key) => !isOwnEnumerableDataProperty(key)) ||
		optionalKeys.some((key) => key in record && !isOwnEnumerableDataProperty(key))
	) {
		throw new Error(`${label} has an invalid key set`);
	}
	const snapshot: Record<string, unknown> = {};
	for (const key of actual) {
		const descriptor = descriptors[key];
		if (descriptor === undefined || !("value" in descriptor)) {
			throw new Error(`${label} has an invalid key set`);
		}
		snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty string without NUL bytes`);
	}
	return value;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : nonEmptyString(value, label);
}

function safeNonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value as number;
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive safe integer`);
	}
	return value as number;
}

function timestamp(value: unknown, label: string): string {
	const parsed = nonEmptyString(value, label);
	if (!ISO_TIMESTAMP.test(parsed) || Number.isNaN(Date.parse(parsed))) {
		throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
	}
	return parsed;
}

/** Strict structural parse plus the credential-free policy for persisted commands. */
function parseCommand(value: unknown): EvidenceCommandDescriptor {
	const command = parseEvidenceCommandShape(value);
	assertCredentialFreeEvidenceCommand(command);
	return command;
}

function parseOutputDigest(value: unknown, label: string): EvidenceOutputCapture["stdout"] {
	const raw = exactObject(value, label, ["sha256", "byteCount"]);
	return Object.freeze({
		sha256: parseSha256Hex(raw.sha256, `${label}.sha256`),
		byteCount: safeNonNegativeInteger(raw.byteCount, `${label}.byteCount`),
	});
}

function parseOutput(value: unknown): EvidenceOutputCapture {
	const raw = exactObject(value, "receipt output", ["redactionPolicyId", "stdout", "stderr"]);
	const redactionPolicyId = nonEmptyString(raw.redactionPolicyId, "receipt output redactionPolicyId");
	if (redactionPolicyId.length > 256) {
		throw new Error("receipt output redactionPolicyId is too long");
	}
	const stdout = parseOutputDigest(raw.stdout, "receipt stdout");
	const stderr = parseOutputDigest(raw.stderr, "receipt stderr");
	if (stdout.byteCount + stderr.byteCount > MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES) {
		throw new Error(`receipt output exceeds ${MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES} bytes`);
	}
	return Object.freeze({ redactionPolicyId, stdout, stderr });
}

function parseDisposition(status: unknown, exitCode: unknown): EvidenceReceiptDisposition {
	if (status === "passed") {
		if (exitCode !== 0) throw new Error("passed receipt status requires exitCode 0");
		return Object.freeze({ status, exitCode: 0 });
	}
	if (status === "failed") {
		if (!Number.isSafeInteger(exitCode) || exitCode === 0) {
			throw new Error("failed receipt status requires a non-zero integer exitCode");
		}
		return Object.freeze({ status, exitCode: exitCode as number });
	}
	if (status === "timeout" || status === "aborted") {
		if (exitCode !== null) throw new Error(`${status} receipt status requires a null exitCode`);
		return Object.freeze({ status, exitCode: null });
	}
	throw new Error("receipt status must be passed, failed, timeout, or aborted");
}

/** Strict shape parser for immutable receipt core data. */
export function parseEvidenceReceiptCore(value: unknown): EvidenceReceiptCore {
	const raw = exactObject(
		value,
		"receipt core",
		[
			"schemaVersion",
			"receiptId",
			"goalId",
			"claim",
			"command",
			"cwd",
			"timeoutMs",
			"startedAt",
			"finishedAt",
			"durationMs",
			"status",
			"exitCode",
			"workspaceBefore",
			"workspaceAfter",
			"output",
			"executor",
		],
		["laneId", "toolCallId", "commandRedaction", "commandBinding"],
	);
	if (raw.schemaVersion !== 3) throw new Error("receipt core schemaVersion must be 3");
	if (!isSafeEvidenceReceiptId(raw.receiptId)) throw new Error("receiptId is not safe");
	const goalId = nonEmptyString(raw.goalId, "receipt core goalId");
	const laneId = optionalNonEmptyString(raw.laneId, "receipt core laneId");
	const claim = nonEmptyString(raw.claim, "receipt core claim");
	const command = parseCommand(raw.command);
	const cwd = nonEmptyString(raw.cwd, "receipt core cwd");
	const timeoutMs = raw.timeoutMs === null ? null : positiveInteger(raw.timeoutMs, "receipt core timeoutMs");
	const startedAt = timestamp(raw.startedAt, "receipt core startedAt");
	const finishedAt = timestamp(raw.finishedAt, "receipt core finishedAt");
	if (Date.parse(finishedAt) < Date.parse(startedAt)) {
		throw new Error("receipt core finishedAt must not precede startedAt");
	}
	const durationMs = safeNonNegativeInteger(raw.durationMs, "receipt core durationMs");
	if (durationMs !== Date.parse(finishedAt) - Date.parse(startedAt)) {
		throw new Error("receipt core durationMs must match the timestamp interval");
	}
	const workspaceBefore = parseWorkspaceFingerprint(raw.workspaceBefore);
	const workspaceAfter = parseWorkspaceFingerprint(raw.workspaceAfter);
	const output = parseOutput(raw.output);
	if (typeof raw.executor !== "string" || !EXECUTORS.has(raw.executor)) {
		throw new Error("receipt core executor is invalid");
	}
	const executor = raw.executor as EvidenceExecutor;
	const toolCallId = optionalNonEmptyString(raw.toolCallId, "receipt core toolCallId");
	const commandRedaction =
		raw.commandRedaction === undefined ? undefined : parseCommandRedactionSummary(raw.commandRedaction);
	const commandBinding = raw.commandBinding === undefined ? undefined : parseCommandHmacBinding(raw.commandBinding);
	if (commandBinding !== undefined && commandRedaction === undefined) {
		throw new Error("receipt core commandBinding requires commandRedaction");
	}
	if (commandRedaction !== undefined && commandRedaction.placeholders.length > 0 && commandBinding === undefined) {
		throw new Error("receipt core commandRedaction with applied placeholders requires commandBinding");
	}
	const disposition = parseDisposition(raw.status, raw.exitCode);
	const fields: EvidenceReceiptCoreFields = {
		schemaVersion: 3,
		receiptId: raw.receiptId,
		goalId,
		...(laneId !== undefined ? { laneId } : {}),
		claim,
		command,
		cwd,
		timeoutMs,
		startedAt,
		finishedAt,
		durationMs,
		workspaceBefore,
		workspaceAfter,
		output,
		executor,
		...(toolCallId !== undefined ? { toolCallId } : {}),
		...(commandRedaction !== undefined ? { commandRedaction } : {}),
		...(commandBinding !== undefined ? { commandBinding } : {}),
	};
	return Object.freeze({ ...fields, ...disposition });
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0))
			throw new Error("canonical JSON requires finite non-negative-zero numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (typeof value !== "object" || value === null) throw new Error("value is not canonical JSON data");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function serializeEvidenceReceiptCore(core: EvidenceReceiptCore): string {
	return canonicalJson(parseEvidenceReceiptCore(core));
}

/** Domain-separated SHA-256 of one exact, credential-free structured command descriptor. */
export function computeEvidenceCommandSha256(command: EvidenceCommandDescriptor): Sha256Hex {
	return createHash("sha256")
		.update(COMMAND_DIGEST_DOMAIN, "utf8")
		.update(canonicalJson(parseCommand(command)), "utf8")
		.digest("hex") as Sha256Hex;
}

/** Domain-separated SHA-256 of the immutable canonical core only. */
export function computeEvidenceReceiptCoreSha256(core: EvidenceReceiptCore): Sha256Hex {
	return createHash("sha256")
		.update(CORE_DIGEST_DOMAIN, "utf8")
		.update(serializeEvidenceReceiptCore(core), "utf8")
		.digest("hex") as Sha256Hex;
}

function parseLedgerBinding(value: unknown): EvidenceReceiptLedgerBinding {
	const raw = exactObject(value, "receipt ledger binding", ["seq", "eventHash"]);
	return Object.freeze({
		seq: positiveInteger(raw.seq, "receipt ledger seq"),
		eventHash: parseSha256Hex(raw.eventHash, "receipt ledger eventHash"),
	});
}

function parseTrustedAttestation(value: unknown): TrustedEvidenceAttestation {
	const raw = exactObject(value, "trusted attestation", ["attesterId", "keyId", "algorithm", "signature", "issuedAt"]);
	if (raw.algorithm !== "ed25519") throw new Error("trusted attestation algorithm must be ed25519");
	return Object.freeze({
		attesterId: nonEmptyString(raw.attesterId, "trusted attestation attesterId"),
		keyId: nonEmptyString(raw.keyId, "trusted attestation keyId"),
		algorithm: "ed25519",
		signature: nonEmptyString(raw.signature, "trusted attestation signature"),
		issuedAt: timestamp(raw.issuedAt, "trusted attestation issuedAt"),
	});
}

function parseEnvelope(value: unknown): EvidenceReceiptEnvelope {
	const raw = exactObject(value, "receipt envelope", ["coreSha256"], ["ledgerBinding", "trustedAttestation"]);
	const coreSha256 = parseSha256Hex(raw.coreSha256, "receipt envelope coreSha256");
	const ledgerBinding = raw.ledgerBinding === undefined ? undefined : parseLedgerBinding(raw.ledgerBinding);
	const trustedAttestation =
		raw.trustedAttestation === undefined ? undefined : parseTrustedAttestation(raw.trustedAttestation);
	return Object.freeze({
		coreSha256,
		...(ledgerBinding !== undefined ? { ledgerBinding } : {}),
		...(trustedAttestation !== undefined ? { trustedAttestation } : {}),
	});
}

/** Strict shape and digest validation for an already-decoded receipt value. */
export function validateEvidenceReceipt(value: unknown): EvidenceReceipt {
	const raw = exactObject(value, "evidence receipt", ["core", "envelope"]);
	const core = parseEvidenceReceiptCore(raw.core);
	const envelope = parseEnvelope(raw.envelope);
	const expected = computeEvidenceReceiptCoreSha256(core);
	if (!constantTimeSha256Equal(expected, envelope.coreSha256)) {
		throw new Error("evidence receipt core digest mismatch");
	}
	return Object.freeze({ core, envelope });
}

export function parseEvidenceReceipt(serialized: string): EvidenceReceipt {
	if (typeof serialized !== "string") throw new Error("serialized evidence receipt must be a string");
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("evidence receipt contains invalid JSON");
	}
	return validateEvidenceReceipt(value);
}

export function serializeEvidenceReceipt(receipt: EvidenceReceipt): string {
	return canonicalJson(validateEvidenceReceipt(receipt));
}

export function verifyEvidenceReceiptCoreDigest(receipt: EvidenceReceipt): boolean {
	try {
		const validated = validateEvidenceReceipt(receipt);
		return constantTimeSha256Equal(computeEvidenceReceiptCoreSha256(validated.core), validated.envelope.coreSha256);
	} catch {
		return false;
	}
}

function assertByteArray(value: unknown, label: string): asserts value is Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error(`${label} must be a Uint8Array of already-redacted bytes`);
}

function outputCapture(output: AlreadyRedactedOutputBytes): EvidenceOutputCapture {
	if (typeof output !== "object" || output === null || Array.isArray(output)) {
		throw new Error("alreadyRedactedOutput must be an object");
	}
	const redactionPolicyId = nonEmptyString(output.redactionPolicyId, "redaction policy id");
	if (redactionPolicyId.length > 256) throw new Error("redaction policy id is too long");
	assertByteArray(output.stdout, "already-redacted stdout");
	assertByteArray(output.stderr, "already-redacted stderr");
	const byteCount = output.stdout.byteLength + output.stderr.byteLength;
	if (!Number.isSafeInteger(byteCount) || byteCount > MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES) {
		throw new Error(`receipt output exceeds ${MAX_EVIDENCE_RECEIPT_OUTPUT_BYTES} bytes`);
	}
	return Object.freeze({
		redactionPolicyId,
		stdout: Object.freeze({
			sha256: createHash("sha256").update(output.stdout).digest("hex") as Sha256Hex,
			byteCount: output.stdout.byteLength,
		}),
		stderr: Object.freeze({
			sha256: createHash("sha256").update(output.stderr).digest("hex") as Sha256Hex,
			byteCount: output.stderr.byteLength,
		}),
	});
}

/** Build a receipt from caller-supplied execution facts without executing a command or activating a gate. */
export function createEvidenceReceipt(input: CreateEvidenceReceiptInput): EvidenceReceipt {
	const output = outputCapture(input.alreadyRedactedOutput);
	const core = parseEvidenceReceiptCore({
		schemaVersion: 3,
		receiptId: input.receiptId,
		goalId: input.goalId,
		...(input.laneId !== undefined ? { laneId: input.laneId } : {}),
		claim: input.claim,
		command: input.command,
		cwd: input.cwd,
		timeoutMs: input.timeoutMs,
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		durationMs: input.durationMs,
		status: input.status,
		exitCode: input.exitCode,
		workspaceBefore: input.workspaceBefore,
		workspaceAfter: input.workspaceAfter,
		output,
		executor: input.executor,
		...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
		...(input.commandRedaction !== undefined ? { commandRedaction: input.commandRedaction } : {}),
		...(input.commandBinding !== undefined ? { commandBinding: input.commandBinding } : {}),
	});
	const envelope: EvidenceReceiptEnvelope = {
		coreSha256: computeEvidenceReceiptCoreSha256(core),
		...(input.ledgerBinding !== undefined ? { ledgerBinding: input.ledgerBinding } : {}),
		...(input.trustedAttestation !== undefined ? { trustedAttestation: input.trustedAttestation } : {}),
	};
	return validateEvidenceReceipt({ core, envelope });
}

/** Attach non-core metadata after a ledger commits {receiptId, coreSha256}. */
export function withEvidenceReceiptEnvelope(
	receipt: EvidenceReceipt,
	metadata: EvidenceReceiptEnvelopeMetadata,
): EvidenceReceipt {
	const validated = validateEvidenceReceipt(receipt);
	return validateEvidenceReceipt({
		core: validated.core,
		envelope: {
			coreSha256: validated.envelope.coreSha256,
			...(metadata.ledgerBinding !== undefined ? { ledgerBinding: metadata.ledgerBinding } : {}),
			...(metadata.trustedAttestation !== undefined ? { trustedAttestation: metadata.trustedAttestation } : {}),
		},
	});
}

export function evidenceReceiptReplayPayload(receipt: EvidenceReceipt): EvidenceReceiptReplayPayload {
	const validated = validateEvidenceReceipt(receipt);
	return Object.freeze({
		receiptId: validated.core.receiptId,
		coreSha256: validated.envelope.coreSha256,
	});
}
