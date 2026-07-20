/**
 * Codex hook discovery (`packages/coding-agent/src/discovery/codex.ts`) walks
 * `~/.codex/hooks/*.{ts,js}` flatly. Before #3680 it defaulted every untyped
 * filename to a `pre:<basename>` hook, and `discoverExtensionPaths` then
 * imported those scripts as extension factories — a top-level `process.exit()`
 * in any stranger script (Codex hook scripts, scratch files, …) killed OMP
 * during startup. These tests pin the new behavior: only `pre-*` / `post-*`
 * prefixed files are surfaced; everything else is silently skipped.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("codex hook discovery", () => {
	let tempHome = "";
	let tempCwd = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-hooks-home-"));
		tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-hooks-cwd-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		const settings = await Settings.init({ inMemory: true, cwd: tempCwd });
		initializeWithSettings(settings);
		await fs.mkdir(path.join(tempHome, ".codex", "hooks"), { recursive: true });
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(tempCwd);
	});

	const codexHook = (name: string, body = "export default function (api) {}\n"): Promise<void> =>
		fs.writeFile(path.join(tempHome, ".codex", "hooks", name), body);

	const codexHooks = async (): Promise<Hook[]> => {
		const result = await loadCapability<Hook>(hookCapability.id, {
			cwd: tempCwd,
			providers: ["codex"],
		});
		return result.items;
	};

	test("registers pre-* and post-* prefixed scripts with the parsed type and tool", async () => {
		await codexHook("pre-bash.ts");
		await codexHook("post-write.js");

		const items = await codexHooks();
		const summary = items
			.map(h => ({ name: h.name, type: h.type, tool: h.tool }))
			.sort((a, b) => a.name.localeCompare(b.name));

		expect(summary).toEqual([
			{ name: "post-write.js", type: "post", tool: "write" },
			{ name: "pre-bash.ts", type: "pre", tool: "bash" },
		]);
	});

	test("skips untyped Codex hook scripts so they never reach the extension loader (#3680)", async () => {
		// The reporter's scripts (memory-bank-reminder.ts, skill-activation-prompt.ts)
		// and the minimal repro (process.exit at module scope) live alongside any
		// OMP-shaped pre-*/post-* files but do not match the prefix.
		await codexHook("repro.ts", "process.exit(0)\n");
		await codexHook("memory-bank-reminder.ts");
		await codexHook("skill-activation-prompt.ts");
		await codexHook("pre-bash.ts");

		const items = await codexHooks();
		expect(items.map(h => h.name)).toEqual(["pre-bash.ts"]);
	});

	test("returns nothing when the codex hooks directory is empty", async () => {
		const items = await codexHooks();
		expect(items).toEqual([]);
	});
});
