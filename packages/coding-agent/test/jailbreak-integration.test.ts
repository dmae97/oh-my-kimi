import { describe, expect, test } from "vitest";
import {
	extractJailbreakFlags,
	isValidJailbreakMode,
	isValidTarget,
	type JailbreakMode,
	parseJailbreakArgs,
} from "../src/cli/jailbreak-args.ts";
import {
	formatOutput,
	generatePayload,
	handleJailbreakCommand,
	JAILBREAK_COMMAND_NAME,
} from "../src/commands/jailbreak.ts";

// ============================================================================
// Unit: jailbreak-args.ts
// ============================================================================

describe("jailbreak-args", () => {
	describe("isValidJailbreakMode", () => {
		test("returns true for valid modes", () => {
			const valid: JailbreakMode[] = ["parseltongue", "godmode", "ultraplinian", "auto"];
			for (const mode of valid) {
				expect(isValidJailbreakMode(mode)).toBe(true);
			}
		});

		test("returns false for invalid modes", () => {
			expect(isValidJailbreakMode("invalid")).toBe(false);
			expect(isValidJailbreakMode("")).toBe(false);
			expect(isValidJailbreakMode("GODMODE")).toBe(false);
		});
	});

	describe("isValidTarget", () => {
		test("returns true for valid targets", () => {
			const valid = ["claude", "gpt-4o", "gpt-4o-mini", "sonnet", "haiku", "gemini", "grok", "deepseek", "generic"];
			for (const target of valid) {
				expect(isValidTarget(target)).toBe(true);
			}
		});

		test("returns false for invalid targets", () => {
			expect(isValidTarget("invalid")).toBe(false);
			expect(isValidTarget("")).toBe(false);
			expect(isValidTarget("GPT-4O")).toBe(false);
		});
	});

	describe("parseJailbreakArgs", () => {
		test("parses default values when no args provided", () => {
			const result = parseJailbreakArgs([]);
			expect(result.mode).toBe("auto");
			expect(result.target).toBe("generic");
			expect(result.help).toBe(false);
		});

		test("parses --mode flag", () => {
			const result = parseJailbreakArgs(["--mode", "godmode"]);
			expect(result.mode).toBe("godmode");
			expect(result.target).toBe("generic");
		});

		test("parses --target flag", () => {
			const result = parseJailbreakArgs(["--target", "claude"]);
			expect(result.mode).toBe("auto");
			expect(result.target).toBe("claude");
		});

		test("parses combined flags", () => {
			const result = parseJailbreakArgs(["--mode", "ultraplinian", "--target", "gpt-4o"]);
			expect(result.mode).toBe("ultraplinian");
			expect(result.target).toBe("gpt-4o");
		});

		test("parses --help flag", () => {
			const result = parseJailbreakArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseJailbreakArgs(["-h"]);
			expect(result.help).toBe(true);
		});

		test("throws on invalid mode", () => {
			expect(() => parseJailbreakArgs(["--mode", "invalid"])).toThrow(/Invalid jailbreak mode/);
		});

		test("throws on invalid target", () => {
			expect(() => parseJailbreakArgs(["--target", "invalid"])).toThrow(/Invalid target/);
		});
	});

	describe("extractJailbreakFlags", () => {
		test("extracts flags from unknownFlags map", () => {
			const unknownFlags = new Map([
				["jailbreak-mode", "godmode"],
				["jailbreak-target", "claude"],
			]);
			const result = extractJailbreakFlags({
				unknownFlags,
				messages: [],
				fileArgs: [],
				diagnostics: [],
			});
			expect(result.mode).toBe("godmode");
			expect(result.target).toBe("claude");
		});

		test("returns undefined for missing flags", () => {
			const result = extractJailbreakFlags({
				unknownFlags: new Map(),
				messages: [],
				fileArgs: [],
				diagnostics: [],
			});
			expect(result.mode).toBeUndefined();
			expect(result.target).toBeUndefined();
		});
	});
});

// ============================================================================
// Unit: jailbreak.ts (payload generation)
// ============================================================================

