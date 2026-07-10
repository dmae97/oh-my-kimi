import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getAgentDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi state is loaded lazily; preload so `new MnemopiSessionState(...)` can
// resolve the module synchronously in the fixtures below.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);
interface MemoryFixture {
	cwd: string;
	memoryRoot: string;
	agentDir: string;
	cleanupRoot: string;
}

async function withMemoryFixture(fn: (fixture: MemoryFixture) => Promise<void>): Promise<void> {
	const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-"));
	const previousAgentDir = getAgentDir();
	try {
		const agentDir = path.join(cleanupRoot, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const cwd = path.join(cleanupRoot, "project");
		await fs.mkdir(cwd, { recursive: true });
		setAgentDir(agentDir);
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: {
				sessionManager: {
					getCwd: () => cwd,
					getArtifactsDir: () => null,
					getSessionId: () => "test",
				},
			} as unknown as AgentSession,
			sessionFile: null,
		});
		await fn({ cwd, memoryRoot, agentDir, cleanupRoot });
	} finally {
		setAgentDir(previousAgentDir);
		await removeWithRetries(cleanupRoot);
	}
}

describe("MemoryProtocolHandler", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("resolves memory://root to memory_summary.md", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "summary");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("summary");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("resolves memory://root against the caller cwd when multiple sessions are live", async () => {
		const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-isolation-"));
		const previousAgentDir = getAgentDir();
		try {
			const agentDir = path.join(cleanupRoot, "agent");
			setAgentDir(agentDir);

			const firstCwd = path.join(cleanupRoot, "first-project");
			const secondCwd = path.join(cleanupRoot, "second-project");
			await fs.mkdir(firstCwd, { recursive: true });
			await fs.mkdir(secondCwd, { recursive: true });

			const firstMemoryRoot = getMemoryRoot(agentDir, firstCwd);
			const secondMemoryRoot = getMemoryRoot(agentDir, secondCwd);
			await fs.mkdir(firstMemoryRoot, { recursive: true });
			await fs.mkdir(secondMemoryRoot, { recursive: true });

			const firstSummary = "first registered session summary";
			const secondSummary = "second session cwd summary";
			await Bun.write(path.join(firstMemoryRoot, "memory_summary.md"), firstSummary);
			await Bun.write(path.join(secondMemoryRoot, "memory_summary.md"), secondSummary);

			AgentRegistry.global().register({
				id: "first-session",
				displayName: "first-session",
				kind: "main",
				session: {
					sessionManager: {
						getCwd: () => firstCwd,
						getArtifactsDir: () => null,
						getSessionId: () => "first-session",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});
			AgentRegistry.global().register({
				id: "second-session",
				displayName: "second-session",
				kind: "main",
				session: {
					sessionManager: {
						getCwd: () => secondCwd,
						getArtifactsDir: () => null,
						getSessionId: () => "second-session",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root", { cwd: secondCwd });

			expect(resource.content).toBe(secondSummary);
			expect(resource.content).not.toBe(firstSummary);
		} finally {
			setAgentDir(previousAgentDir);
			await removeWithRetries(cleanupRoot);
		}
	});

	it("resolves memory://root/<path> within memory root", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const skillPath = path.join(memoryRoot, "skills", "demo", "SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await Bun.write(skillPath, "demo skill");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/skills/demo/SKILL.md");

			expect(resource.content).toBe("demo skill");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("throws for unknown memory namespace when no mnemopi backend is active", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://other/memory_summary.md")).rejects.toThrow(
				/Unknown memory namespace: other\. Supported: root/,
			);
		});
	});

	it("blocks path traversal attempts", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/../secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
			await expect(router.resolve("memory://root/%2E%2E/secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
		});
	});

	it("throws clear error for missing files", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/missing.md")).rejects.toThrow(
				"Memory file not found: memory://root/missing.md",
			);
		});
	});

	it("blocks symlink escapes outside memory root", async () => {
		if (process.platform === "win32") return;

		await withMemoryFixture(async ({ memoryRoot, cleanupRoot }) => {
			const outsideDir = path.join(cleanupRoot, "outside");
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.md"), "secret");
			await fs.symlink(outsideDir, path.join(memoryRoot, "linked"));

			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/linked/secret.md")).rejects.toThrow(
				"memory:// URL escapes memory root",
			);
		});
	});
});

interface MnemopiFixture {
	state: MnemopiSessionState;
	dbDir: TempDir;
}

