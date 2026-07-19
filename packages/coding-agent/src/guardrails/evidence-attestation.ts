import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
	CommandHmacBinding,
	CommandRedactionSummary,
	EvidenceCommandDescriptor,
	ReplayEvent,
	ReplayLedgerHead,
	Sha256Hex,
	VerifiedReplayLedgerSnapshot,
	WorkspaceFingerprint,
	WorkspaceScope,
} from "../types/evidence.ts";
import { parseWorkspaceFingerprint } from "./workspace-fingerprint.ts";

const COMMAND_HMAC_DOMAIN = "omk:evidence:receipt-v3:command-hmac\0";
const KEY_ID_HEX = /^[0-9a-f]{16}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;
const MAC_HEX = /^[0-9a-f]{64}$/;

function canonicalCommandPayload(command: EvidenceCommandDescriptor): string {
	if (command.kind === "argv") {
		if (
			typeof command.executable !== "string" ||
			command.executable.length === 0 ||
			!Array.isArray(command.argv) ||
			command.argv.some((value) => typeof value !== "string" || value.includes("\0"))
		) {
			throw new Error("invalid argv command attestation input");
		}
		return JSON.stringify(["argv", command.executable, ...command.argv]);
	}
	if (
		command.kind !== "shell" ||
		typeof command.shell !== "string" ||
		command.shell.length === 0 ||
		typeof command.script !== "string" ||
		command.script.length === 0 ||
		command.shell.includes("\0") ||
		command.script.includes("\0")
	) {
		throw new Error("invalid shell command attestation input");
	}
	return JSON.stringify(["shell", command.shell, command.script]);
}

function validBinding(binding: CommandHmacBinding): boolean {
	return (
		binding?.algorithm === "hmac-sha256" &&
		KEY_ID_HEX.test(binding.keyId) &&
		NONCE_HEX.test(binding.nonce) &&
		MAC_HEX.test(binding.mac)
	);
}

export interface CommandHmacBinder {
	readonly keyId: string;
	bind(command: EvidenceCommandDescriptor): CommandHmacBinding;
	verify(command: EvidenceCommandDescriptor, binding: CommandHmacBinding): boolean;
}

/** Ephemeral keyed attestation binder. Key bytes never leave this closure. */
export function createCommandHmacBinder(): CommandHmacBinder {
	const key = randomBytes(32);
	const keyId = randomBytes(8).toString("hex");
	const compute = (nonce: string, payload: string): Buffer =>
		createHmac("sha256", key).update(COMMAND_HMAC_DOMAIN).update(nonce).update(payload).digest();
	return Object.freeze({
		keyId,
		bind(command: EvidenceCommandDescriptor): CommandHmacBinding {
			const nonce = randomBytes(16).toString("hex");
			return Object.freeze({
				algorithm: "hmac-sha256" as const,
				keyId,
				nonce,
				mac: compute(nonce, canonicalCommandPayload(command)).toString("hex") as Sha256Hex,
			});
		},
		verify(command: EvidenceCommandDescriptor, binding: CommandHmacBinding): boolean {
			try {
				if (!validBinding(binding) || binding.keyId !== keyId) return false;
				return timingSafeEqual(
					compute(binding.nonce, canonicalCommandPayload(command)),
					Buffer.from(binding.mac, "hex"),
				);
			} catch {
				return false;
			}
		},
	});
}

const processCommandHmacBinder = createCommandHmacBinder();

/** Compatibility binder for callers that do not need later strict verification. */
export function bindEvidenceCommandHmac(command: EvidenceCommandDescriptor): CommandHmacBinding {
	return processCommandHmacBinder.bind(command);
}

export interface TrustBindingIssue {
	readonly detail: string;
	readonly hard: boolean;
}

const COMMAND_ISSUES = {
	missing: { detail: "is missing", hard: false },
	verifier: { detail: "verifier is missing", hard: false },
	invalid: { detail: "is invalid", hard: true },
	redaction: { detail: "does not match its redaction", hard: true },
} as const satisfies Record<string, TrustBindingIssue>;

