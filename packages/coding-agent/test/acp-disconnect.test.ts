import { describe, expect, it } from "bun:test";
import { runAcpMode } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-mode";
import { postmortem } from "@oh-my-pi/pi-utils";

const childFlag = "--acp-eof-child";
const childFlagIndex = process.argv.indexOf(childFlag);
if (childFlagIndex >= 0) {
	const marker = process.argv[childFlagIndex + 1];
	if (!marker) throw new Error("Missing cleanup marker path");
	const releaseCleanup = Promise.withResolvers<void>();
	process.once("SIGUSR2", releaseCleanup.resolve);
	postmortem.register("acp-eof-test", async () => {
		process.stderr.write("cleanup started\n");
		await releaseCleanup.promise;
		await Bun.write(marker, "cleanup complete");
	});
	await runAcpMode(async () => {
		throw new Error("Session factory is unused by the EOF harness");
	});
}

describe("ACP stdio disconnect", () => {
	it("awaits postmortem cleanup before exiting on client EOF", async () => {
		const marker = `/tmp/omp-acp-eof-${process.pid}-${Date.now()}`;
		const child = Bun.spawn([process.execPath, import.meta.path, childFlag, marker], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			child.stdin.end();
			const stderrReader = child.stderr.getReader();
			const started = await stderrReader.read();
			stderrReader.releaseLock();
			expect(new TextDecoder().decode(started.value)).toBe("cleanup started\n");
			child.kill("SIGUSR2");
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(stdout).toBe("");
			expect(exitCode).toBe(0);
			expect(await Bun.file(marker).text()).toBe("cleanup complete");
		} finally {
			try {
				child.kill("SIGUSR2");
			} catch {
				// Already exited after completing teardown.
			}
			await child.exited;
			await Bun.file(marker)
				.delete()
				.catch(() => {});
		}
	});
});
