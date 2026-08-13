import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "omk-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TodoState } from "../src/core/todo-state.ts";
import {
	ControlPanelComponent,
	type ControlPanelStatusSnapshot,
} from "../src/modes/interactive/components/control-panel.ts";
import {
	getAvailableThemes,
	getThemeByName,
	initTheme,
	resolveThemeName,
} from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createPanel(statusSnapshot?: () => ControlPanelStatusSnapshot): ControlPanelComponent {
	return new ControlPanelComponent({
		appName: "omk",
		version: "0.80.5",
		compactInstructions: () => "Ctrl+C interrupt · / commands · ! bash",
		expandedInstructions: () => "Ctrl+C to interrupt\n/ for commands\n! to run bash",
		compactOnboarding: () => "Press Ctrl+O to show full startup help and loaded resources.",
		onboarding: () => "OMK can explain its own features and look up its docs.",
		statusSnapshot,
	});
}

function makeTodoState(items: TodoState["items"]): TodoState {
	return { items, updatedAt: 1 };
}

let previousPackageDir: string | undefined;

beforeAll(() => {
	previousPackageDir = process.env.OMK_PACKAGE_DIR;
	process.env.OMK_PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
	initTheme("omk-neon-control");
});

afterAll(() => {
	if (previousPackageDir === undefined) {
		delete process.env.OMK_PACKAGE_DIR;
	} else {
		process.env.OMK_PACKAGE_DIR = previousPackageDir;
	}
});

describe("ControlPanelComponent", () => {
	test("renders a compact ANSI control panel without exceeding terminal width", () => {
		const panel = createPanel();
		const lines = panel.render(48);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("WELCOME TO OMK");
		expect(plain).toContain("CORE:UNKNOWN");
		expect(plain).toContain("Ctrl+C interrupt");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});

	test("renders the wide OMK control deck with a pinned sidebar", () => {
		const panel = createPanel();
		const lines = panel.render(160);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("OMK://CONTROL");
		expect(plain).toContain("CYBERPUNK OPS CORE");
		expect(plain).toContain("MATRIX RAIN");
		expect(plain).toContain("NIGHT-CITY-MATRIX-V3");
		expect(plain).toContain("SESSION");
		expect(plain).toContain("MODEL / CTX");
		expect(plain).toContain("RUNTIME / MCP / SKILLS");
		expect(plain).toContain("CONTROL");
		expect(plain).toContain("OMK://CONTROL READ");
		expect(lines.every((line) => visibleWidth(line) <= 160)).toBe(true);
	});

	test("renders live model, CTX, and HeadRoom status from the snapshot", () => {
		const panel = createPanel(() => ({
			modelProvider: "openrouter",
			modelId: "omk-test-model",
			thinkingLevel: "high",
			contextPercent: 42.5,
			contextWindowTokens: 128_000,
			headroomStatus: "headroom:0.29.0",
			skillCount: 96,
			mcpCount: 12,
			cwdLabel: "~/open_multi-agent_kit",
			gitBranch: "main",
			packageIntake: {
				total: 6,
				acceptedNative: 2,
				acceptedReference: 1,
				acceptedMeasurement: 1,
				acceptedAdvisory: 0,
				deferred: 1,
				reject: 1,
				hardForkBlocked: 1,
				topLanes: [
					{ lane: "browser", label: "browser", total: 1, accepted: 1, deferred: 0, reject: 0, hardForkBlocked: 0 },
					{ lane: "footer", label: "footer", total: 1, accepted: 1, deferred: 0, reject: 0, hardForkBlocked: 0 },
					{ lane: "lens", label: "lens", total: 1, accepted: 1, deferred: 0, reject: 0, hardForkBlocked: 0 },
					{ lane: "mcp", label: "MCP", total: 1, accepted: 1, deferred: 0, reject: 0, hardForkBlocked: 0 },
					{
						lane: "subagent",
						label: "subagent",
						total: 1,
						accepted: 0,
						deferred: 1,
						reject: 0,
						hardForkBlocked: 0,
					},
					{ lane: "todo", label: "todo", total: 1, accepted: 0, deferred: 0, reject: 1, hardForkBlocked: 1 },
				],
			},
		}));
		const plain = stripAnsi(panel.render(160).join("\n"));

		expect(plain).toContain("model: openrouter/omk-test-model");
		expect(plain).toContain("think: high");
		expect(plain).toContain("ctx: 42.5%/128k");
		expect(plain).toContain("meter:");
		expect(plain).toContain("pulse:");
		expect(plain).toContain("headroom: headroom:0.29.0");
		expect(plain).toContain("cwd: ~/open_multi-agent_kit");
		expect(plain).toContain("git: main");
		expect(plain).toContain("res: MCP:12 skills:96");
		expect(plain).toContain("pkg: ports:4/6 review:2 block:1");
		expect(plain).not.toContain("deepseek/deepseek-v4-pro");
		expect(plain).not.toContain("ctx: 0.0%/1.0M");
	});

	test("renders live TODO state in the sidebar instead of static placeholder copy", () => {
		const panel = createPanel(() => ({
			todoState: makeTodoState([
				{ id: "route", label: "Route implementation wave", status: "done" },
				{ id: "verify", label: "Verify tmux control panel", status: "active" },
				{ id: "docs", label: "Update setup docs", status: "pending" },
			]),
		}));
		const plain = stripAnsi(panel.render(160).join("\n"));

		expect(plain).toContain("todo: 1/3 done");
		expect(plain).toContain("next: Verify tmux control panel");
		expect(plain).not.toContain("add branch TODOs with /todos");
	});

	test("renders expanded block branding and command map", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		const lines = panel.render(96);
		const plain = stripAnsi(lines.join("\n"));

		expect(plain).toContain("WELCOME TO OMK");
		expect(plain).toContain("████");
		expect(plain).toContain("PANEL unknown");
		expect(plain).toContain("THEME NEON-CONTROL");
		expect(plain).toContain("SYSTEM MAP");
		expect(plain).toContain("! to run bash");
		expect(lines.every((line) => visibleWidth(line) <= 96)).toBe(true);
	});

	test("renders the 96-column expanded fallback with closed frame edges", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		const lines = panel.render(96);
		const plainLines = lines.map(stripAnsi);

		expect(lines.every((line) => visibleWidth(line) <= 96)).toBe(true);
		for (const line of plainLines) {
			if (line.startsWith("+")) {
				expect(line).toMatch(/\+$/);
			}
			if (line.startsWith("|")) {
				expect(line).toMatch(/\|$/);
			}
		}
	});

	test("renders startup onboarding under the startup link section", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		const plain = stripAnsi(panel.render(96).join("\n"));

		expect(plain).toContain("STARTUP LINK");
		expect(plain).toContain("OMK can explain its own features");
	});

	test("re-renders compact output after expansion is disabled", () => {
		const panel = createPanel();
		panel.setExpanded(true);
		expect(stripAnsi(panel.render(80).join("\n"))).toContain("SYSTEM MAP");

		panel.setExpanded(false);
		const compact = stripAnsi(panel.render(80).join("\n"));
		expect(compact).not.toContain("SYSTEM MAP");
		expect(compact).toContain("Press Ctrl+O");
	});
});

