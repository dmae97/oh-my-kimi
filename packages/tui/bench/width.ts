/**
 * Benchmark: native visibleWidth vs Bun.stringWidth vs hybrid implementation
 *
 * Run: bun packages/tui/bench/visible-width.ts
 */
import { visibleWidth as nativeVisibleWidth } from "@oh-my-pi/pi-natives";
import { getDefaultTabWidth } from "@oh-my-pi/pi-utils";
import { visibleWidthRaw as hybridVisibleWidth, replaceTabs } from "../src/utils";

const ITERATIONS = 10_000;
const WARMUP = 500;

// Test cases covering different scenarios
const samples = {
	// Pure ASCII - different lengths
	ascii_short: "hello",
	ascii_medium: "hello world this is a plain ASCII string with some words",
	ascii_long: "a".repeat(500),

	// ANSI escape codes
	ansi_simple: "\x1b[31mred\x1b[0m",
	ansi_complex: "\x1b[31mred text\x1b[0m and \x1b[4munderlined content\x1b[24m with more \x1b[1;33;44mstyles\x1b[0m",
	ansi_nested: "\x1b[1m\x1b[31m\x1b[4mbold red underline\x1b[0m normal \x1b[32mgreen\x1b[0m",

	// OSC 8 hyperlinks
	links: "prefix \x1b]8;;https://example.com\x07link text\x1b]8;;\x07 suffix",
	links_multiple:
		"Click \x1b]8;;https://a.com\x07here\x1b]8;;\x07 or \x1b]8;;https://b.com\x07there\x1b]8;;\x07 for info",

	// Wide characters (CJK)
	cjk_short: "日本語",
	cjk_medium: "日本語のテキストとemoji",
	cjk_long: "日本語のテキストと中文字符和한국어문자混合在一起形成很长的字符串",

	// Emoji
	emoji_simple: "👋🌍",
	emoji_complex: "Hello 👨‍👩‍👧‍👦 family! 🚀✨🎉 Let's go! 🇺🇸🏳️‍🌈",
	emoji_zwj: "👨‍💻👩‍🔬👨‍👩‍👧‍👦", // ZWJ sequences

	// Mixed content
	mixed_short: "Hello 世界 🌍",
	mixed_medium: "\x1b[32mStatus:\x1b[0m 成功 ✓ (took 42ms)",
	mixed_long:
		"\x1b[1;34m[INFO]\x1b[0m Processing 日本語テキスト with emoji 🚀 and \x1b]8;;https://example.com\x07links\x1b]8;;\x07 完了",

	// Edge cases
	tabs: "col1\tcol2\tcol3\tcol4",
	empty: "",
	newlines: "line1\nline2\nline3",
	control_chars: "text\x00with\x01control\x02chars",
};

// Bun.stringWidth with ANSI stripping (what hybrid uses for short strings)
function bunStringWidth(str: string): number {
	if (!str) return 0;
	return Bun.stringWidth(replaceTabs(str));
}

interface BenchResult {
	name: string;
	totalMs: number;
	perOpUs: number;
}

function bench(name: string, fn: () => void): BenchResult {
	// Warmup
	for (let i = 0; i < WARMUP; i++) fn();

	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		fn();
	}
	const totalMs = (Bun.nanoseconds() - start) / 1e6;
	const perOpUs = (totalMs / ITERATIONS) * 1000;

	return { name, totalMs, perOpUs };
}

function formatResult(r: BenchResult, baseline?: BenchResult): string {
	const perOp = r.perOpUs.toFixed(3);
	if (baseline && baseline !== r) {
		const ratio = r.perOpUs / baseline.perOpUs;
		const indicator = ratio < 1 ? "faster" : "slower";
		return `${r.name.padEnd(20)} ${r.totalMs.toFixed(2).padStart(8)}ms  ${perOp.padStart(8)}µs/op  ${ratio.toFixed(2)}x ${indicator}`;
	}
	return `${r.name.padEnd(20)} ${r.totalMs.toFixed(2).padStart(8)}ms  ${perOp.padStart(8)}µs/op  (baseline)`;
}

