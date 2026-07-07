import { afterAll, afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { ArtifactManager } from "../../session/artifacts";
import { AgentProtocolHandler } from "../agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../registry-helpers";

const tempDir = TempDir.createSync("omp-nested-agent-repro-");
afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await fs.writeFile(path.join(midOwnArtifactsDir, `${grandchildId}.md`), "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});
