import { describe, expect, it } from "vitest";
import { resolvePackageManifest } from "../src/core/package-manifest.ts";

describe("package manifest compatibility", () => {
	it("uses package.json pi when omk is absent", () => {
		const resolved = resolvePackageManifest({
			pi: { extensions: ["./index.ts"], skills: ["./skills"] },
		});

		expect(resolved).toEqual({
			key: "pi",
			manifest: { extensions: ["./index.ts"], skills: ["./skills"] },
			diagnostics: [],
			present: { omk: false, pi: true },
		});
	});

	it("keeps omk authoritative over pi, including an empty omk manifest", () => {
		const resolved = resolvePackageManifest({
			omk: {},
			pi: { extensions: ["./legacy.ts"] },
		});

		expect(resolved).toMatchObject({
			key: "omk",
			manifest: {},
			present: { omk: true, pi: true },
		});
	});

	it("fails closed on malformed authoritative fields instead of falling through", () => {
		const resolved = resolvePackageManifest({
			omk: { extensions: ["./safe.ts", 42], skills: "./skills" },
			pi: { extensions: ["./legacy.ts"] },
		});

		expect(resolved.key).toBe("omk");
		expect(resolved.manifest).toEqual({ extensions: ["./safe.ts"] });
		expect(resolved.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(["omk.extensions[1]", "omk.skills"]);
	});

	it("rejects manifest paths that escape the package", () => {
		const resolved = resolvePackageManifest({
			pi: { extensions: ["./safe.ts", "../outside.ts", "/absolute.ts", "!../excluded.ts", "C:\\escape.ts"] },
		});

		expect(resolved.manifest).toEqual({ extensions: ["./safe.ts"] });
		expect(resolved.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
			"pi.extensions[1]",
			"pi.extensions[2]",
			"pi.extensions[3]",
			"pi.extensions[4]",
		]);
	});

	it("returns convention mode when neither manifest key is present", () => {
		expect(resolvePackageManifest({ name: "conventional" })).toEqual({
			key: null,
			manifest: null,
			diagnostics: [],
			present: { omk: false, pi: false },
		});
	});
});
