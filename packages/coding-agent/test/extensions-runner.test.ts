/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { filterUserExtensionErrors, filterUserExtensions } from "./utils/filter-user-extensions";

describe("ExtensionRunner", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-runner-test-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const loadTestExtensions = async (configuredPaths: string[] = []) => {
		const result = await discoverAndLoadExtensions(configuredPaths, tempDir.path());
		return {
			...result,
			extensions: filterUserExtensions(result.extensions),
			errors: filterUserExtensionErrors(result.errors),
		};
	};

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"), expect.any(Object));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				export default function(pi) {
					const { Type } = pi.typebox;
					pi.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map(t => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map(c => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("prefers later-loaded explicit extensions for conflicting commands", async () => {
			const deployCommand = (description: string) => `
				export default function(pi) {
					pi.registerCommand("deploy", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;

			fs.writeFileSync(path.join(extensionsDir, "discovered-deploy.ts"), deployCommand("Discovered deploy"));
			const explicitExtensionPath = path.join(tempDir.path(), "explicit-deploy.ts");
			fs.writeFileSync(explicitExtensionPath, deployCommand("Explicit deploy"));

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const commands = runner.getRegisteredCommands();
			expect(commands).toHaveLength(1);
			expect(commands[0]?.description).toBe("Explicit deploy");

			const command = runner.getCommand("deploy");
			expect(command?.description).toBe("Explicit deploy");
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("message renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const flags = runner.getFlags();

			expect(flags.has("--my-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_provider_request chaining", () => {
		it("chains payload replacements across handlers in load order", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext1"] };
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext2"] };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const payload = await runner.emitBeforeProviderRequest({ chain: ["base"] });
			expect(payload).toEqual({ chain: ["base", "ext1", "ext2"] });
		});

		it("keeps chaining after handler errors", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async () => {
						throw new Error("payload failed");
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { preserved?: boolean };
						return { ...payload, preserved: true };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-error.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-ok.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			const payload = await runner.emitBeforeProviderRequest({ original: true });
			expect(payload).toEqual({ original: true, preserved: true });
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("before_provider_request");
			expect(errors[0]?.error).toContain("payload failed");
		});
	});

	describe("after_provider_response", () => {
		it("calls handlers with response metadata and reports handler errors without throwing", async () => {
			const eventsPath = path.join(tempDir.path(), "after-provider-response-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							status: event.status,
							headers: event.headers,
							requestId: event.requestId,
							metadata: event.metadata,
						}) + "\\n",
					);
				});

				pi.on("after_provider_response", async () => {
					throw new Error("response failed");
				});

				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({ afterError: event.status }) + "\\n",
					);
				});
			}
		`;
			fs.writeFileSync(path.join(extensionsDir, "after-provider-response.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			await runner.emitAfterProviderResponse({
				status: 202,
				headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
				requestId: "req_123",
				metadata: { provider: "test" },
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					status: 202,
					headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
					requestId: "req_123",
					metadata: { provider: "test" },
				},
				{ afterError: 202 },
			]);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("after_provider_response");
			expect(errors[0]?.error).toContain("response failed");
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map(item => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("session name API", () => {
		it("lets extensions read and set the session name after initialization", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", async () => {
						if (pi.getSessionName() !== undefined) {
							throw new Error("expected unnamed session");
						}
						await pi.setSessionName("Named by extension");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async name => {
						await sessionManager.setSessionName(name);
					},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => "",
				},
			);

			await runner.emit({ type: "session_start" });

			expect(sessionManager.getSessionName()).toBe("Named by extension");
			expect(sessionManager.getHeader()?.title).toBe("Named by extension");
		});

		it("keeps session naming unavailable during extension load", async () => {
			const extCode = `
				export default function(pi) {
					pi.getSessionName();
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name-load.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const loadError = result.errors.find(error => error.path.includes("session-name-load.ts"));

			expect(loadError).toBeDefined();
			expect(loadError?.error).toContain("Extension runtime not initialized");
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});
});
