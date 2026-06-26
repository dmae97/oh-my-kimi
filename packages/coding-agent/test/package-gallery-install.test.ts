import { describe, expect, it } from "vitest";
import {
	buildGalleryInstallSpec,
	buildGalleryInstallSpecFromReview,
	dedupeGalleryEntries,
} from "../src/core/package-gallery.ts";

const FULL_COMMIT_SHA = "1234567890abcdef1234567890abcdef12345678";

describe("package gallery install and identity algorithms", () => {
	it("builds install specs without introducing a URL source type", () => {
		expect(buildGalleryInstallSpec({ kind: "npm", name: "@scope/theme", version: "1.2.3" }, false)).toEqual({
			kind: "npm",
			source: "npm:@scope/theme@1.2.3",
			installCommand: "omk install npm:@scope/theme@1.2.3",
			tryEphemeralCommand: "omk -e npm:@scope/theme@1.2.3",
			trust: "declarative",
		});
		expect(buildGalleryInstallSpec({ kind: "git", repo: "github.com/acme/pkg", ref: FULL_COMMIT_SHA }, true)).toEqual(
			{
				kind: "git",
				source: `git:github.com/acme/pkg@${FULL_COMMIT_SHA}`,
				installCommand: `omk install git:github.com/acme/pkg@${FULL_COMMIT_SHA}`,
				tryEphemeralCommand: `omk -e git:github.com/acme/pkg@${FULL_COMMIT_SHA}`,
				trust: "code-execution",
			},
		);
		expect(buildGalleryInstallSpec({ kind: "local", path: "./theme-pack" }, false, { local: true })).toEqual({
			kind: "local",
			source: "./theme-pack",
			installCommand: "omk install ./theme-pack -l",
			tryEphemeralCommand: "omk -e ./theme-pack",
			trust: "declarative",
		});
	});

	it("refuses gallery install specs for mutable remote sources", () => {
		expect(() => buildGalleryInstallSpec({ kind: "npm", name: "pkg" }, false)).toThrow(/exact pinned version/);
		expect(() => buildGalleryInstallSpec({ kind: "npm", name: "pkg", version: "latest" }, false)).toThrow(
			/exact pinned version/,
		);
		expect(() => buildGalleryInstallSpec({ kind: "git", repo: "github.com/acme/pkg" }, true)).toThrow(
			/full commit SHA/,
		);
		expect(() => buildGalleryInstallSpec({ kind: "git", repo: "github.com/acme/pkg", ref: "main" }, true)).toThrow(
			/full commit SHA/,
		);
	});

	it("derives install trust from procurement review instead of manifest claims", () => {
		const cleanExtensionReview = {
			pinned: true,
			capabilities: [],
			adoption: "ephemeral-trial",
			rejectedReasons: [],
			candidate: { expectedResources: ["extension"] },
		} as const;

		expect(
			buildGalleryInstallSpecFromReview(
				{ kind: "npm", name: "@acme/extension", version: "1.2.3" },
				cleanExtensionReview,
			).trust,
		).toBe("code-execution");
		expect(() =>
			buildGalleryInstallSpecFromReview(
				{ kind: "npm", name: "@acme/extension", version: "1.2.3" },
				{ ...cleanExtensionReview, pinned: false },
			),
		).toThrow(/Gallery trial blocked/);
	});

	it("deduplicates cards by npm name, git repo without ref, and resolved local path", () => {
		const entries = [
			{ id: "a", identity: { kind: "npm", name: "@scope/pkg" } as const },
			{ id: "b", identity: { kind: "npm", name: "@scope/pkg" } as const },
			{ id: "c", identity: { kind: "git", repo: "github.com/acme/pkg", ref: "v1" } as const },
			{ id: "d", identity: { kind: "git", repo: "github.com/acme/pkg", ref: "v2" } as const },
			{ id: "e", identity: { kind: "local", path: "./pkg" } as const },
			{ id: "f", identity: { kind: "local", path: "./pkg" } as const },
		];

		expect(dedupeGalleryEntries(entries).map((entry) => entry.id)).toEqual(["a", "c", "e"]);
	});
});
