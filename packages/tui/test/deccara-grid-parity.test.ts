import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { performance } from "node:perf_hooks";
import { applyBackgroundToLine, type Component, setTerminalDeccara, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const BG_OPEN = "\x1b[48;2;10;20;30m";

class PanelComponent implements Component {
	#rows: string[];
	#bg: boolean[];
	constructor(rows: string[], bg: boolean[]) {
		this.#rows = [...rows];
		this.#bg = [...bg];
	}
	set(rows: string[], bg: boolean[]): void {
		this.#rows = [...rows];
		this.#bg = [...bg];
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#rows.map((row, i) =>
			this.#bg[i] ? applyBackgroundToLine(row, width, t => `${BG_OPEN}${t}\x1b[49m`) : row,
		);
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const t = Promise.withResolvers<void>();
	process.nextTick(t.resolve);
	await t.promise;
	await Bun.sleep(1);
	await term.flush();
}

// ---- Minimal DECCARA-aware grid simulator -------------------------------
// Tracks per-cell background only (the optimizer's whole job). Background is a
// normalized SGR param string, or "" for default. Implements the escape subset
// the renderer emits, including DECSACE rect-mode + DECCARA $r rectangle fills,
// with background-color-erase (bce) semantics on ED/EL/scroll.
function normBg(prev: string, params: string): string {
	if (params.length === 0) return "";
	const t = params.split(";");
	let r = prev;
	for (let i = 0; i < t.length; i++) {
		const n = t[i].length === 0 ? 0 : Number(t[i]);
		if (!Number.isInteger(n)) return r; // ignore unknowns
		if (n === 0 || n === 49) r = "";
		else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) r = t[i];
		else if (n === 48) {
			if (t[i + 1] === "5") {
				r = `48;5;${t[i + 2]}`;
				i += 2;
			} else if (t[i + 1] === "2") {
				r = `48;2;${t[i + 2]};${t[i + 3]};${t[i + 4]}`;
				i += 4;
			}
		} else if (n === 38) {
			if (t[i + 1] === "5") i += 2;
			else if (t[i + 1] === "2") i += 4;
		}
	}
	return r;
}

