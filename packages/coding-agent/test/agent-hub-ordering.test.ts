/**
 * Regression: the agent hub row order must be stable while the hub is open.
 *
 * The hub is sorted by lastActivity on first open, but after that keyboard
 * selection must not jump around as agents heartbeat or update activity. New
 * agents that appear while the hub is open are appended at the end.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface GeometryStub {
	setRows(n: number): void;
	restore(): void;
}

function stubStdoutGeometry(cols: number): GeometryStub {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function makeHub(agents: AgentRegistry) {
	return new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
}

function renderedAgentIds(hub: AgentHubOverlayComponent): string[] {
	return hub
		.render(120)
		.map(line => Bun.stripANSI(line))
		.map(line => line.split(" · "))
		.filter(
			parts =>
				parts.length >= 4 && ["running", "idle", "parked", "aborted"].some(status => parts[0].endsWith(status)),
		)
		.map(parts => parts[1]!);
}

describe("Agent hub row ordering", () => {
	let geometry: GeometryStub | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		geometry?.restore();
		geometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("freezes the initial lastActivity order while the hub is open", () => {
		geometry = stubStdoutGeometry(120);
		const now = vi.spyOn(Date, "now");
		const agents = new AgentRegistry();
		const sessions = new Map<string, AgentSession>();

		now.mockReturnValue(1000);
		const sessionA = {} as AgentSession;
		sessions.set("A", sessionA);
		agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: sessionA });

		now.mockReturnValue(2000);
		const sessionB = {} as AgentSession;
		sessions.set("B", sessionB);
		agents.register({ id: "B", displayName: "Beta", kind: "sub", session: sessionB });

		now.mockReturnValue(3000);
		const sessionC = {} as AgentSession;
		sessions.set("C", sessionC);
		agents.register({ id: "C", displayName: "Gamma", kind: "sub", session: sessionC });

		const hub = makeHub(agents);
		expect(renderedAgentIds(hub)).toEqual(["C", "B", "A"]);

		// Bump A's lastActivity far ahead of the others. The hub is already open,
		// so the captured order must not change.
		now.mockReturnValue(4000);
		agents.setActivity("A", "still running");

		// Force a refresh by registering a new agent; the existing rows must stay put.
		now.mockReturnValue(5000);
		const sessionD = {} as AgentSession;
		agents.register({ id: "D", displayName: "Delta", kind: "sub", session: sessionD });

		expect(renderedAgentIds(hub)).toEqual(["C", "B", "A", "D"]);

		hub.dispose();
	});
});
