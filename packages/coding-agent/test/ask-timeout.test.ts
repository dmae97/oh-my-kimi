import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { AskTool, type AskToolDetails } from "../src/tools/ask";

type AskExecutionResult = AgentToolResult<AskToolDetails>;

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createAskTool(): AskTool {
	return new AskTool({
		hasUI: true,
		settings: {
			get(key: string): unknown {
				if (key === "ask.timeout") return 0.01;
				if (key === "ask.notify") return "off";
				if (key === "speech.enabled") return false;
				return undefined;
			},
		},
		getPlanModeState: () => ({ enabled: false }),
	} as unknown as ToolSession);
}

describe("AskTool timeout", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("auto-selects the recommended option when the selector does not settle", async () => {
		vi.useFakeTimers();
		const select = vi.fn(() => new Promise<string | undefined>(() => {}));
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});
});