class Grid {
	w: number;
	h: number;
	bg: string[][];
	row = 0;
	col = 0;
	curBg = "";
	wrapPending = false;
	constructor(w: number, h: number) {
		this.w = w;
		this.h = h;
		this.bg = Array.from({ length: h }, () => new Array(w).fill(""));
	}
	#scrollUp(): void {
		this.bg.shift();
		this.bg.push(new Array(this.w).fill(this.curBg));
	}
	#nl(): void {
		this.wrapPending = false;
		if (this.row >= this.h - 1) this.#scrollUp();
		else this.row++;
	}
	#put(): void {
		if (this.wrapPending) {
			this.col = 0;
			this.#nl();
		}
		if (this.col < this.w) this.bg[this.row][this.col] = this.curBg;
		if (this.col >= this.w - 1) this.wrapPending = true;
		else this.col++;
	}
	#erase(r: number, c0: number, c1: number): void {
		for (let c = c0; c <= c1 && c < this.w; c++) this.bg[r][c] = this.curBg;
	}
	write(s: string): void {
		let i = 0;
		while (i < s.length) {
			const code = s.charCodeAt(i);
			if (code === 0x1b) {
				const n = s[i + 1];
				if (n === "[") {
					let j = i + 2;
					while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
					const fin = s[j];
					// Strip trailing intermediates (0x20-0x2f), e.g. '$' in DECCARA ($r)
					// and '*' in DECSACE (*x), so the param list is clean.
					let bodyEnd = j;
					while (bodyEnd > i + 2 && s.charCodeAt(bodyEnd - 1) >= 0x20 && s.charCodeAt(bodyEnd - 1) <= 0x2f)
						bodyEnd--;
					const inter = s.slice(bodyEnd, j);
					const body = s.slice(i + 2, bodyEnd);
					this.#csi(body, inter + fin);
					i = j + 1;
					continue;
				}
				if (n === "]") {
					// OSC ... BEL or ST
					let j = i + 2;
					while (j < s.length && s.charCodeAt(j) !== 0x07 && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
					i = s.charCodeAt(j) === 0x07 ? j + 1 : j + 2;
					continue;
				}
				if (n === "P" || n === "X" || n === "^" || n === "_") {
					let j = i + 2;
					while (j < s.length && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
					i = j + 2;
					continue;
				}
				i += 2;
				continue;
			}
			if (code === 0x0d) {
				this.col = 0;
				this.wrapPending = false;
				i++;
				continue;
			}
			if (code === 0x0a) {
				this.#nl();
				i++;
				continue;
			}
			// printable
			this.#put();
			i++;
		}
	}
	#csi(body: string, fin: string): void {
		const ps = body.startsWith("?") ? body.slice(1) : body;
		const args = ps.split(";");
		const a0 = args[0]?.length ? Number(args[0]) : undefined;
		switch (fin) {
			case "m":
				this.curBg = normBg(this.curBg, body);
				return;
			case "H":
			case "f": {
				const r = (args[0]?.length ? Number(args[0]) : 1) - 1;
				const c = (args[1]?.length ? Number(args[1]) : 1) - 1;
				this.row = Math.max(0, Math.min(this.h - 1, r));
				this.col = Math.max(0, Math.min(this.w - 1, c));
				this.wrapPending = false;
				return;
			}
			case "A":
				this.row = Math.max(0, this.row - (a0 ?? 1));
				this.wrapPending = false;
				return;
			case "B":
				this.row = Math.min(this.h - 1, this.row + (a0 ?? 1));
				this.wrapPending = false;
				return;
			case "C":
				this.col = Math.min(this.w - 1, this.col + (a0 ?? 1));
				this.wrapPending = false;
				return;
			case "D":
				this.col = Math.max(0, this.col - (a0 ?? 1));
				this.wrapPending = false;
				return;
			case "G":
				this.col = Math.max(0, Math.min(this.w - 1, (a0 ?? 1) - 1));
				this.wrapPending = false;
				return;
			case "K": {
				const mode = a0 ?? 0;
				if (mode === 0) this.#erase(this.row, this.col, this.w - 1);
				else if (mode === 1) this.#erase(this.row, 0, this.col);
				else this.#erase(this.row, 0, this.w - 1);
				return;
			}
			case "J": {
				const mode = a0 ?? 0;
				if (mode === 2 || mode === 3 || mode === 22) {
					for (let r = 0; r < this.h; r++) this.#erase(r, 0, this.w - 1);
				} else if (mode === 0) {
					this.#erase(this.row, this.col, this.w - 1);
					for (let r = this.row + 1; r < this.h; r++) this.#erase(r, 0, this.w - 1);
				} else if (mode === 1) {
					for (let r = 0; r < this.row; r++) this.#erase(r, 0, this.w - 1);
					this.#erase(this.row, 0, this.col);
				}
				return;
			}
			case "*x":
				return; // DECSACE extent: renderer always wraps $r in rect mode
			case "$r": {
				// DECCARA: Pt;Pl;Pb;Pr; <sgr...>
				const top = (args[0]?.length ? Number(args[0]) : 1) - 1;
				const left = (args[1]?.length ? Number(args[1]) : 1) - 1;
				const bot = (args[2]?.length ? Number(args[2]) : this.h) - 1;
				const right = (args[3]?.length ? Number(args[3]) : this.w) - 1;
				const sgr = args.slice(4).join(";");
				for (let r = Math.max(0, top); r <= Math.min(this.h - 1, bot); r++) {
					for (let c = Math.max(0, left); c <= Math.min(this.w - 1, right); c++) {
						this.bg[r][c] = normBg(this.bg[r][c], sgr);
					}
				}
				return;
			}
			default:
				return; // ignore h/l/t/etc.
		}
	}
	dump(): string {
		return this.bg.map(r => r.map(c => (c === "" ? "." : "#")).join("")).join("\n");
	}
}