console.log(`\n${"=".repeat(80)}`);
console.log(`visibleWidth benchmark: ${ITERATIONS.toLocaleString()} iterations, ${WARMUP} warmup`);
console.log(`${"=".repeat(80)}\n`);

for (const [sampleName, sample] of Object.entries(samples)) {
	console.log(`\n--- ${sampleName} (len=${sample.length}) ---`);
	if (sample.length > 0 && sample.length < 80) {
		// Show sample for short strings (escape non-printable)
		const display = sample.replace(/\x1b/g, "\\e").replace(/\x07/g, "\\a");
		console.log(`    "${display}"`);
	}

	const results: BenchResult[] = [];

	const tabW = getDefaultTabWidth();
	results.push(
		bench("native", () => {
			nativeVisibleWidth(sample, tabW);
		}),
	);

	results.push(
		bench("bun+strip", () => {
			bunStringWidth(sample);
		}),
	);

	results.push(
		bench("hybrid", () => {
			hybridVisibleWidth(sample);
		}),
	);

	// Find fastest as baseline
	const baseline = results.reduce((a, b) => (a.perOpUs < b.perOpUs ? a : b));

	console.log();
	for (const r of results) {
		console.log(`  ${formatResult(r, baseline)}`);
	}

	// Verify correctness
	const nativeResult = nativeVisibleWidth(sample, tabW);
	const bunResult = bunStringWidth(sample);
	const hybridResult = hybridVisibleWidth(sample);

	if (nativeResult !== hybridResult) {
		console.log(`  ⚠️  MISMATCH: native=${nativeResult}, hybrid=${hybridResult}`);
	}
	if (bunResult !== hybridResult && !sample.includes("\x00")) {
		// Control chars can differ
		console.log(`  ⚠️  MISMATCH: bun=${bunResult}, hybrid=${hybridResult}`);
	}
}

console.log(`\n${"=".repeat(80)}`);
console.log("Summary");
console.log(`${"=".repeat(80)}\n`);

// Aggregate by category
const categories = {
	ascii: ["ascii_short", "ascii_medium", "ascii_long"],
	ansi: ["ansi_simple", "ansi_complex", "ansi_nested"],
	links: ["links", "links_multiple"],
	cjk: ["cjk_short", "cjk_medium", "cjk_long"],
	emoji: ["emoji_simple", "emoji_complex", "emoji_zwj"],
	mixed: ["mixed_short", "mixed_medium", "mixed_long"],
};

const benchTabW = getDefaultTabWidth();

for (const [category, sampleNames] of Object.entries(categories)) {
	const categoryResults = { native: 0, bun: 0, hybrid: 0 };

	for (const name of sampleNames) {
		const sample = samples[name as keyof typeof samples];

		const nativeTime = bench("", () => nativeVisibleWidth(sample, benchTabW)).perOpUs;
		const bunTime = bench("", () => bunStringWidth(sample)).perOpUs;
		const hybridTime = bench("", () => hybridVisibleWidth(sample)).perOpUs;

		categoryResults.native += nativeTime;
		categoryResults.bun += bunTime;
		categoryResults.hybrid += hybridTime;
	}

	const fastest = Math.min(categoryResults.native, categoryResults.bun, categoryResults.hybrid);
	const winner =
		fastest === categoryResults.native ? "native" : fastest === categoryResults.bun ? "bun+strip" : "hybrid";

	console.log(
		`${category.padEnd(10)} native: ${categoryResults.native.toFixed(1)}µs  bun: ${categoryResults.bun.toFixed(1)}µs  hybrid: ${categoryResults.hybrid.toFixed(1)}µs  → ${winner} wins`,
	);
}
