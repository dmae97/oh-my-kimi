import * as path from "node:path";

/**
 * Pure helpers used by `./index.js` to decide whether the loader is running
 * inside a Bun-compiled standalone binary, and to compute the ordered list of
 * candidate paths the loader probes for `pi_natives.<platform>-<arch>*.node`.
 *
 * Kept as a separate ESM module so the logic can be unit-tested without
 * triggering the side-effectful `loadNative()` call in `index.js`.
 *
 * Background (issue #823): `bun build --compile --define PI_COMPILED=true`
 * substitutes the bare identifier `PI_COMPILED`, NOT `process.env.PI_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Older CommonJS loader
 * code also saw the original build-host absolute path in `__filename`; ESM
 * `import.meta.url` is rewritten to the bunfs URL. The embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */


/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
export function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.PI_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}

/**
 * @param {{ tag: string; arch: string; variant: "modern" | "baseline" | null | undefined }} input
 * @returns {string[]}
 */
export function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `pi_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `pi_natives.${tag}-baseline.node`;
	const modernFilename = `pi_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}

/**
 * Decide whether the loader should mirror the package's `native/<filename>.node`
 * into the per-version cache directory (`~/.omp/natives/<version>/`) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `omp`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@oh-my-pi/pi-natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Staging into the version-pinned cache:
 *   1. Gives every package version its own filesystem path, so concurrent omp
 *      processes never collide on the same file.
 *   2. Makes the running process keep its handle on the cache copy, freeing bun
 *      to overwrite the `node_modules` copy on subsequent updates.
 * Disabled on non-Windows (no file-lock problem), in workspace dev (`nativeDir`
 * is not inside a `node_modules` segment), and for compiled binaries (handled
 * by `maybeExtractEmbeddedAddon`).
 *
 * @param {{ platform: NodeJS.Platform | string; isCompiledBinary: boolean; nativeDir: string }} input
 * @returns {boolean}
 */
export function shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir }) {
	if (platform !== "win32") return false;
	if (isCompiledBinary) return false;
	// Check both separators independently of the host's `path.sep`: this helper
	// is shared by the loader (running on Windows with `\`) and the test suite
	// (typically running on POSIX hosts when CI executes the regression test).
	return nativeDir.includes("\\node_modules\\") || nativeDir.includes("/node_modules/");
}

/**
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   stageFromNodeModules?: boolean;
 *   nativeDir: string;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
export function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	stageFromNodeModules = false,
	nativeDir,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	const stagedCandidates = stageFromNodeModules
		? addonFilenames.map(filename => path.join(versionedDir, filename))
		: [];
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...stagedCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = baseReleaseCandidates;
	}
	return [...new Set(releaseCandidates)];
}