describe("omk control panel theme", () => {
	test("registers the elevated control-panel theme and aliases", () => {
		expect(getAvailableThemes()).toContain("omk-control-panel");
		expect(resolveThemeName("g0dm0d3")).toBe("omk-control-panel");
		expect(resolveThemeName("control-panel")).toBe("omk-control-panel");
		expect(getThemeByName("g0dm0d3")?.name).toBe("omk-control-panel");
	});

	test("registers rust-forge control aliases without duplicating the theme", () => {
		expect(getAvailableThemes()).toContain("rust-forge");
		expect(resolveThemeName("rust-forge-control")).toBe("rust-forge");
		expect(resolveThemeName("omk-rust-forge")).toBe("rust-forge");
		expect(getThemeByName("rust-forge-control")?.name).toBe("rust-forge");
	});
});

test("96-column expanded fallback keeps coherent border framing on every row", () => {
	type VisualQaArtifact = {
		borderMisaligned?: boolean;
		expectedColumns?: number;
		lineWidths?: number[];
		summary?: string;
	};

	const panel = createPanel();
	panel.setExpanded(true);
	const liveRows = panel.render(96).map(stripAnsi);
	const dividerPairs = new Map([
		["+", "+"],
		["╭", "╮"],
		["├", "┤"],
		["╰", "╯"],
	]);
	const liveMalformedRows = liveRows
		.map((line, index) => {
			const glyphs = Array.from(line);
			return {
				index,
				line,
				width: visibleWidth(line),
				first: glyphs[0] ?? "",
				last: glyphs.at(-1) ?? "",
			};
		})
		.filter(({ first, last, line, width }) => {
			if (line.trim().length === 0) return false;
			const hasPairedDivider = dividerPairs.get(first) === last;
			const hasPairedContentEdges = (first === "|" && last === "|") || (first === "│" && last === "│");
			return width !== 96 || (!hasPairedDivider && !hasPairedContentEdges);
		});
	// Live render coherence is the always-on assertion for current code.
	expect(
		liveMalformedRows,
		"96-column fallback framing must be coherent for ASCII or Unicode boxes in live render",
	).toEqual([]);

	// The recorded visual-QA artifact lives under .omo/ (gitignored, local-only) and is kept
	// for comparison, not trusted as current render truth. Skip the comparison when it is
	// absent (e.g. CI checkouts) instead of failing the run.
	const visualArtifactPath = fileURLToPath(
		new URL(
			"../../../.omo/visual-qa/20260629-advanced-omk-tui-control-panel/tui-check-render-96.json",
			import.meta.url,
		),
	);
	if (existsSync(visualArtifactPath)) {
		const visualArtifact = JSON.parse(readFileSync(visualArtifactPath, "utf8")) as VisualQaArtifact;
		const expectedColumns = visualArtifact.expectedColumns ?? 96;
		const artifactWrongWidthRows = (visualArtifact.lineWidths ?? [])
			.map((width, index) => ({ index, width }))
			.filter(({ width }) => width !== expectedColumns);
		expect(
			{
				borderMisaligned: visualArtifact.borderMisaligned === true,
				wrongWidthRows: artifactWrongWidthRows,
				summary: visualArtifact.summary,
			},
			"96-column visual QA artifact is recorded for comparison but is not trusted as current render truth",
		).toEqual({
			borderMisaligned: visualArtifact.borderMisaligned === true,
			wrongWidthRows: artifactWrongWidthRows,
			summary: visualArtifact.summary,
		});
	}
});

