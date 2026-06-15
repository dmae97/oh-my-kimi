import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	formatMCPConnectingMessage,
	MCP_CONNECTING_EVENT_CHANNEL,
	type McpConnectingEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Behavioral wiring guard for the MCP connecting banner (mirrors
 * interactive-mode-lsp-startup.test.ts). The fix routes the banner through the
 * render tree instead of `process.stderr.write`: sdk emits on
 * `MCP_CONNECTING_EVENT_CHANNEL` and InteractiveMode's constructor subscribes,
 * rendering via `showStatus`. The shared-module contract test pins the channel
 * string and formatter; this pins the live subscriber — dropping the
 * `eventBus.on(...)` registration or diverging the channel would silently kill
 * the banner with no type error, and this case would fail.
 */
describe("InteractiveMode MCP connecting banner", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from probing the real terminal; the test
		// only drives the event bus and spies on showStatus.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-mcp-connecting-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", undefined, () => {}, [], undefined, eventBus);
		// This contract is the banner wiring, not git branch watching; a real
		// fs.watch in a parallel Bun worker can trip an unrelated-worker SIGTRAP.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("routes a mcp:connecting event through the constructor-registered subscriber, before init()", () => {
		// The subscription is registered in the InteractiveMode constructor, so the
		// banner routes BEFORE init()/any async startup. Emitting here — with no
		// init() — pins that race-sensitive invariant: the real sdk emit is gated
		// behind async MCP config loading (loadAllMCPConfigs), so a constructor-time
		// subscriber always wins. Stub showStatus so no initialized UI is needed.
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

		const serverNames = ["sequential", "critic", "shannon"];
		eventBus.emit(MCP_CONNECTING_EVENT_CHANNEL, { serverNames } satisfies McpConnectingEvent);

		// A dropped subscription or a channel divergence would leave showStatus
		// uncalled; a revert to raw stderr.write would never reach showStatus either.
		expect(showStatusSpy).toHaveBeenCalledWith(formatMCPConnectingMessage(serverNames));
	});

	it("does not render the mcp:connecting status when startup.quiet is enabled", () => {
		session.settings.set("startup.quiet", true);
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTING_EVENT_CHANNEL, {
			serverNames: ["sequential", "critic"],
		} satisfies McpConnectingEvent);

		expect(showStatusSpy).not.toHaveBeenCalled();
	});

	it("rejects a malformed mcp:connecting payload via the guard instead of letting it throw", () => {
		const showStatusSpy = vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		// The EventBus swallows handler throws into logger.error, so the discriminator
		// is: with the guard the handler returns early (logger.warn, no error); without
		// it the cast reaches formatMCPConnectingMessage(undefined) and throws a
		// TypeError the bus catches as logger.error.
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		eventBus.emit(MCP_CONNECTING_EVENT_CHANNEL, { wrong: "shape" });

		expect(showStatusSpy).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled(); // guard took the reject branch
		expect(errorSpy).not.toHaveBeenCalled(); // no swallowed TypeError from a bad cast
	});
});
