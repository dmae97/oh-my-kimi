import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression for issue #5305: image-gen is registered as a custom tool, and
// custom tools are force-activated regardless of the `toolNames` filter. Before
// the fix, `generate_image` survived `--no-tools` (an empty `toolNames`), any
// explicit whitelist that omitted it, and had no `generate_image.enabled`
// settings toggle. The SDK must honor the whitelist and the new setting.
describe("generate_image tool gating", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-generate-image-gating-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function activeToolNames(settings: Settings, toolNames?: string[]): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames,
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("excludes generate_image from a restricted tool whitelist", async () => {
		const names = await activeToolNames(Settings.isolated({}), ["read"]);
		expect(names).toContain("read");
		expect(names).not.toContain("generate_image");
	});

	it("excludes generate_image under --no-tools (empty whitelist)", async () => {
		const names = await activeToolNames(Settings.isolated({}), []);
		expect(names).not.toContain("generate_image");
	});

	it("respects generate_image.enabled=false even when requested", async () => {
		const names = await activeToolNames(Settings.isolated({ "generate_image.enabled": false }), [
			"read",
			"generate_image",
		]);
		expect(names).not.toContain("generate_image");
	});

	it("includes generate_image when explicitly requested and enabled", async () => {
		const names = await activeToolNames(Settings.isolated({}), ["read", "generate_image"]);
		expect(names).toContain("generate_image");
	});
});