async function withMnemopiSession(
	fn: (fixture: MnemopiFixture) => Promise<void>,
	options: { bank?: string } = {},
): Promise<void> {
	const dbDir = TempDir.createSync(`memory-protocol-mnemopi-${Date.now()}-`);
	const bank = options.bank ?? "test-bank";
	const config = {
		dbPath: dbDir.join("mnemopi.db"),
		bank,
		autoRecall: false,
		autoRetain: false,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			llm: false,
		},
		llmMode: "none" as const,
	} as unknown as ConstructorParameters<typeof MnemopiSessionState>[0]["config"];
	const session = {
		sessionId: "test-mnemopi",
		sessionManager: {
			getEntries: () => [],
			getCwd: () => dbDir.path(),
			getArtifactsDir: () => null,
			getSessionId: () => "test-mnemopi",
		},
		emitNotice: () => {},
		getHindsightSessionState: () => undefined,
	} as unknown as AgentSession;
	const state = new MnemopiSessionState({ sessionId: "test-mnemopi", config, session });
	setMnemopiSessionState(session, state);
	AgentRegistry.global().register({
		id: "test-mnemopi",
		displayName: "test-mnemopi",
		kind: "main",
		session,
		sessionFile: null,
	});
	try {
		await fn({ state, dbDir });
	} finally {
		await state.dispose({ consolidate: false });
		await dbDir.remove();
	}
}

describe("MemoryProtocolHandler — mnemopi bridge (issue #4443)", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("resolves memory://<id> to the full mnemopi memory row", async () => {
		await withMnemopiSession(async ({ state }) => {
			const head = "Decision record: the deploy pipeline uses blue-green cutover. ";
			const body = "Detail sentence about rollout invariants. ".repeat(20);
			const tail = "CRITICAL-TAIL: rollback requires restoring the previous DNS weight map first.";
			const full = `${head}${body}${tail}`;
			const id = state.rememberInScope(full, { importance: 0.9 });
			expect(id).toBeTruthy();

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve(`memory://${id}`);

			expect(resource.contentType).toBe("text/markdown");
			expect(resource.content).toContain("CRITICAL-TAIL");
			expect(resource.content).toContain(`id: ${id}`);
			expect(resource.content).toContain("bank: test-bank");
			expect(resource.content).toContain("store: working");
		});
	});

	it("throws a clear error when the mnemopi id is not stored in any scoped bank", async () => {
		await withMnemopiSession(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://deadbeefdeadbeef")).rejects.toThrow(
				/Mnemopi memory deadbeefdeadbeef not found/,
			);
		});
	});

	it("resolves memory://<fact-id> to a read-only fact row (issue #4725)", async () => {
		await withMnemopiSession(async ({ state }) => {
			const beam = state.memory.beam;
			beam.db
				.prepare(
					"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"0473bbdb8da6df92",
					beam.sessionId,
					"Glab",
					"works-without",
					"mise prefix",
					"2026-07-01T00:00:00.000Z",
					0.9,
				);

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://0473bbdb8da6df92");

			expect(resource.content).toContain("id: 0473bbdb8da6df92");
			expect(resource.content).toContain("store: fact");
			expect(resource.content).toContain("Glab works-without mise prefix");
		});
	});

	it("reports not_editable (not not_found) for memory_edit ops on a fact id (issue #4725)", async () => {
		await withMnemopiSession(async ({ state }) => {
			const beam = state.memory.beam;
			beam.db
				.prepare(
					"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run("fact-readonly", beam.sessionId, "service", "uses", "postgres", "2026-07-01T00:00:00.000Z", 0.9);

			expect(state.editScopedMemory("update", "fact-readonly", { content: "x" })).toMatchObject({
				status: "not_editable",
				store: "fact",
			});
			expect(state.editScopedMemory("forget", "fact-readonly")).toMatchObject({
				status: "not_editable",
				store: "fact",
			});
			expect(state.editScopedMemory("invalidate", "fact-readonly")).toMatchObject({
				status: "not_editable",
				store: "fact",
			});

			// The fact row itself is untouched by the rejected edits.
			expect(beam.db.prepare("SELECT fact_id FROM facts WHERE fact_id = ?").get("fact-readonly")).not.toBeNull();
		});
	});

	it("routes memory://root to the file-backed summary even when mnemopi is active", async () => {
		await withMnemopiSession(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root")).rejects.toThrow(
				"Memory artifacts are not available for this project yet. Run a session with memories enabled first.",
			);
		});
	});
});
