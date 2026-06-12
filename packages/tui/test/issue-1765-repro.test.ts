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
	text = "cursor target";

	invalidate(): void {}

	render(): string[] {
		if (!this.focused) return [this.text];
		return [`${this.text.slice(0, this.cursorIndex)}${CURSOR_MARKER}${this.text.slice(this.cursorIndex)}`];
	}
}

// VirtualTerminal does not model DECRQM capability probing, so subclass it to
// register and replay the renderer's mode-2026 report callback on demand. This
// exercises the runtime probe path in `TUI.start()` end-to-end.
class ProbingTerminal extends VirtualTerminal {
	#privateModeCallbacks: Array<(mode: number, supported: boolean) => void> = [];

	onPrivateModeReport(callback: (mode: number, supported: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
	}

	emitPrivateModeReport(mode: number, supported: boolean): void {
		for (const callback of this.#privateModeCallbacks) callback(mode, supported);
	}
}

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	const realHideCursor = term.hideCursor.bind(term);
	const realShowCursor = term.showCursor.bind(term);
	(term as { write: (data: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	(term as { hideCursor: () => void }).hideCursor = () => {
		writes.push("\x1b[?25l");
		realHideCursor();
	};
	(term as { showCursor: () => void }).showCursor = () => {
		writes.push("\x1b[?25h");
		realShowCursor();
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

				writes.length = 0;
				tui.requestRender();
				await term.waitForRender();

				expect(writes).toEqual([]);
			} finally {
				tui.stop();
			}
		});
	});

	it("honors the PI_TUI_SYNC_OUTPUT=0 disable alias", async () => {
		await withEnvPatch(
			{ PI_NO_SYNC_OUTPUT: undefined, PI_FORCE_SYNC_OUTPUT: undefined, PI_TUI_SYNC_OUTPUT: "0" },
			async () => {
				const term = new VirtualTerminal(32, 4, 100);
				const writes = captureWrites(term);
				const tui = new TUI(term);
				tui.addChild(new MutableLines(["disabled sync"]));

				try {
					tui.start();
					await term.waitForRender();

					expectNoSyncOutput(writes);
				} finally {
					tui.stop();
				}
			},
		);
	});

