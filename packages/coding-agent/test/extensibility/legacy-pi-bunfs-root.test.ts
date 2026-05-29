import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { __computeBunfsPackageRoot } from "../../src/extensibility/plugins/legacy-pi-compat";

// Regression for issue #1514: legacy pi compat shim paths were built from a
// hardcoded POSIX literal `/$bunfs/root/packages`. On Windows the bunfs root
// actually mounts at `<drive>:\~BUN\root\…` (oven-sh/bun#15766) and the POSIX
// literal normalises to `\$bunfs\root\…`, which is unresolvable. The fix
// derives the bunfs root from `import.meta.dir`, so the host OS's separators
// are preserved end-to-end.
describe("legacy pi compat bunfs root computation (issue #1514)", () => {
	it("preserves the Windows-native bunfs root and separators", () => {
		const winMetaDir = "B:\\~BUN\\root\\packages\\coding-agent\\src\\extensibility\\plugins";
		const root = __computeBunfsPackageRoot(winMetaDir, path.win32);
		expect(root).toBe("B:\\~BUN\\root\\packages");
		// The shim path joined from this root must still live under the bunfs
		// mount, never collapse onto the working drive (which is what
		// `path.win32.resolve("/$bunfs/root/packages/...")` would produce).
		expect(path.win32.join(root, "coding-agent", "src", "extensibility", "legacy-pi-ai-shim.js")).toBe(
			"B:\\~BUN\\root\\packages\\coding-agent\\src\\extensibility\\legacy-pi-ai-shim.js",
		);
	});

	it("preserves the POSIX bunfs root on Linux and macOS compiled binaries", () => {
		const posixMetaDir = "/$bunfs/root/packages/coding-agent/src/extensibility/plugins";
		expect(__computeBunfsPackageRoot(posixMetaDir, path.posix)).toBe("/$bunfs/root/packages");
	});

	it("strips four directories from the host's import.meta.dir regardless of platform", () => {
		// Using the current host's `path` impl on a fabricated metaDir guards
		// against drift in either the directory depth or the path helper
		// choice (e.g. accidental `path.posix.resolve` on the runtime path).
		const metaDir = path.join("/", "anywhere", "packages", "coding-agent", "src", "extensibility", "plugins");
		expect(__computeBunfsPackageRoot(metaDir)).toBe(path.join("/", "anywhere", "packages"));
	});
});
