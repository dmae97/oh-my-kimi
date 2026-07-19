import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "omk-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
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
});
