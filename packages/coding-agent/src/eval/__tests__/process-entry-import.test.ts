import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("imports the JS process entry without loading dotenv before profile bootstrap", async () => {
	using tempDir = TempDir.createSync("@omp-js-process-import-");
	await Bun.write(path.join(tempDir.path(), ".env"), "OMP_PROCESS_ENTRY_ENV_PROBE=loaded-too-early\n");
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	delete env.OMP_PROCESS_ENTRY_ENV_PROBE;
	env.HOME = tempDir.path();
	const fixture = path.resolve(import.meta.dir, "../../../test/fixtures/js-process-entry-import.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode).toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toBe("");
});
