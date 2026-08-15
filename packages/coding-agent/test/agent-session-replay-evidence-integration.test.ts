import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "omk-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { EvidenceReceiptStore } from "../src/guardrails/evidence-receipt-store.ts";
import { EvidenceGate, ReplayLedgerManager, TaskContractBuilder } from "../src/guardrails/evidence-system.ts";
import { VerifiedEvidenceExecutor } from "../src/guardrails/verified-executor.ts";

const GOAL_ID = "goal-late-write";
const LANE_ID = "lane-runtime";
const CLAIM = "workspace verification passed";
const SESSION_SECRET = "private-session-message-must-not-enter-replay";
const TOOL_RESULT_SECRET = "private-tool-result-must-not-enter-replay";

describe("AgentSession ReplayLedger evidence freshness bridge", () => {
	let root: string;
	let cwd: string;

	beforeEach(() => {
		root = join(tmpdir(), `omk-replay-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(root, "workspace");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "artifact.txt"), "stable\n");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("persists default CLI-composed timeout evidence without copying session bodies", async () => {
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("deploy_writer", {}, { id: "call-default-late" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(root, "agent"),
			authStorage,
			settingsManager: SettingsManager.inMemory({ agent: { toolTimeouts: { deploy_writer: 20 } } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
			customTools: [
				{
					name: "deploy_writer",
					label: "deploy_writer",
					description: "settles after timeout",
					parameters: Type.Object({}),
					async execute() {
						await new Promise((resolve) => setTimeout(resolve, 80));
						return { content: [{ type: "text" as const, text: TOOL_RESULT_SECRET }], details: {} };
					},
				},
			],
		});

		await session.prompt(SESSION_SECRET);
		await new Promise((resolve) => setTimeout(resolve, 140));

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const replayPath = `${sessionFile}.replay.jsonl`;
		const replayText = readFileSync(replayPath, "utf8");
		const events = new ReplayLedgerManager(sessionManager.getSessionId(), replayPath).getEvents();
		expect(events.map((event) => event.type)).toEqual(["tool_timeout", "tool_late_settlement", "workspace_mutation"]);
		expect(events.every((event) => event.goalId === sessionManager.getSessionId())).toBe(true);
		expect(replayText).not.toContain(SESSION_SECRET);
		expect(replayText).not.toContain(TOOL_RESULT_SECRET);
		session.dispose();
	});

	it("blocks a receipt predating a late write mutation and accepts a later receipt through the same gate resolver", async () => {
		const ledger = new ReplayLedgerManager(GOAL_ID, join(root, "ledger.jsonl"));
		const executor = new VerifiedEvidenceExecutor({
			store: new EvidenceReceiptStore(join(root, "receipts")),
			ledger,
		});
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("deploy_writer", {}, { id: "call-late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(root, "agent"),
			authStorage,
			settingsManager: SettingsManager.inMemory({ agent: { toolTimeouts: { deploy_writer: 20 } } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(cwd, join(root, "sessions")),
			model: faux.getModel(),
			replayLedger: ledger,
			replayGoalId: GOAL_ID,
			replayLaneId: LANE_ID,
			customTools: [
				{
					name: "deploy_writer",
					label: "deploy_writer",
					description: "settles after timeout",
					parameters: Type.Object({}),
					async execute() {
						await new Promise((resolve) => setTimeout(resolve, 80));
						return { content: [{ type: "text" as const, text: "late" }], details: {} };
					},
				},
			],
		});

		const verify = async (receiptId: string) =>
			executor.execute({
				goalId: GOAL_ID,
				laneId: LANE_ID,
				claim: CLAIM,
				command: { kind: "argv", executable: "node", argv: ["--check", "artifact.txt"] },
				cwd,
				timeoutMs: 1_000,
				workspaceScope: { root: cwd, artifactPaths: ["artifact.txt"] },
				executor: "internal",
				execute: async () => ({
					status: "passed",
					exitCode: 0,
					alreadyRedactedOutput: {
						redactionPolicyId: "test-v1",
						stdout: Buffer.from(`${receiptId}\n`),
						stderr: Buffer.alloc(0),
					},
				}),
			});
		const contractFor = (metadata: Awaited<ReturnType<typeof verify>>["evidenceMetadata"]) =>
			new TaskContractBuilder(GOAL_ID)
				.setClaim(CLAIM)
				.addRequiredEvidence({
					claim: CLAIM,
					category: "feature",
					receiptId: metadata.receiptId,
					receiptSchemaVersion: metadata.receiptSchemaVersion,
					receiptCommandSha256: metadata.receiptCommandSha256,
					receiptLaneId: metadata.receiptLaneId,
				})
				.updateEvidenceStatus(CLAIM, "satisfied")
				.setVerdict("pass")
				.build();
		const gate = new EvidenceGate({ receiptMode: "strict", ...executor.createGateOptions() });

		const before = await verify("before");
		expect(gate.check(contractFor(before.evidenceMetadata)).status).toBe("open");

		await session.prompt(SESSION_SECRET);
		await new Promise((resolve) => setTimeout(resolve, 140));

		expect(session.lastTermination?.kind).toBe("tool_timeout");
		const replayEvents = ledger.getEvents();
		expect(replayEvents.map((event) => event.type)).toEqual([
			"evidence_receipt",
			"tool_timeout",
			"tool_late_settlement",
			"workspace_mutation",
		]);
		expect(replayEvents.every((event) => event.goalId === GOAL_ID && event.laneId === LANE_ID)).toBe(true);
		expect(JSON.stringify(replayEvents)).not.toContain(SESSION_SECRET);
		expect(gate.check(contractFor(before.evidenceMetadata))).toMatchObject({ status: "blocked" });

		const after = await verify("after");
		expect(gate.check(contractFor(after.evidenceMetadata)).status).toBe("open");
		session.dispose();
	});

	it("binds default executeBash through the verified adapter when a replay ledger exists", async () => {
		const previous = process.env.OMK_VERIFIED_BASH;
		delete process.env.OMK_VERIFIED_BASH;
		try {
			const faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("ready")]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(root, "agent-default-bash"),
				authStorage,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const sessionManager = SessionManager.create(cwd, join(root, "sessions-default-bash"));
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
			});

			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("verified-default-path\n"));
					return { exitCode: 0 };
				},
			};
			const result = await session.executeBash("printf verified", undefined, { operations });
			expect(result.output).toContain("verified-default-path");
			expect(result.exitCode).toBe(0);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");
			const replayPath = `${sessionFile}.replay.jsonl`;
			const events = new ReplayLedgerManager(sessionManager.getSessionId(), replayPath).getEvents();
			expect(events.some((event) => event.type === "evidence_receipt")).toBe(true);

			const receiptRoot = join(`${sessionFile}.evidence`, "receipts");
			expect(existsSync(receiptRoot)).toBe(true);
			expect(readdirSync(receiptRoot).length).toBeGreaterThan(0);
			session.dispose();
		} finally {
			if (previous === undefined) delete process.env.OMK_VERIFIED_BASH;
			else process.env.OMK_VERIFIED_BASH = previous;
		}
	});

	it("keeps executeBash unverified when OMK_VERIFIED_BASH=0", async () => {
		const previous = process.env.OMK_VERIFIED_BASH;
		process.env.OMK_VERIFIED_BASH = "0";
		try {
			const faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("ready")]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(root, "agent-optout-bash"),
				authStorage,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const sessionManager = SessionManager.create(cwd, join(root, "sessions-optout-bash"));
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
			});

			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onData(Buffer.from("legacy-path\n"));
					return { exitCode: 0 };
				},
			};
			const result = await session.executeBash("printf legacy", undefined, { operations });
			expect(result.output).toContain("legacy-path");

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");
			const replayPath = `${sessionFile}.replay.jsonl`;
			// Ledger/store dirs may exist from session construction; no receipt events or files.
			if (existsSync(replayPath)) {
				const events = new ReplayLedgerManager(sessionManager.getSessionId(), replayPath).getEvents();
				expect(events.some((event) => event.type === "evidence_receipt")).toBe(false);
			}
			const receiptRoot = join(`${sessionFile}.evidence`, "receipts");
			if (existsSync(receiptRoot)) {
				expect(readdirSync(receiptRoot)).toEqual([]);
			}
			session.dispose();
		} finally {
			if (previous === undefined) delete process.env.OMK_VERIFIED_BASH;
			else process.env.OMK_VERIFIED_BASH = previous;
		}
	});

	it("records sandbox_audit decisions in explicit audit mode", async () => {
		const prevSandbox = process.env.OMK_BASH_SANDBOX;
		const prevVerified = process.env.OMK_VERIFIED_BASH;
		process.env.OMK_BASH_SANDBOX = "audit";
		delete process.env.OMK_VERIFIED_BASH;
		try {
			const faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("ready")]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(root, "agent-sandbox-audit"),
				authStorage,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const sessionManager = SessionManager.create(cwd, join(root, "sessions-sandbox-audit"));
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
			});

			const result = await session.executeBash("true");
			expect(result.exitCode).toBe(0);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");
			const replayPath = `${sessionFile}.replay.jsonl`;
			const audited = new ReplayLedgerManager(sessionManager.getSessionId(), replayPath)
				.getEvents()
				.filter((event) => event.type === "sandbox_audit");
			expect(audited.length).toBeGreaterThan(0);
			expect(JSON.stringify(audited[audited.length - 1]?.payload)).toContain("audit_fallback");
			session.dispose();
		} finally {
			if (prevSandbox === undefined) delete process.env.OMK_BASH_SANDBOX;
			else process.env.OMK_BASH_SANDBOX = prevSandbox;
			if (prevVerified === undefined) delete process.env.OMK_VERIFIED_BASH;
			else process.env.OMK_VERIFIED_BASH = prevVerified;
		}
	});

	it("skips sandbox_audit when OMK_BASH_SANDBOX=0", async () => {
		const prevSandbox = process.env.OMK_BASH_SANDBOX;
		process.env.OMK_BASH_SANDBOX = "0";
		try {
			const faux = registerFauxProvider();
			faux.setResponses([fauxAssistantMessage("ready")]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(root, "agent-sandbox-off"),
				authStorage,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const sessionManager = SessionManager.create(cwd, join(root, "sessions-sandbox-off"));
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
			});

			const result = await session.executeBash("true");
			expect(result.exitCode).toBe(0);

			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");
			const replayPath = `${sessionFile}.replay.jsonl`;
			const sandboxEvents = new ReplayLedgerManager(sessionManager.getSessionId(), replayPath)
				.getEvents()
				.filter((event) => event.type === "sandbox_audit");
			expect(sandboxEvents).toEqual([]);
			session.dispose();
		} finally {
			if (prevSandbox === undefined) delete process.env.OMK_BASH_SANDBOX;
			else process.env.OMK_BASH_SANDBOX = prevSandbox;
		}
	});
});
