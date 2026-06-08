import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";

interface SessionOverrides {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planMode?: PlanModeState;
}

function makeSession(overrides: SessionOverrides): ToolSession {
	return {
		cwd: overrides.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getPlansDirectory: () => "/plans",
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: () => overrides.planMode,
	} as unknown as ToolSession;
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join("/tmp/agent-artifacts", "local", "handoffs", "result.json"),
		);
	});

	it("falls back to os tmp root when artifacts dir is unavailable", () => {
		const session = makeSession({ artifactsDir: null, sessionId: "session-42" });
		expect(resolvePlanPath(session, "local://memo.txt")).toBe(
			path.join(os.tmpdir(), "omp-local", "session-42", "memo.txt"),
		);
	});
});

describe("resolvePlanPath resolves literally (no plan-mode redirect)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("resolves a bare path against cwd regardless of plan mode", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/repo", "PLAN.md"));
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join("/repo", "src/foo.ts"));
	});

	it("resolves a local:// plan file to the session local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "local://some-plan.md")).toBe(
			path.join("/tmp/agent-artifacts", "local", "some-plan.md"),
		);
	});
});

describe("enforcePlanModeWrite (working tree read-only, local:// sandbox writable)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("accepts writes to any local:// file", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "local://auth-refactor-plan.md", { op: "create" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, "local://scratch/notes.md", { op: "update" })).not.toThrow();
	});

	it("rejects writes to the working tree", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(/working tree is read-only/);
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "create" })).toThrow(/working tree is read-only/);
	});

	it("rejects deletes and renames outright", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { op: "delete" })).toThrow(
			/deleting files is not allowed/,
		);
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { move: "local://renamed.md" })).toThrow(
			/renaming files is not allowed/,
		);
	});

	it("is a no-op when plan mode is disabled", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo" });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).not.toThrow();
	});
});

describe("enforcePlanModeWrite accepts absolute local-sandbox paths", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("allows the absolute path returned by `read local://...` (== sandbox-resolved path)", async () => {
		// Use an existing tmp directory so the realpath check inside the guard
		// sees a real filesystem (macOS collapses /tmp -> /private/tmp etc.).
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const absolute = resolvePlanPath(session, "local://my-plan.md");
		expect(() => enforcePlanModeWrite(session, absolute, { op: "update" })).not.toThrow();
	});

	it("still rejects an absolute path outside the local sandbox", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(() => enforcePlanModeWrite(session, "/repo/src/foo.ts", { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});
});
