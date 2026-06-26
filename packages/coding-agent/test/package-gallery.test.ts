import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyGalleryResourceTypes,
	filterGalleryEntriesByType,
	filterManifestEntriesInsideRoot,
	hasGalleryKeyword,
	isValidGalleryImageUrl,
	isValidGalleryVideoUrl,
	normalizeGalleryManifest,
	resolveGalleryTypeFacet,
	selectGalleryPreview,
} from "../src/core/package-gallery.ts";

describe("package gallery manifest algorithms", () => {
	it("normalizes omk manifests before legacy pi manifests", () => {
		expect(
			normalizeGalleryManifest({
				pi: { themes: ["legacy.json"], video: "https://cdn.example/legacy.mp4" },
				omk: {
					extensions: [" index.ts ", ""],
					themes: ["theme.json"],
					video: "https://cdn.example/demo.mp4",
					image: 42,
					description: " Neon theme ",
				},
			}),
		).toEqual({
			manifestKey: "omk",
			extensions: ["index.ts"],
			skills: [],
			prompts: [],
			themes: ["theme.json"],
			video: "https://cdn.example/demo.mp4",
			image: undefined,
			description: "Neon theme",
		});
	});

	it("falls back to legacy pi manifests and ignores invalid arrays", () => {
		expect(
			normalizeGalleryManifest({
				pi: { extensions: "extension.ts", skills: [" skill.md "], themes: ["", "theme.json"] },
			}),
		).toEqual({
			manifestKey: "pi",
			extensions: [],
			skills: ["skill.md"],
			prompts: [],
			themes: ["theme.json"],
			video: undefined,
			image: undefined,
			description: undefined,
		});
		expect(normalizeGalleryManifest({})).toBeNull();
		expect(normalizeGalleryManifest(null)).toBeNull();
	});

	it("detects OMK and legacy gallery keywords", () => {
		expect(hasGalleryKeyword({ keywords: ["omk-package"] })).toBe(true);
		expect(hasGalleryKeyword({ keywords: ["pi-package"] })).toBe(true);
		expect(hasGalleryKeyword({ keywords: ["other"] })).toBe(false);
		expect(hasGalleryKeyword(null)).toBe(false);
	});

	it("classifies resource types from manifests and convention directories", () => {
		const manifest = normalizeGalleryManifest({
			omk: { extensions: ["index.ts"], themes: ["theme.json"], skills: [] },
		});

		expect(classifyGalleryResourceTypes(manifest, ["skills", "themes"])).toEqual(["extension", "skill", "theme"]);
		expect(classifyGalleryResourceTypes(null, ["prompts"])).toEqual(["prompt"]);
		expect(classifyGalleryResourceTypes(null)).toEqual([]);
	});

	it("resolves and applies type facets with type=theme semantics", () => {
		expect(resolveGalleryTypeFacet("Theme")).toBe("theme");
		expect(resolveGalleryTypeFacet("themes")).toBe("theme");
		expect(resolveGalleryTypeFacet("extension")).toBe("extension");
		expect(resolveGalleryTypeFacet("bogus")).toBeUndefined();

		const entries = [
			{ name: "theme-a", resourceTypes: ["theme"] as const },
			{ name: "extension-a", resourceTypes: ["extension"] as const },
			{ name: "both", resourceTypes: ["extension", "theme"] as const },
		];

		expect(filterGalleryEntriesByType(entries, "theme").map((entry) => entry.name)).toEqual(["theme-a", "both"]);
		expect(filterGalleryEntriesByType(entries, "bogus")).toEqual([]);
		expect(filterGalleryEntriesByType(entries, undefined)).toEqual(entries);
	});

	it("validates gallery media URLs with https and extension allowlists", () => {
		expect(isValidGalleryVideoUrl("https://cdn.example/demo.mp4?token=abc")).toBe(true);
		expect(isValidGalleryVideoUrl("http://cdn.example/demo.mp4")).toBe(false);
		expect(isValidGalleryVideoUrl("https://cdn.example/demo.webm")).toBe(false);
		expect(isValidGalleryVideoUrl("data:video/mp4;base64,abc")).toBe(false);
		expect(isValidGalleryVideoUrl("https://user:pass@cdn.example/demo.mp4")).toBe(false);

		expect(isValidGalleryImageUrl("https://cdn.example/demo.png")).toBe(true);
		expect(isValidGalleryImageUrl("https://cdn.example/demo.jpeg?x=1")).toBe(true);
		expect(isValidGalleryImageUrl("https://cdn.example/demo.svg")).toBe(false);
		expect(isValidGalleryImageUrl("http://cdn.example/demo.png")).toBe(false);
		expect(isValidGalleryImageUrl(undefined)).toBe(false);
	});

	it("selects preview media with video before image and theme generated fallback", () => {
		expect(
			selectGalleryPreview({
				video: "https://cdn.example/demo.mp4",
				image: "https://cdn.example/demo.png",
				resourceTypes: ["theme"],
				themeName: "omk-neon-ops",
			}),
		).toEqual({ kind: "video", url: "https://cdn.example/demo.mp4" });
		expect(
			selectGalleryPreview({ video: "http://cdn.example/demo.mp4", image: "https://cdn.example/demo.webp" }),
		).toEqual({
			kind: "image",
			url: "https://cdn.example/demo.webp",
		});
		expect(selectGalleryPreview({ resourceTypes: ["theme"], themeName: "omk-neon-ops" })).toEqual({
			kind: "generated-theme",
			marker: "omk-neon-ops",
		});
		expect(selectGalleryPreview({ resourceTypes: ["extension"] })).toBeNull();
	});

	it("filters manifest entries that escape the package root", () => {
		const root = resolve("/tmp/package-gallery-root/pkg");
		expect(
			filterManifestEntriesInsideRoot(root, [
				"themes/dark.json",
				"themes/../themes/light.json",
				"../../../etc/passwd",
				"/abs/evil.ts",
				"",
			]),
		).toEqual(["themes/dark.json", "themes/light.json"]);
	});

	it("filters manifest entries by realpath so symlink escapes are rejected", () => {
		const root = join(tmpdir(), `package-gallery-realpath-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const outside = join(tmpdir(), `package-gallery-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);

		try {
			mkdirSync(join(root, "themes"), { recursive: true });
			mkdirSync(outside, { recursive: true });
			writeFileSync(join(root, "themes", "dark.json"), "{}");
			writeFileSync(join(outside, "evil.json"), "{}");
			symlinkSync(join(root, "themes", "dark.json"), join(root, "inside-link.json"));
			symlinkSync(join(outside, "evil.json"), join(root, "escape-link.json"));
			symlinkSync(outside, join(root, "escape-dir"));

			expect(
				filterManifestEntriesInsideRoot(root, [
					"themes/dark.json",
					"inside-link.json",
					"escape-link.json",
					"escape-dir/missing.json",
					"../outside.json",
				]),
			).toEqual(["themes/dark.json", "inside-link.json"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
