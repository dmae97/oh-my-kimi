/**
 * Extra `bun build --compile` entrypoints that must land in bunfs at
 * `/$bunfs/root/packages/<pkg>/...`.
 *
 * `legacy-pi-compat.ts` redirects bare TypeBox imports and the legacy
 * `@(scope)/pi-*` package roots onto computed bunfs paths — Bun's `--compile`
 * static analyzer cannot trace those, so each shim and bundled package barrel
 * must be passed as an explicit additional entrypoint or the file is silently
 * omitted from bunfs and plugin loads fail with `Cannot find module
 * '/$bunfs/root/...'` (issue #3414).
 *
 * The coding-agent's own `./src/index.ts` is intentionally NOT listed: bun
 * --compile silently breaks the CLI entry when the same package's barrel
 * appears as an extra entrypoint (issue #1474), so legacy `pi-coding-agent`
 * imports resolve through `legacy-pi-coding-agent-shim.ts` instead.
 *
 * Repo-root-relative — both `scripts/ci-release-build-binaries.ts` (release)
 * and `packages/coding-agent/scripts/build-binary.ts` (dev) invoke
 * `bun build --compile --root .` so the paths land at the same bunfs
 * locations the runtime computes.
 */
export const LEGACY_COMPAT_BUILD_ENTRYPOINTS: readonly string[] = [
	"./packages/agent/src/index.ts",
	"./packages/natives/native/index.js",
	"./packages/tui/src/index.ts",
	"./packages/utils/src/index.ts",
	"./packages/coding-agent/src/extensibility/typebox.ts",
	"./packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts",
	"./packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
];