export function verifyCommandAttestation(input: {
	readonly receiptId: string;
	readonly binding: CommandHmacBinding | undefined;
	readonly persistedCommand: EvidenceCommandDescriptor;
	readonly persistedSummary: CommandRedactionSummary | undefined;
	readonly binder: Pick<CommandHmacBinder, "verify"> | undefined;
	readonly resolveCommand: ((receiptId: string) => EvidenceCommandDescriptor | undefined) | undefined;
	readonly redact: (command: EvidenceCommandDescriptor) => {
		readonly command: EvidenceCommandDescriptor;
		readonly summary: CommandRedactionSummary;
	};
}): TrustBindingIssue | undefined {
	if (input.binding === undefined) return COMMAND_ISSUES.missing;
	if (!input.binder || !input.resolveCommand) return COMMAND_ISSUES.verifier;
	try {
		const command = input.resolveCommand(input.receiptId);
		if (command === undefined || !input.binder.verify(command, input.binding)) return COMMAND_ISSUES.invalid;
		const redacted = input.redact(command);
		return JSON.stringify(redacted.command) === JSON.stringify(input.persistedCommand) &&
			JSON.stringify(redacted.summary) === JSON.stringify(input.persistedSummary)
			? undefined
			: COMMAND_ISSUES.redaction;
	} catch {
		return COMMAND_ISSUES.invalid;
	}
}

function workspaceMutationOutOfScope(payload: unknown, scope: WorkspaceScope): boolean {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
	const record = payload as Record<string, unknown>;
	if (record.root !== scope.root || !Array.isArray(record.paths) || record.paths.length === 0) return false;
	return record.paths.every(
		(path) =>
			typeof path === "string" &&
			path.length > 0 &&
			scope.artifactPaths.every(
				(artifact) => path !== artifact && !path.startsWith(`${artifact}/`) && !artifact.startsWith(`${path}/`),
			),
	);
}

export function latestRelevantWorkspaceMutationSeq(
	events: readonly ReplayEvent[],
	scope: WorkspaceScope,
): number | null {
	let latest: number | null = null;
	for (const event of events) {
		if (event.type === "workspace_mutation" && !workspaceMutationOutOfScope(event.payload, scope)) latest = event.seq;
	}
	return latest;
}

export function verifyWorkspaceBinding(
	expected: WorkspaceFingerprint,
	capture: ((scope: WorkspaceFingerprint["scope"]) => unknown) | undefined,
): TrustBindingIssue | undefined {
	if (!capture) return { detail: "freshness binding is missing", hard: false };
	try {
		const current = parseWorkspaceFingerprint(capture(expected.scope));
		if (current.kind !== expected.kind) return { detail: "workspace kind changed after verification", hard: true };
		return safeDigestEqual(current.manifestSha256, expected.manifestSha256)
			? undefined
			: { detail: "artifact-changed-after-verification", hard: true };
	} catch {
		return { detail: "freshness check failed", hard: true };
	}
}

export function parseVerifiedLedgerSnapshot(
	value: unknown,
	goalId: string,
	parseEvents: (bytes: Buffer, goalId: string) => ReplayEvent[],
): VerifiedReplayLedgerSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("snapshot is invalid");
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.events) || typeof record.head !== "object" || record.head === null) {
		throw new Error("snapshot fields are invalid");
	}
	const serialized = record.events.map((event) => JSON.stringify(event)).join("\n");
	const events = parseEvents(Buffer.from(serialized + (serialized ? "\n" : "")), goalId);
	const head = record.head as Record<string, unknown>;
	const last = events.at(-1);
	if (
		!Number.isSafeInteger(head.size) ||
		(head.size as number) < 0 ||
		head.lastSeq !== (last?.seq ?? 0) ||
		head.lastHash !== (last?.eventHash ?? "genesis") ||
		(last !== undefined && (typeof head.fileIdentity !== "object" || head.fileIdentity === null))
	) {
		throw new Error("snapshot committed head is invalid");
	}
	return structuredClone({
		events,
		head: {
			fileIdentity: head.fileIdentity as ReplayLedgerHead["fileIdentity"],
			size: head.size as number,
			lastSeq: head.lastSeq as number,
			lastHash: head.lastHash as string,
		},
	});
}

function safeDigestEqual(left: unknown, right: unknown): boolean {
	return (
		typeof left === "string" &&
		typeof right === "string" &&
		/^[0-9a-f]{64}$/.test(left) &&
		/^[0-9a-f]{64}$/.test(right) &&
		timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
	);
}

export function replayPayloadMatches(payload: unknown, receiptId: string, coreSha256: string): boolean {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
	const descriptors = Object.getOwnPropertyDescriptors(payload);
	const keys = Object.entries(descriptors)
		.filter(([, value]) => value.enumerable)
		.map(([key]) => key)
		.sort();
	const id = descriptors.receiptId;
	const digest = descriptors.coreSha256;
	return (
		keys.join(",") === "coreSha256,receiptId" &&
		id !== undefined &&
		"value" in id &&
		id.value === receiptId &&
		digest !== undefined &&
		"value" in digest &&
		safeDigestEqual(digest.value, coreSha256)
	);
}
