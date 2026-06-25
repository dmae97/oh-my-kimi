#!/usr/bin/env bun
/**
 * Issue #3423 end-to-end smoke driver. Compiles the legacy-pi compat path
 * into a tiny binary, runs it against a fixture extension, asserts the
 * extension's `@(scope)/pi-*` and `@sinclair/typebox` imports all resolve
 * through the bundled-virtual loader rather than the now-unreachable
 * `/$bunfs/...` filesystem paths.
 *
 * Usage: `bun scripts/smoke-3423.ts` from the repo root.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const driverFile = path.join(repoRoot, ".omp-smoke-3423", "main.ts");
const outFile = path.join(repoRoot, ".omp-smoke-3423", "smoke");

await fs.mkdir(path.dirname(driverFile), { recursive: true });

// `legacy-pi-bundled-registry` cascades through the coding-agent root which
// pulls in `export/html/tool-views.generated.js` (a build artifact). The
// full release build runs `packages/collab-web/scripts/build-tool-views.ts`
// to produce it; for the smoke we stub an empty file so the bundler can
// resolve the `with { type: "text" }` import.
const toolViewsPlaceholder = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"export",
	"html",
	"tool-views.generated.js",
);
const hadToolViews = await Bun.file(toolViewsPlaceholder)
	.exists()
	.catch(() => false);
if (!hadToolViews) {
	await Bun.write(toolViewsPlaceholder, "// smoke-3423 placeholder\n");
}

// pi-natives ships a platform-specific `.node` addon that lives outside the
// JS bundle; `embed:native` copies it next to the source so the bundler can
// pick it up. Without this step the compiled binary crashes at startup
// before the legacy-pi shim path is even exercised.
const embed = Bun.spawnSync(["bun", "--cwd=../natives", "run", "embed:native"], {
	cwd: path.join(repoRoot, "packages", "coding-agent"),
	stdout: "inherit",
	stderr: "inherit",
});
if (embed.exitCode !== 0) {
	throw new Error(`embed:native failed with exit code ${embed.exitCode}`);
}

const driver = `import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

installLegacyPiSpecifierShim();

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-3423-ext-"));
await fs.writeFile(
	path.join(dir, "package.json"),
	JSON.stringify({ name: "legacy-3423-ext", version: "1.0.0" }),
);
await fs.writeFile(
	path.join(dir, "index.ts"),
	[
		'import { VERSION, defineTool, Type } from "@earendil-works/pi-coding-agent";',
		'import { z } from "@mariozechner/pi-ai";',
		'import { Type as TbxType } from "@sinclair/typebox";',
		'import { logger } from "@oh-my-pi/pi-utils";',
		"const sample = defineTool({",
		'	name: "smoke",',
		'	label: "smoke",',
		'	description: "issue 3423 smoke",',
		"	parameters: Type.Object({}),",
		'	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
		"});",
		"export const probe = {",
		"	piCodingAgentVersion: VERSION,",
		"	zIsFunction: typeof z?.object === 'function',",
		"	tbxTypeIsObject: typeof TbxType === 'object',",
		"	loggerIsCallable: typeof logger?.info === 'function',",
		"	defineToolReturned: sample.name,",
		"};",
	].join("\\n"),
);

const mod = await loadLegacyPiModule(path.join(dir, "index.ts"));
console.log("PROBE", JSON.stringify(mod.probe));
console.log("OK");
`;

await fs.writeFile(driverFile, driver);

const build = Bun.spawnSync(
	[
		"bun",
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-tsconfig",
		"--no-compile-autoload-package-json",
		"--keep-names",
		"--define",
		'process.env.PI_COMPILED="true"',
		"--external",
		"fastembed",
		"--external",
		"onnxruntime-node",
		"--root",
		".",
		`./${path.relative(repoRoot, driverFile)}`,
		"--outfile",
		outFile,
	],
	{ cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) {
	throw new Error(`bun build --compile failed with exit code ${build.exitCode}`);
}

const run = Bun.spawnSync([outFile], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
const stdout = run.stdout.toString();
const stderr = run.stderr.toString();
console.log("--- driver stdout ---");
console.log(stdout);
if (stderr) {
	console.log("--- driver stderr ---");
	console.log(stderr);
}
if (run.exitCode !== 0) {
	throw new Error(`compiled smoke binary exited with code ${run.exitCode}`);
}

if (!stdout.includes("OK")) {
	throw new Error("driver did not print OK");
}
const probeMatch = stdout.match(/PROBE (\{.*\})/);
if (!probeMatch) {
	throw new Error("driver did not print PROBE payload");
}
const probe = JSON.parse(probeMatch[1]) as {
	piCodingAgentVersion: string;
	zIsFunction: boolean;
	tbxTypeIsObject: boolean;
	loggerIsCallable: boolean;
	defineToolReturned: string;
};
if (!probe.piCodingAgentVersion || !/^\d+\.\d+\.\d+/.test(probe.piCodingAgentVersion)) {
	throw new Error(`pi-coding-agent VERSION not exposed: ${probe.piCodingAgentVersion}`);
}
if (!probe.zIsFunction) {
	throw new Error("pi-ai z.object missing — shim did not re-export canonical surface");
}
if (!probe.tbxTypeIsObject) {
	throw new Error("@sinclair/typebox Type missing — TypeBox shim did not load");
}
if (!probe.loggerIsCallable) {
	throw new Error("pi-utils logger.info missing — canonical bundled package not reachable");
}
if (probe.defineToolReturned !== "smoke") {
	throw new Error(`defineTool helper did not return the marked tool: ${probe.defineToolReturned}`);
}
console.log("issue #3423 smoke passed");

await fs.rm(path.dirname(driverFile), { recursive: true, force: true });
if (!hadToolViews) {
	await fs.rm(toolViewsPlaceholder, { force: true });
}
Bun.spawnSync(["bun", "--cwd=../natives", "run", "embed:native", "--reset"], {
	cwd: path.join(repoRoot, "packages", "coding-agent"),
	stdout: "inherit",
	stderr: "inherit",
});
