import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2115
//
// Large CJK session resumes on Windows legacy console hosts used to feed the
// terminal a full synchronized paint for the entire transcript. ProcessTerminal
// split that payload into ConPTY-sized writes, but the renderer still built a
// multi-megabyte paint and asked the Windows host to process every historical
// row in one DEC 2026 frame. Legacy conhost/ConPTY byte parsing could park the
// viewport mid-conversation, and even ASCII sessions became sluggish once the
// replay crossed ~1-2 MiB.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

class LargeCjkContent implements Component {
	#lines: string[];

	constructor(lineCount: number) {
		this.#lines = [];
		for (let i = 0; i < lineCount; i++) this.appendLine();
	}

	appendLine(): void {
		const i = this.#lines.length;
		this.#lines.push(`第${i.toString().padStart(5, "0")}行：${"界".repeat(80)}`);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = new Array<string>(this.#lines.length);
		for (let i = 0; i < this.#lines.length; i++) {
			rendered[i] = this.#lines[i]!.slice(0, width);
		}
		return rendered;
	}
}

class ManualRenderScheduler implements RenderScheduler {
	#now = 0;
	#immediate: (() => void)[] = [];
	#timers: { at: number; callback: () => void; canceled: boolean }[] = [];

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediate.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { at: this.#now + Math.max(0, delayMs), callback, canceled: false };
		this.#timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}

	async flush(term: VirtualTerminal): Promise<void> {
		while (this.#immediate.length > 0) {
			const callbacks = this.#immediate.splice(0);
			for (const callback of callbacks) callback();
		}
		await term.flush();
	}

	async advanceBy(ms: number, term: VirtualTerminal): Promise<void> {
		await this.flush(term);
		this.#now += ms;
		while (true) {
			const due = this.#timers.filter(timer => !timer.canceled && timer.at <= this.#now);
			if (due.length === 0) break;
			for (const timer of due) {
				timer.canceled = true;
				timer.callback();
			}
			await this.flush(term);
		}
		await this.flush(term);
	}
}

describe("issue #2115: ConPTY large-session resume truncates at logical lines", () => {
	afterEach(() => {
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		vi.restoreAllMocks();
	});

	it("bounds a Windows CJK resume paint while preserving the visible tail", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 12_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		tui.addChild(new LargeCjkContent(9000));

		try {
			tui.start({ clearScrollback: true });
			await term.waitForRender();

			const fullPaint = writes.find(write => write.includes("\x1b[3J"));
			expect(fullPaint).toBeDefined();
			expect(fullPaint).not.toContain("\x1b[2J");
			expect(Buffer.byteLength(fullPaint ?? "", "utf8")).toBeLessThan(128 * 1024);
			expect(fullPaint).toContain("older lines hidden");
			expect(fullPaint).not.toContain("第00000行");

			const viewport = term.getViewport().map(line => line.trimEnd());
			expect(viewport[viewport.length - 1]).toContain("第08999行");
			expect(term.getScrollBuffer().some(line => line.includes("older lines hidden"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("keeps later tail appends on the cheap append path", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const term = new VirtualTerminal(80, 24, 12_000);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const content = new LargeCjkContent(9000);
		const scheduler = new ManualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(content);

		try {
			tui.start({ clearScrollback: true });
			await scheduler.advanceBy(40, term);
			writes.length = 0;

			content.appendLine();
			tui.requestRender();
			await scheduler.advanceBy(200, term);

			const postAppend = writes.join("");
			expect(Buffer.byteLength(postAppend, "utf8")).toBeLessThan(2048);
			expect(postAppend).not.toContain("\x1b[H");
			expect(postAppend).toContain("第09000行");
		} finally {
			tui.stop();
		}
	});
});
