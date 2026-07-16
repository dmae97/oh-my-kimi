import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

const childFlag = "--stdio-epipe-child";
const childFlagIndex = process.argv.indexOf(childFlag);
if (childFlagIndex >= 0) {
	const marker = process.argv[childFlagIndex + 1];
	if (!marker) throw new Error("Missing cleanup marker path");
	postmortem.registerStdioDisconnectHandling();
	postmortem.register("stdio-epipe-test", async () => {
		process.stderr.write("cleanup started\n");
		await new Response(Bun.stdin.stream()).text();
		await Bun.write(marker, "cleanup complete");
	});
	const err = Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "write" });
	void Promise.reject(err);
	const keepAlive = Promise.withResolvers<void>();
	await keepAlive.promise;
}

describe("postmortem broken-pipe handling", () => {
	function makeErr(props: { code?: string; syscall?: string; message?: string }): Error {
		const err = new Error(props.message ?? "broken pipe");
		Object.assign(err, { code: props.code, syscall: props.syscall });
		return err;
	}

	it("classifies worker IPC and stdio EPIPE errors", () => {
		expect(postmortem.classifyBrokenPipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe("ipc-send");
		expect(postmortem.classifyBrokenPipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe("stdio-write");
	});

	it("does not classify unrelated errors as recoverable broken pipes", () => {
		expect(postmortem.classifyBrokenPipe(makeErr({ code: "EPIPE" }))).toBeUndefined();
		expect(postmortem.classifyBrokenPipe(makeErr({ code: "ENOENT", syscall: "send" }))).toBeUndefined();
		expect(postmortem.classifyBrokenPipe(new Error("boom"))).toBeUndefined();
		expect(postmortem.classifyBrokenPipe(makeErr({ code: undefined, syscall: undefined }))).toBeUndefined();
	});

	it("awaits cleanup and exits successfully when a registered stdio peer disconnects", async () => {
		const marker = `/tmp/omp-postmortem-stdio-${process.pid}-${Date.now()}`;
		const child = Bun.spawn([process.execPath, import.meta.path, childFlag, marker], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const stderrReader = child.stderr.getReader();
			const started = await stderrReader.read();
			stderrReader.releaseLock();
			expect(new TextDecoder().decode(started.value)).toBe("cleanup started\n");
			child.stdin.end();
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(stdout).toBe("");
			expect(exitCode).toBe(0);
			expect(await Bun.file(marker).text()).toBe("cleanup complete");
		} finally {
			try {
				child.stdin.end();
			} catch {
				// Already closed after the cleanup gate was released.
			}
			await child.exited;
			await Bun.file(marker)
				.delete()
				.catch(() => {});
		}
	});
});
