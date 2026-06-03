import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/1765
//
// Some terminals either do not implement DEC 2026 synchronized output or have
// implementations that make redraws visually worse. VTE 0.68, for example,
// knows private mode 2026 but reports it as permanently reset. The opt-out must
// remove only the DEC 2026 begin/end markers; paint writes still disable
// autowrap so exact-width rows cannot latch pending-wrap state and staircase the
// next cursor move.

class MutableLines implements Component {
	constructor(public lines: string[]) {}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

class FocusedLine implements Component, Focusable {
	focused = true;
	cursorIndex = 0;

	invalidate(): void {}

	render(): string[] {
		const text = "cursor target";
		return [`${text.slice(0, this.cursorIndex)}${CURSOR_MARKER}${text.slice(this.cursorIndex)}`];
	}
}

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as { write: (data: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const bunSnapshot: Record<string, string | undefined> = {};
	const processSnapshot: Record<string, string | undefined> = {};
	for (const key in patch) {
		bunSnapshot[key] = Bun.env[key];
		processSnapshot[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
			delete process.env[key];
		} else {
			Bun.env[key] = value;
			process.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in patch) {
			const bunValue = bunSnapshot[key];
			if (bunValue === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = bunValue;
			}
			const processValue = processSnapshot[key];
			if (processValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = processValue;
			}
		}
	}
}

function expectNoSyncOutput(writes: readonly string[]): void {
	const output = writes.join("");
	expect(output).not.toContain(SYNC_BEGIN);
	expect(output).not.toContain(SYNC_END);
}

describe("issue #1765: synchronized-output opt-out", () => {
	it("omits DEC 2026 paint wrappers while preserving autowrap guards", async () => {
		await withEnvPatch({ PI_NO_SYNC_OUTPUT: "1", VTE_VERSION: "6800" }, async () => {
			const term = new VirtualTerminal(32, 4, 100);
			const writes = captureWrites(term);
			const component = new MutableLines(["row 0", "row 1"]);
			const tui = new TUI(term);
			tui.addChild(component);

			try {
				tui.start();
				await term.waitForRender();

				component.lines = ["row 0", "row 1 updated", "row 2"];
				tui.requestRender();
				await term.waitForRender();

				const output = writes.join("");
				expectNoSyncOutput(writes);
				expect(output).toContain(DISABLE_AUTOWRAP);
				expect(output).toContain(ENABLE_AUTOWRAP);
				expect(
					term
						.getViewport()
						.map(line => line.trimEnd())
						.slice(0, 3),
				).toEqual(["row 0", "row 1 updated", "row 2"]);
			} finally {
				tui.stop();
			}
		});
	});

	it("applies the opt-out to standalone cursor-position writes", async () => {
		await withEnvPatch({ PI_NO_SYNC_OUTPUT: "1" }, async () => {
			const term = new VirtualTerminal(32, 4, 100);
			const component = new FocusedLine();
			const tui = new TUI(term, true);
			tui.addChild(component);
			tui.setFocus(component);

			try {
				tui.start();
				await term.waitForRender();
				const writes = captureWrites(term);

				component.cursorIndex = 6;
				tui.requestRender();
				await term.waitForRender();

				expectNoSyncOutput(writes);
				expect(writes.join("")).toContain("\x1b[7G");
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps synchronized output enabled by default", async () => {
		await withEnvPatch({ PI_NO_SYNC_OUTPUT: undefined }, async () => {
			const term = new VirtualTerminal(32, 4, 100);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new MutableLines(["default sync"]));

			try {
				tui.start();
				await term.waitForRender();

				const output = writes.join("");
				expect(output).toContain(SYNC_BEGIN);
				expect(output).toContain(SYNC_END);
			} finally {
				tui.stop();
			}
		});
	});
});
