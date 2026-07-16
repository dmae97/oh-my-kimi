import { describe, expect, it } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

const childFlag = "--stdio-epipe-child";
const raceChildFlag = "--stdio-epipe-race-child";
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
} else if (process.argv.includes(raceChildFlag)) {
	const marker = process.argv[process.argv.indexOf(raceChildFlag) + 1];
	if (!marker) throw new Error("Missing cleanup marker path");
	let cleanupComplete = false;
	let exitAttempted = false;
	const exit = process.exit;
	process.exit = ((code?: number) => {
		if (!exitAttempted) {
			exitAttempted = true;
			void Bun.write(marker, cleanupComplete ? "after cleanup" : "before cleanup").then(() => exit(code));
		}
		return undefined as never;
	}) as typeof process.exit;
	postmortem.registerStdioDisconnectHandling();
	postmortem.register("stdio-epipe-race-test", async () => {
		process.stderr.write("cleanup started\n");
		void Promise.reject(Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "write" }));
		await new Response(Bun.stdin.stream()).text();
		cleanupComplete = true;
	});
	let rejectionCount = 0;
	process.on("unhandledRejection", () => {
		if (++rejectionCount === 2) process.stderr.write("second rejection observed\n");
	});
	void Promise.reject(Object.assign(new Error("broken pipe"), { code: "EPIPE", syscall: "write" }));
	await new Promise<void>(() => {});
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
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "send" }))).toBe(true);
		expect(postmortem.isIpcSendEpipe(makeErr({ code: "EPIPE", syscall: "write" }))).toBe(false);
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

	it("keeps waiting for active cleanup when another stdio EPIPE arrives", async () => {
		const marker = `/tmp/omp-postmortem-stdio-race-${process.pid}-${Date.now()}`;
		const child = Bun.spawn([process.execPath, import.meta.path, raceChildFlag, marker], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const decoder = new TextDecoder();
			const stderrReader = child.stderr.getReader();
			let stderr = "";
			while (!stderr.includes("second rejection observed\n")) {
				const chunk = await stderrReader.read();
				if (chunk.done) throw new Error("Child exited before observing the second rejection");
				stderr += decoder.decode(chunk.value);
			}
			stderrReader.releaseLock();
			expect(stderr).toContain("cleanup started\n");
			child.stdin.end();
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(stdout).toBe("");
			expect(exitCode).toBe(0);
			expect(await Bun.file(marker).text()).toBe("after cleanup");
		} finally {
			try {
				child.stdin.end();
			} catch {
				// Already closed after completing teardown.
			}
			await child.exited;
			await Bun.file(marker)
				.delete()
				.catch(() => {});
		}
	});
});