function captureBytes(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const real = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((d: string) => {
		writes.push(d);
		real(d);
	});
	return writes;
}

describe("DECCARA visible-fill parity (simulated grid)", () => {
	beforeEach(() => {
		let m = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			m += 20;
			return m;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function runScenario(
		deccara: boolean,
		w: number,
		h: number,
		frames: { rows: string[]; bg: boolean[] }[],
	): Promise<Grid> {
		const saved = TERMINAL.deccara;
		setTerminalDeccara(deccara);
		const term = new VirtualTerminal(w, h);
		const tui = new TUI(term);
		const panel = new PanelComponent(frames[0].rows, frames[0].bg);
		tui.addChild(panel);
		const grid = new Grid(w, h);
		const bytes = captureBytes(term);
		try {
			tui.start();
			await settle(term);
			for (let f = 1; f < frames.length; f++) {
				panel.set(frames[f].rows, frames[f].bg);
				tui.requestRender();
				await settle(term);
			}
			for (const b of bytes) grid.write(b);
			return grid;
		} finally {
			tui.stop();
			setTerminalDeccara(saved);
		}
	}

	const scenarios: { name: string; w: number; h: number; frames: { rows: string[]; bg: boolean[] }[] }[] = [
		{
			// Regression: a diff that grows the buffer past the viewport scrolls the
			// terminal, so the rewritten rows settle one row higher than where they
			// were first painted. The absolute DECCARA rectangles must follow the
			// post-scroll rows (and the row scrolled into history must keep its full
			// background padding). Pre-fix, the bg fills landed one row too low.
			name: "diff grows past viewport, scrolling a bg fill row (regression)",
			w: 20,
			h: 4,
			frames: [
				{ rows: ["x", "y"], bg: [false, false] },
				{ rows: ["X", "y", "z", "", ""], bg: [false, false, false, true, true] },
			],
		},
		{
			name: "short content + 2-row input box, then spinner diff",
			w: 40,
			h: 12,
			frames: [
				{
					rows: ["Hi! What can I help you with today?", "", "can you ping google", "", "", "", "Working"],
					bg: [false, false, false, false, true, true, false],
				},
				{
					rows: ["Hi! What can I help you with today?", "", "can you ping google", "", "", "", "Working."],
					bg: [false, false, false, false, true, true, false],
				},
			],
		},
		{
			name: "blank panel filling viewport",
			w: 40,
			h: 8,
			frames: [{ rows: ["", "", "", ""], bg: [true, true, true, true] }],
		},
		{
			name: "content taller than viewport (scroll)",
			w: 40,
			h: 8,
			frames: [
				{
					rows: Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? "" : `line ${i}`)),
					bg: Array.from({ length: 12 }, () => true),
				},
			],
		},
		{
			name: "in-place single-row change among bg rows",
			w: 40,
			h: 8,
			frames: [
				{ rows: ["AAA", "BBB", "CCC", "DDD"], bg: [true, true, true, true] },
				{ rows: ["AAA", "BBB", "XXX", "DDD"], bg: [true, true, true, true] },
			],
		},
		{
			name: "streaming insert above input box (content < height)",
			w: 40,
			h: 14,
			frames: [
				{
					rows: ["msg one", "", "can you ping google", "", "", "", "Working"],
					bg: [false, false, false, false, true, true, false],
				},
				{
					rows: ["msg one", "", "can you ping google", "", "Pinging", "", "", "", "Working"],
					bg: [false, false, false, false, false, false, true, true, false],
				},
				{
					rows: ["msg one", "", "can you ping google", "", "Pinging google", "now", "", "", "", "Working."],
					bg: [false, false, false, false, false, false, false, true, true, false],
				},
				{
					rows: ["msg one", "", "can you ping google", "", "Pinging google", "now done", "", "", "", "Working.."],
					bg: [false, false, false, false, false, false, false, true, true, false],
				},
			],
		},
		{
			name: "streaming insert above input box (content > height, scroll)",
			w: 40,
			h: 8,
			frames: [
				{ rows: ["a", "b", "c", "d", "", "", "stat"], bg: [false, false, false, false, true, true, false] },
				{
					rows: ["a", "b", "c", "d", "e", "", "", "stat"],
					bg: [false, false, false, false, false, true, true, false],
				},
				{
					rows: ["a", "b", "c", "d", "e", "f", "", "", "stat"],
					bg: [false, false, false, false, false, false, true, true, false],
				},
				{
					rows: ["a", "b", "c", "d", "e", "f", "g", "", "", "stat"],
					bg: [false, false, false, false, false, false, false, true, true, false],
				},
			],
		},
		{
			name: "full-viewport frame, in-place multi-row diff incl bg box",
			w: 40,
			h: 6,
			frames: [
				{ rows: ["top", "mid", "", "", "stat"], bg: [false, false, true, true, false] },
				{ rows: ["top", "CHANGED", "", "", "stat2"], bg: [false, false, true, true, false] },
			],
		},
		{
			name: "shrink frame: assistant block collapses",
			w: 40,
			h: 12,
			frames: [
				{
					rows: ["q", "", "aaaa", "bbbb", "cccc", "", "", "stat"],
					bg: [false, false, false, false, false, true, true, false],
				},
				{ rows: ["q", "", "done", "", "", "stat"], bg: [false, false, false, true, true, false] },
			],
		},
	];

	for (const sc of scenarios) {
		it(`matches padded fallback: ${sc.name}`, async () => {
			const off = await runScenario(false, sc.w, sc.h, sc.frames);
			const on = await runScenario(true, sc.w, sc.h, sc.frames);
			if (off.dump() !== on.dump()) {
				const offL = off.dump().split("\n");
				const onL = on.dump().split("\n");
				const diff = offL
					.map((l, i) => (l === onL[i] ? null : `row ${i}:\n  off ${l}\n  on  ${onL[i]}`))
					.filter(Boolean)
					.join("\n");
				throw new Error(`bg grid diverged for "${sc.name}":\n${diff}`);
			}
			expect(on.dump()).toBe(off.dump());
		});
	}

	it("fuzz: random multi-frame sequences match the padded fallback", async () => {
		const words = ["", "", "ok", "ping", "google", "running cmd", "x", "hello world here", "a longer content line"];
		const failures: string[] = [];
		let totalTrials = 0;
		for (const startSeed of [0x12345678, 0x0badf00d, 0x7fffff00]) {
			// Deterministic LCG so a failure is reproducible from the seed.
			let seed = startSeed;
			const rnd = () => {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				return seed / 0x7fffffff;
			};
			const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
			const makeFrame = (w: number) => {
				const n = 1 + Math.floor(rnd() * 16);
				const rows: string[] = [];
				const bg: boolean[] = [];
				for (let i = 0; i < n; i++) {
					let r = pick(words);
					if (r.length > w) r = r.slice(0, w);
					rows.push(r);
					bg.push(rnd() < 0.5);
				}
				return { rows, bg };
			};
			for (let trial = 0; trial < 100; trial++) {
				totalTrials++;
				const w = 16 + Math.floor(rnd() * 40);
				const h = 3 + Math.floor(rnd() * 12);
				const frameCount = 1 + Math.floor(rnd() * 6);
				const frames = Array.from({ length: frameCount }, () => makeFrame(w));
				const off = await runScenario(false, w, h, frames);
				const on = await runScenario(true, w, h, frames);
				if (off.dump() !== on.dump()) {
					failures.push(
						`seed ${startSeed.toString(16)} trial ${trial} (w=${w},h=${h}):\n${JSON.stringify(frames)}\n--- off\n${off.dump()}\n--- on\n${on.dump()}`,
					);
					if (failures.length >= 3) break;
				}
			}
			if (failures.length >= 3) break;
		}
		if (failures.length > 0) {
			throw new Error(`DECCARA fuzz divergences (${totalTrials} trials):\n${failures.join("\n\n")}`);
		}
	}, 60000);
});
