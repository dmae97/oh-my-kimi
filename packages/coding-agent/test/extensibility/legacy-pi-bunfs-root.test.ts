import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	__computeBundledSelfPackageRoot,
	__computeBunfsPackageRoot,
	__joinBunfsPath,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

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

	it("preserves the double-slash bunfs prefix through production shim path joins (issue #3329)", () => {
		// Bun 1.3.14 on the cross-compiled `omp-darwin-arm64` release asset
		// reports `import.meta.dir` as `//root/omp-darwin-arm64`. The leading
		// `//` is part of Bun's bunfs identifier, so both the root computation
		// and the production shim-path join must preserve it.
		const root = __computeBunfsPackageRoot("//root/omp-darwin-arm64", path.posix);
		expect(root).toBe("//root/packages");
		expect(__joinBunfsPath(root, ["coding-agent", "src", "extensibility", "typebox.js"], path.posix)).toBe(
			"//root/packages/coding-agent/src/extensibility/typebox.js",
		);

		// `$bunfs`-prefixed variant is also handled.
		expect(__computeBunfsPackageRoot("/$bunfs/root/omp", path.posix)).toBe("/$bunfs/root/packages");
		// Windows variant: bunfs mount at `<drive>:\~BUN\root` with the binary
		// basename appended.
		expect(__computeBunfsPackageRoot("B:\\~BUN\\root\\omp.exe", path.win32)).toBe("B:\\~BUN\\root\\packages");
	});

	it("uses the current host path implementation for production calls", () => {
		const metaDir = path.join("/", "anywhere", "root");
		expect(__computeBunfsPackageRoot(metaDir)).toBe(path.join("/", "anywhere", "root", "packages"));
	});

	it("derives the npm prebuilt bundle package root from dist import.meta.dir", () => {
		const computeBundledSelfPackageRoot = __computeBundledSelfPackageRoot;

		const winMetaDir = "C:\\Users\\me\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist";
		expect(computeBundledSelfPackageRoot(winMetaDir, path.win32)).toBe(
			"C:\\Users\\me\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent",
		);

		const posixMetaDir = "/home/me/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist";
		expect(computeBundledSelfPackageRoot(posixMetaDir, path.posix)).toBe(
			"/home/me/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent",
		);
	});

	it("derives the source package root when PI_BUNDLED is used outside dist", () => {
		const computeBundledSelfPackageRoot = __computeBundledSelfPackageRoot;

		const winMetaDir = "C:\\repo\\packages\\coding-agent\\src\\extensibility\\plugins";
		expect(computeBundledSelfPackageRoot(winMetaDir, path.win32)).toBe("C:\\repo\\packages\\coding-agent");

		const posixMetaDir = "/repo/packages/coding-agent/src/extensibility/plugins";
		expect(computeBundledSelfPackageRoot(posixMetaDir, path.posix)).toBe("/repo/packages/coding-agent");
	});
});
