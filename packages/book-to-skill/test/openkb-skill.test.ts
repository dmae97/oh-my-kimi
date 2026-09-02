import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const skillPath = resolve(packageRoot, "skills/openkb/SKILL.md");
const skill = (): string => readFileSync(skillPath, "utf8");

describe("bundled openkb skill", () => {
	it("ships as a discoverable skill beside the book-to-skill wrapper", () => {
		expect(existsSync(skillPath)).toBe(true);
		expect(skill()).toMatch(/^---\nname: openkb\n/);
	});

	it("pins the upstream it describes", () => {
		// The skill states OpenKB's command surface and wiki layout. Those are interface
		// facts, so a wrapper that states them differently is simply wrong — the pin is
		// what lets a reader check it against a known revision.
		expect(skill()).toContain("ff54396e575ee6feb0113b631a34caa082b441cc");
		expect(skill()).toContain("https://github.com/VectifyAI/OpenKB");
	});

	it("vendors no upstream file, so the pinned manifest stays about one upstream", () => {
		// `upstream.json` must equal a listing of `vendor/book-to-skill` exactly
		// (package.test.ts pins that). Vendoring a second upstream under `vendor/`
		// silently breaks that invariant, so the wrapper is derived prose instead.
		expect(existsSync(resolve(packageRoot, "vendor/openkb"))).toBe(false);
		const manifest = JSON.parse(readFileSync(resolve(packageRoot, "upstream.json"), "utf8")) as {
			files: Record<string, string>;
		};
		for (const path of Object.keys(manifest.files)) {
			expect(path.startsWith("vendor/book-to-skill/")).toBe(true);
		}
	});

	it("routes document-to-skill compilation to this package, not OpenKB's Skill Factory", () => {
		// Both tools compile documents into agent skills. Two answers to one request is
		// the routing split this package was merged to avoid, so the redirect is pinned.
		const text = skill();
		expect(text).toContain("/book-to-skill-compile");
		expect(text).toMatch(/openkb skill new/);
		// Sentence-scoped, not line-scoped: the prose is hard-wrapped, so the physical line
		// holding the Skill Factory mention need not hold the redirect that governs it.
		const sentences = text.replace(/\s+/g, " ").split(/(?<=\.)\s/);
		const factoryMentions = sentences.filter((sentence) => sentence.includes("openkb skill new"));
		expect(factoryMentions.length).toBeGreaterThan(0);
		for (const sentence of factoryMentions) {
			expect(sentence, sentence).toMatch(/book-to-skill-compile|instead of|not to/i);
		}
	});

	it("keeps every knowledge-base mutation behind an explicit user request", () => {
		const text = skill();
		for (const command of ["openkb add", "openkb remove", "openkb init", "openkb lint --fix"]) {
			expect(text, command).toContain(command);
		}
		expect(text).toMatch(/without an explicit|propose the exact command|do not run/i);
	});

	it("treats compiled wiki text as data rather than instructions", () => {
		// The pages are LLM-synthesised from documents the user ingested, which may be
		// adversarial. This is the same boundary the coding agent applies to its own
		// generated corpus, and it must not be dropped when the prose is rewritten.
		expect(skill()).toMatch(/data, not instructions/i);
		expect(skill()).toMatch(/untrusted/i);
	});

	it("records its provenance as derived rather than vendored", () => {
		const source = readFileSync(resolve(packageRoot, "skills/openkb/SOURCE.md"), "utf8");
		expect(source).toContain("ff54396e575ee6feb0113b631a34caa082b441cc");
		expect(source).toMatch(/Apache-2\.0/);
		expect(source).toMatch(/derived/i);
	});
});