	it("keeps synchronized output available behind an explicit force flag", async () => {
		await withEnvPatch({ PI_NO_SYNC_OUTPUT: undefined, PI_FORCE_SYNC_OUTPUT: "1" }, async () => {
			const term = new VirtualTerminal(32, 4, 100);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new MutableLines(["forced sync"]));

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

describe("cursor no-op renders", () => {
	it("skips standalone cursor writes when row, column, and visibility are unchanged", async () => {
		const term = new VirtualTerminal(32, 4, 100);
		const component = new FocusedLine();
		const tui = new TUI(term, true);
		tui.addChild(component);
		tui.setFocus(component);

		try {
			tui.start();
			await term.waitForRender();
			expect(term.getCursor()).toEqual({ row: 0, col: 0 });

			const writes = captureWrites(term);
			tui.requestRender();
			await term.waitForRender();

			expect(writes).toEqual([]);
			expect(term.getCursor()).toEqual({ row: 0, col: 0 });
		} finally {
			tui.stop();
		}
	});

	it("writes once when only the cursor column changes, then skips the next identical noop", async () => {
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

			expect(writes.join("")).toContain("\x1b[7G");
			expect(term.getCursor()).toEqual({ row: 0, col: 6 });

			writes.length = 0;
			tui.requestRender();
			await term.waitForRender();

			expect(writes).toEqual([]);
			expect(term.getCursor()).toEqual({ row: 0, col: 6 });
		} finally {
			tui.stop();
		}
	});

	it("hides the hardware cursor once when the marker disappears, then skips repeated hides", async () => {
		const term = new VirtualTerminal(32, 4, 100);
		const component = new FocusedLine();
		const tui = new TUI(term, true);
		tui.addChild(component);
		tui.setFocus(component);

		try {
			tui.start();
			await term.waitForRender();

			const writes = captureWrites(term);
			tui.setFocus(null);
			tui.requestRender();
			await term.waitForRender();

			expect(writes.join("")).toContain("\x1b[?25l");

			writes.length = 0;
			tui.requestRender();
			await term.waitForRender();

			expect(writes).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("records cursor state from content-changing renders before the next noop", async () => {
		const term = new VirtualTerminal(32, 4, 100);
		const component = new FocusedLine();
		const tui = new TUI(term, true);
		tui.addChild(component);
		tui.setFocus(component);

		try {
			tui.start();
			await term.waitForRender();

			component.text = "cursor target updated";
			component.cursorIndex = 8;
			tui.requestRender();
			await term.waitForRender();
			expect(term.getCursor()).toEqual({ row: 0, col: 8 });

			const writes = captureWrites(term);
			tui.requestRender();
			await term.waitForRender();

			expect(writes).toEqual([]);
			expect(term.getCursor()).toEqual({ row: 0, col: 8 });
		} finally {
			tui.stop();
		}
	});
});

describe("synchronized-output runtime DECRQM probe", () => {
	it("enables synchronized output after a positive DEC 2026 report on a default-off host", async () => {
		// TMUX forces the static default off; the positive probe must upgrade it.
		await withEnvPatch(
			{
				TMUX: "1",
				WT_SESSION: undefined,
				TERM_FEATURES: undefined,
				PI_NO_SYNC_OUTPUT: undefined,
				PI_FORCE_SYNC_OUTPUT: undefined,
				PI_TUI_SYNC_OUTPUT: undefined,
			},
			async () => {
				const term = new ProbingTerminal(32, 4, 100);
				const writes = captureWrites(term);
				const component = new MutableLines(["before probe"]);
				const tui = new TUI(term);
				tui.addChild(component);

				try {
					tui.start();
					await term.waitForRender();
					expect(tui.synchronizedOutput).toBe(false);
					expectNoSyncOutput(writes);

					const mark = writes.length;
					term.emitPrivateModeReport(2026, true);
					expect(tui.synchronizedOutput).toBe(true);

					component.lines = ["after probe"];
					tui.requestRender();
					await term.waitForRender();

					const after = writes.slice(mark).join("");
					expect(after).toContain(SYNC_BEGIN);
					expect(after).toContain(SYNC_END);
				} finally {
					tui.stop();
				}
			},
		);
	});

	it("disables synchronized output after a negative DEC 2026 report on a default-on host", async () => {
		// WT_SESSION forces the static default on without a user override flag.
		await withEnvPatch(
			{
				WT_SESSION: "abc",
				PI_NO_SYNC_OUTPUT: undefined,
				PI_FORCE_SYNC_OUTPUT: undefined,
				PI_TUI_SYNC_OUTPUT: undefined,
			},
			async () => {
				const term = new ProbingTerminal(32, 4, 100);
				const writes = captureWrites(term);
				const component = new MutableLines(["before probe"]);
				const tui = new TUI(term);
				tui.addChild(component);

				try {
					tui.start();
					await term.waitForRender();
					expect(tui.synchronizedOutput).toBe(true);

					const mark = writes.length;
					term.emitPrivateModeReport(2026, false);
					expect(tui.synchronizedOutput).toBe(false);

					component.lines = ["after probe"];
					tui.requestRender();
					await term.waitForRender();

					expectNoSyncOutput(writes.slice(mark));
				} finally {
					tui.stop();
				}
			},
		);
	});

	it("ignores a positive probe when the user opted out", async () => {
		await withEnvPatch(
			{ PI_NO_SYNC_OUTPUT: "1", PI_FORCE_SYNC_OUTPUT: undefined, PI_TUI_SYNC_OUTPUT: undefined },
			async () => {
				const term = new ProbingTerminal(32, 4, 100);
				const writes = captureWrites(term);
				const component = new MutableLines(["before probe"]);
				const tui = new TUI(term);
				tui.addChild(component);

				try {
					tui.start();
					await term.waitForRender();
					expect(tui.synchronizedOutput).toBe(false);

					const mark = writes.length;
					term.emitPrivateModeReport(2026, true);
					expect(tui.synchronizedOutput).toBe(false);

					component.lines = ["after probe"];
					tui.requestRender();
					await term.waitForRender();

					expectNoSyncOutput(writes.slice(mark));
				} finally {
					tui.stop();
				}
			},
		);
	});

	it("ignores a negative probe when the user forced sync on", async () => {
		await withEnvPatch(
			{ PI_FORCE_SYNC_OUTPUT: "1", PI_NO_SYNC_OUTPUT: undefined, PI_TUI_SYNC_OUTPUT: undefined },
			async () => {
				const term = new ProbingTerminal(32, 4, 100);
				const writes = captureWrites(term);
				const component = new MutableLines(["before probe"]);
				const tui = new TUI(term);
				tui.addChild(component);

				try {
					tui.start();
					await term.waitForRender();
					expect(tui.synchronizedOutput).toBe(true);

					const mark = writes.length;
					term.emitPrivateModeReport(2026, false);
					expect(tui.synchronizedOutput).toBe(true);

					component.lines = ["after probe"];
					tui.requestRender();
					await term.waitForRender();

					const after = writes.slice(mark).join("");
					expect(after).toContain(SYNC_BEGIN);
					expect(after).toContain(SYNC_END);
				} finally {
					tui.stop();
				}
			},
		);
	});
});
