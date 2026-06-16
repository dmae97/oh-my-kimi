import { beforeAll, describe, it } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

describe("hub probe", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("dumps rendered rows", () => {
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40 });
		Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => 120 });
		const agents = new AgentRegistry();
		const sess = {} as AgentSession;
		for (const letter of ["A", "B", "C", "D", "E"]) {
			const id = `Repro${letter}`;
			agents.register({
				id,
				displayName: `Advisor delivery bug reproducer (independent track ${letter})`,
				kind: "sub",
				parentId: id, // self-parent, mimicking the bug
				session: sess,
				status: "running",
			});
		}
		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc: new IrcBus(agents),
			focusAgent: async () => {},
		});
		const lines = hub.render(120).map(l => Bun.stripANSI(l));
		console.error("===HUB RENDER START===");
		for (const l of lines) console.error(JSON.stringify(l));
		console.error("===HUB RENDER END===");
		hub.dispose();
	});
});