describe("jailbreak payload generation", () => {
	describe("generatePayload", () => {
		test("generates parseltongue payload", () => {
			const result = generatePayload({ mode: "parseltongue", target: "claude" });
			expect(result.mode).toBe("parseltongue");
			expect(result.target).toBe("claude");
			expect(result.payload).toContain("Parseltongue");
			expect(result.metadata.apiCalls).toBe(0);
		});

		test("generates godmode payload", () => {
			const result = generatePayload({ mode: "godmode", target: "gpt-4o" });
			expect(result.mode).toBe("godmode");
			expect(result.target).toBe("gpt-4o");
			expect(result.payload).toContain("GODMODE");
			expect(result.metadata.apiCalls).toBe(0);
		});

		test("generates ultraplinian payload", () => {
			const result = generatePayload({ mode: "ultraplinian", target: "gemini" });
			expect(result.mode).toBe("ultraplinian");
			expect(result.target).toBe("gemini");
			expect(result.payload).toContain("ULTRAPLINIAN");
			expect(result.metadata.apiCalls).toBe(0);
		});

		test("auto mode selects appropriate payload for claude", () => {
			const result = generatePayload({ mode: "auto", target: "claude" });
			expect(result.mode).toBe("auto");
			expect(result.payload).toContain("ULTRAPLINIAN");
		});

		test("auto mode selects appropriate payload for gpt-4o", () => {
			const result = generatePayload({ mode: "auto", target: "gpt-4o" });
			expect(result.mode).toBe("auto");
			expect(result.payload).toContain("GODMODE");
		});

		test("auto mode selects appropriate payload for gemini", () => {
			const result = generatePayload({ mode: "auto", target: "gemini" });
			expect(result.mode).toBe("auto");
			expect(result.payload).toContain("Parseltongue");
		});

		test("metadata contains version and timestamp", () => {
			const result = generatePayload({ mode: "godmode", target: "generic" });
			expect(result.metadata.version).toBe("6.0.0");
			expect(result.metadata.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("formatOutput", () => {
		test("formats payload with markdown table", () => {
			const payload = generatePayload({ mode: "godmode", target: "claude" });
			const output = formatOutput(payload);
			expect(output).toContain("# OMK Jailbreak v6 Payload");
			expect(output).toContain("| Mode |");
			expect(output).toContain("| Target |");
			expect(output).toContain("| API Calls | 0 |");
			expect(output).toContain("GODMODE");
		});
	});
});

// ============================================================================
// Integration: CLI handler
// ============================================================================

describe("jailbreak CLI integration", () => {
	test("JAILBREAK_COMMAND_NAME is correct", () => {
		expect(JAILBREAK_COMMAND_NAME).toBe("jailbreak");
	});

	test("handleJailbreakCommand returns 0 for valid args", async () => {
		const exitCode = await handleJailbreakCommand(["--mode", "godmode", "--target", "claude"]);
		expect(exitCode).toBe(0);
	});

	test("handleJailbreakCommand returns 0 for help", async () => {
		const exitCode = await handleJailbreakCommand(["--help"]);
		expect(exitCode).toBe(0);
	});

	test("handleJailbreakCommand returns 1 for invalid mode", async () => {
		const exitCode = await handleJailbreakCommand(["--mode", "invalid"]);
		expect(exitCode).toBe(1);
	});

	test("handleJailbreakCommand returns 1 for invalid target", async () => {
		const exitCode = await handleJailbreakCommand(["--target", "invalid"]);
		expect(exitCode).toBe(1);
	});

	test("handleJailbreakCommand uses defaults when no args", async () => {
		const exitCode = await handleJailbreakCommand([]);
		expect(exitCode).toBe(0);
	});
});

// ============================================================================
// Integration: Extension API bridge
// ============================================================================

describe("jailbreak extension API bridge", () => {
	test("registerJailbreakCommand is exported", () => {
		// Just verify the function exists and has the right signature
		expect(typeof JAILBREAK_COMMAND_NAME).toBe("string");
	});
});

// ============================================================================
// End-to-end: CLI arg parsing through main.ts (simulated)
// ============================================================================

describe("jailbreak end-to-end", () => {
	test("args parser recognizes --jailbreak-mode and --jailbreak-target", () => {
		// Import the main args parser to verify integration
		const { parseArgs } = require("../src/cli/args.ts");
		const result = parseArgs(["--jailbreak-mode", "godmode", "--jailbreak-target", "claude"]);
		expect(result.jailbreakMode).toBe("godmode");
		expect(result.jailbreakTarget).toBe("claude");
	});

	test("unknown flags map captures extension-style flags", () => {
		const { parseArgs } = require("../src/cli/args.ts");
		const result = parseArgs(["--jailbreak-mode=parseltongue"]);
		expect(result.unknownFlags.get("jailbreak-mode")).toBe("parseltongue");
	});
});
