import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolCall } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

describe("browser tool schema", () => {
	it("rejects run calls without code at schema validation", () => {
		const session: ToolSession = {
			cwd: "/tmp/test",
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new BrowserTool(session);
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-run-without-code",
			name: "browser",
			arguments: { action: "run", name: "x" },
		};

		expect(validateJsonSchemaValue(toolWireSchema(tool), call.arguments).success).toBe(false);
		expect(() => validateToolCall([tool], call)).toThrow(/Validation failed for tool "browser"[\s\S]*code/);
	});

	it("accepts run calls with code at schema validation", () => {
		const session: ToolSession = {
			cwd: "/tmp/test",
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new BrowserTool(session);
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-run-with-code",
			name: "browser",
			arguments: { action: "run", name: "x", code: "return document.title;" },
		};

		expect(validateJsonSchemaValue(toolWireSchema(tool), call.arguments).success).toBe(true);
		expect(validateToolCall([tool], call)).toEqual(call.arguments);
	});

	it("keeps intent tracing satisfiable across action variants", () => {
		const session: ToolSession = {
			cwd: "/tmp/test",
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const normalized = normalizeTools([new BrowserTool(session)], true)?.[0];
		const schema = normalized?.parameters;

		expect(validateJsonSchemaValue(schema, { action: "run", name: "x" }).success).toBe(false);
		expect(
			validateJsonSchemaValue(schema, {
				[INTENT_FIELD]: "Inspecting page state",
				action: "run",
				name: "x",
				code: "return document.title;",
			}).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(schema, {
				[INTENT_FIELD]: "Opening docs tab",
				action: "open",
				name: "docs",
				url: "https://example.com",
			}).success,
		).toBe(true);
	});
});
