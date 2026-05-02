/**
 * Regression test for issue #905.
 *
 * `omp --list-models` did not include providers contributed by extensions
 * (via `pi.registerProvider(...)`), regardless of whether the extension was
 * supplied via `-e <path>` or configured under `extensions:` in the user
 * settings. The `--list-models` short-circuit in `runRootCommand` exited
 * before extensions were loaded.
 *
 * Contract under test: the public list-models entry point loads extensions
 * (CLI `-e` paths and configured `settings.extensions`) before listing, so
 * extension-registered providers/models appear in the output.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { runListModelsCommand } from "../src/cli/list-models";
import { ModelRegistry } from "../src/config/model-registry";

let tmp: string;
let extPath: string;
let dbPath: string;

beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "issue-905-"));
	extPath = path.join(tmp, "ext.ts");
	dbPath = path.join(tmp, "auth.db");
	await fs.writeFile(
		extPath,
		`export default function (pi) {
	pi.registerProvider("test-gw", {
		baseUrl: "https://example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

test("--list-models surfaces extension-registered providers (issue #905)", async () => {
	const authStorage = await AuthStorage.create(dbPath);
	const modelRegistry = new ModelRegistry(authStorage);

	const captured: string[] = [];
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;

	try {
		await runListModelsCommand({
			modelRegistry,
			cwd: tmp,
			additionalExtensionPaths: [extPath],
			disableExtensionDiscovery: true,
		});
	} finally {
		process.stdout.write = originalWrite;
	}

	const output = captured.join("");
	expect(output).toContain("test-gw");
	expect(output).toContain("test-model");
});
