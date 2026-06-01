import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { __computeBunfsPackageRoot } from "../../src/extensibility/plugins/legacy-pi-compat";

// Regression for issue #1514: legacy pi compat shim paths were built from a
// hardcoded POSIX literal `/$bunfs/root/packages`. On Windows the bunfs root
// mounts at `<drive>:\~BUN\root\…` (oven-sh/bun#15766) and the POSIX literal
// normalises to `\$bunfs\root\…`, which is unresolvable. The fix derives the
// package root from the compiled binary's `import.meta.dir`, so the host OS's
// separators are preserved end-to-end.
describe("legacy pi compat bunfs root computation (issue #1514)", () => {
	it("appends packages to the Windows-native compiled bunfs root", () => {
		const winMetaDir = "B:\\~BUN\\root";
		const root = __computeBunfsPackageRoot(winMetaDir, path.win32);
		expect(root).toBe("B:\\~BUN\\root\\packages");
		// The shim path joined from this root must still live under the bunfs
		// mount, never collapse onto the working drive (which is what
		// `path.win32.resolve("/$bunfs/root/packages/...")` would produce).
		expect(path.win32.join(root, "coding-agent", "src", "extensibility", "legacy-pi-ai-shim.js")).toBe(
			"B:\\~BUN\\root\\packages\\coding-agent\\src\\extensibility\\legacy-pi-ai-shim.js",
		);
	});

	it("appends packages to the POSIX compiled bunfs root on Linux and macOS", () => {
		expect(__computeBunfsPackageRoot("/$bunfs/root", path.posix)).toBe("/$bunfs/root/packages");
	});

	it("also supports module-specific import.meta.dir values if Bun changes compiled semantics", () => {
		const winMetaDir = "B:\\~BUN\\root\\packages\\coding-agent\\src\\extensibility\\plugins";
		expect(__computeBunfsPackageRoot(winMetaDir, path.win32)).toBe("B:\\~BUN\\root\\packages");
		const posixMetaDir = "/$bunfs/root/packages/coding-agent/src/extensibility/plugins";
		expect(__computeBunfsPackageRoot(posixMetaDir, path.posix)).toBe("/$bunfs/root/packages");
	});

	it("uses the current host path implementation for production calls", () => {
		const metaDir = path.join("/", "anywhere", "root");
		expect(__computeBunfsPackageRoot(metaDir)).toBe(path.join("/", "anywhere", "root", "packages"));
	});
});