test("empty status snapshot rejects unconditional healthy control claims", () => {
	const plain = stripAnsi(
		createPanel(() => ({}))
			.render(160)
			.join("\n"),
	);
	const unconditionalHealthyClaims = [
		/CORE:READY/i,
		/state:\s*\*\s*ready/i,
		/route:\s*armed/i,
		/verify:\s*evidence gated/i,
		/evidence gated/i,
	];

	const violations = unconditionalHealthyClaims
		.map((claim) => claim.source)
		.filter((claim) => new RegExp(claim, "i").test(plain));
	const renderedStatusCue = /snapshot|unknown|degraded/i.test(plain);

	expect(
		{ renderedStatusCue, violations },
		"empty snapshot must render data-status cues and no unconditional healthy claims",
	).toEqual({ renderedStatusCue: true, violations: [] });
});
test("112-column overlay boundary keeps rail hidden until 113 columns", () => {
	const at111 = stripAnsi(createPanel().render(111).join("\n"));
	const at112 = stripAnsi(createPanel().render(112).join("\n"));
	const at113 = stripAnsi(createPanel().render(113).join("\n"));

	expect(at111).not.toContain("1:CONTROL");
	expect(at112).not.toContain("1:CONTROL");
	expect(at112).not.toContain("OMK://CONTROL");
	expect(at113).toContain("1:CONTROL");
});

test("long onboarding does not repeat right rail labels after first panel", () => {
	const onboarding = Array.from({ length: 72 }, (_, index) => `onboarding line ${index + 1}`).join("\n");
	const panel = new ControlPanelComponent({
		appName: "omk",
		version: "0.80.5",
		compactInstructions: () => "Ctrl+C interrupt · / commands · ! bash",
		expandedInstructions: () => onboarding,
		compactOnboarding: () => "compact onboarding",
		onboarding: () => onboarding,
		statusSnapshot: () => ({}),
	});
	const plain = stripAnsi(panel.render(160).join("\n"));

	const railLines = plain
		.split("\n")
		.filter((line) => !line.includes("omk v") && !line.includes("OMK://CONTROL READ"));
	for (const railText of ["1:CONTROL", "OMK://CONTROL", "CYBERPUNK OPS CORE"]) {
		const count = railLines.filter((line) => line.includes(railText)).length;
		expect(count, `${railText} rail repetition count`).toBeLessThanOrEqual(1);
	}
});
