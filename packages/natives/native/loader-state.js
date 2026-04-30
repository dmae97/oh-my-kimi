"use strict";

/**
 * Pure helpers used by `./index.js` to decide whether the loader is running
 * inside a Bun-compiled standalone binary, and to compute the ordered list of
 * candidate paths the loader probes for `pi_natives.<platform>-<arch>*.node`.
 *
 * Kept as a separate CommonJS module so the logic can be unit-tested without
 * triggering the side-effectful `loadNative()` call in `index.js`.
 *
 * Background (issue #823): `bun build --compile --define PI_COMPILED=true`
 * substitutes the bare identifier `PI_COMPILED`, NOT `process.env.PI_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Bun also retains the
 * original build-host absolute path in `__filename` for required CJS modules —
 * only `import.meta.url` is rewritten to the bunfs URL. Both legacy signals are
 * therefore false in the shipped binary, which is why the embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */

const path = require("node:path");

/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
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
function getAddonFilenames({ tag, arch, variant }) {
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
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   nativeDir: string;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
function resolveLoaderCandidates({ addonFilenames, isCompiledBinary, nativeDir, execDir, versionedDir, userDataDir }) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	const releaseCandidates = isCompiledBinary
		? [...compiledCandidates, ...baseReleaseCandidates]
		: baseReleaseCandidates;
	return [...new Set(releaseCandidates)];
}

module.exports = { detectCompiledBinary, getAddonFilenames, resolveLoaderCandidates };
