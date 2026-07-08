import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildNonInteractiveEnv } from "@oh-my-pi/pi-coding-agent/exec/non-interactive-env";

describe("buildNonInteractiveEnv", () => {
	it("defaults Windows child-process encoding to UTF-8 when inherited env is unset", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "win32");

		expect(env.PYTHONIOENCODING).toBe("utf-8");
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	it("preserves inherited Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { PYTHONUTF8: "0", LANG: "de_DE.UTF-8" }, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("preserves per-command Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv({ PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8" }, {}, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBe("0");
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBe("en_US.UTF-8");
	});

	it("preserves inherited Windows LC category locales as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { LC_CTYPE: "en_US.UTF-8" }, "win32");

		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not force UTF-8 encoding defaults on non-Windows platforms", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});
});

it("keeps launch .env.local values out of child shell config", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-local-"));
	try {
		await Bun.write(
			path.join(tmp, ".env.local"),
			"CONVEX_DEPLOYMENT=anonymous:root-local\nCONVEX_URL=http://127.0.0.1:3210\n",
		);
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = [
			`import { getShellConfig } from ${JSON.stringify(procmgrPath)};`,
			"const env = getShellConfig().env;",
			"console.log(JSON.stringify({",
			"	deployment: env.CONVEX_DEPLOYMENT ?? null,",
			"	url: env.CONVEX_URL ?? null,",
			"	inherited: env.OMP_TEST_INHERITED_MARKER ?? null,",
			"}));",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "--no-install", "--eval", script], {
			cwd: tmp,
			env: {
				HOME: process.env.HOME ?? "",
				OMP_TEST_INHERITED_MARKER: "keep-me",
				PATH: process.env.PATH ?? "",
				SHELL: process.env.SHELL ?? "/bin/bash",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		const payload: {
			deployment: string | null;
			url: string | null;
			inherited: string | null;
		} = JSON.parse(stdout);
		expect(payload).toEqual({
			deployment: null,
			url: null,
			inherited: "keep-me",
		});
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});
