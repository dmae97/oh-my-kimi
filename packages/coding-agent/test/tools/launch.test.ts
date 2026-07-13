import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { registerDaemonProjectPresence } from "../../src/launch/presence";
import type { DaemonSpec } from "../../src/launch/protocol";

const cleanupDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

// Cross-process integration: fake timers cannot advance a detached broker or OS process table.
async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(50);
	}
	return condition();
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// A last-client shutdown may already have closed the broker.
	}
	client.close();
}

afterEach(async () => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("daemon broker", () => {
	it("shares PTY output and input across project clients", async () => {
		const projectDir = await tempDir("omp-daemon-project-");
		const runtimeDir = await tempDir("omp-daemon-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("READY\\n");
process.stdin.on("data", chunk => process.stdout.write("INPUT:" + JSON.stringify(chunk) + "\\n"));
setInterval(() => {}, 1000);
`,
		);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "debugger",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: true,
				ready: { log: "READY", timeoutMs: 5_000 },
				restart: "no",
				persist: false,
				detached: false,
			};
			const started = await first.request({ op: "start", spec, owner: "first-client" });
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();
			expect(started.daemon.state).toBe("ready");

			const listed = await second.request({ op: "list" });
			expect(listed.op).toBe("list");
			if (listed.op !== "list") throw new Error("unexpected list result");
			expect(listed.daemons.map(daemon => daemon.name)).toEqual(["debugger"]);

			await second.request({ op: "send", name: "debugger", data: "run\r" });
			const waited = await first.request({
				op: "wait",
				name: "debugger",
				for: "exit",
				pattern: "INPUT",
				timeoutMs: 3_000,
			});
			expect(waited.op).toBe("wait");
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.timedOut).toBeFalse();
			expect(waited.matched).toBe("INPUT");

			const logs = await second.request({
				op: "logs",
				name: "debugger",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			expect(logs.op).toBe("logs");
			if (logs.op !== "logs") throw new Error("unexpected logs result");
			expect(logs.text).toContain("READY");
			expect(logs.text).toContain('INPUT:"run\\r"');

			const stopped = await first.request({ op: "stop", name: "debugger", timeoutMs: 2_000 });
			expect(stopped.op).toBe("stop");
			if (stopped.op !== "stop") throw new Error("unexpected stop result");
			expect(stopped.daemon.state).toBe("exited");
		} finally {
			await shutdown(first);
			second.close();
		}
	}, 20_000);

	it("stops non-persistent daemons after the last project omp exits", async () => {
		const projectDir = await tempDir("omp-daemon-exit-project-");
		const runtimeDir = await tempDir("omp-daemon-exit-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdout.write("READY\\n"); setInterval(() => {}, 1000);\n`);
		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 200 });
		let pid: number | undefined;
		try {
			const started = await first.request({
				op: "start",
				spec: {
					name: "server",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("daemon did not start");
			const daemonPid = started.daemon.pid;
			pid = daemonPid;
			await second.request({ op: "list" });

			first.close();
			second.close();
			// Cross-process integration: the real broker grace clock cannot be advanced with test fake timers.
			await Bun.sleep(500);
			expect(processExists(daemonPid)).toBeTrue();

			await presence.close();
			const stopped = await waitUntil(() => !processExists(daemonPid), 5_000);
			const socketRemoved = await waitUntil(
				() =>
					Bun.file(path.join(runtimeDir, "broker.sock"))
						.exists()
						.then(exists => !exists),
				5_000,
			);
			expect(stopped).toBeTrue();
			expect(socketRemoved).toBeTrue();
		} finally {
			first.close();
			second.close();
			await presence.close();
			if (pid !== undefined && processExists(pid)) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
				await shutdown(rescue);
			}
		}
	}, 20_000);

	it("keeps detached daemons alive through broker replacement", async () => {
		const projectDir = await tempDir("omp-daemon-detached-project-");
		const runtimeDir = await tempDir("omp-daemon-detached-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdout.write("READY\\n"); setInterval(() => {}, 1000);\n`);
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		let recovered: DaemonBrokerClient | undefined;
		let pid: number | undefined;
		try {
			const started = await first.request({
				op: "start",
				spec: {
					name: "detached",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: true,
				},
			});
			if (started.op !== "start" || started.daemon.pid === undefined)
				throw new Error("detached daemon did not start");
			pid = started.daemon.pid;
			expect(started.daemon.persist).toBeTrue();
			expect(started.daemon.detached).toBeTrue();

			await first.request({ op: "shutdown" });
			first.close();
			// Broker shutdown happens in another process, so fake timers cannot observe its lease release.
			const brokerStopped = await waitUntil(
				() =>
					Bun.file(path.join(runtimeDir, "broker.pid"))
						.exists()
						.then(exists => !exists),
				5_000,
			);
			expect(brokerStopped).toBeTrue();
			expect(processExists(pid)).toBeTrue();

			recovered = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const described = await recovered.request({ op: "describe", name: "detached" });
			if (described.op !== "describe") throw new Error("detached daemon did not recover");
			expect(described.daemon.pid).toBe(pid);
			expect(described.daemon.detached).toBeTrue();
			expect(described.spec.persist).toBeTrue();

			const stopped = await recovered.request({ op: "stop", name: "detached", timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error("detached daemon did not stop");
			expect(stopped.daemon.state).toBe("exited");
			await shutdown(recovered);
			recovered = undefined;
		} finally {
			first.close();
			recovered?.close();
			if (pid !== undefined && processExists(pid)) {
				const rescue = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
				try {
					await rescue.request({ op: "stop", name: "detached", timeoutMs: 2_000 });
				} finally {
					await shutdown(rescue);
				}
			}
		}
	}, 20_000);

	// Regression: a start whose log pattern matched but whose port never accepted
	// used to report "Ready: <match>" AND "Readiness timed out" with no hint of
	// which condition failed. The snapshot now names the unmet condition(s).
	it("names the unmet readiness condition when start times out", async () => {
		const projectDir = await tempDir("omp-daemon-ready-project-");
		const runtimeDir = await tempDir("omp-daemon-ready-runtime-");
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, `process.stdout.write("LISTENING\\n"); setInterval(() => {}, 1000);\n`);
		// Reserve an ephemeral port and release it so nothing accepts connections there.
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const deadPort = probe.port;
		probe.stop(true);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		try {
			const spec: DaemonSpec = {
				name: "never-ready",
				application: process.execPath,
				args: [scriptPath],
				env: {},
				cwd: projectDir,
				pty: false,
				ready: { log: "LISTENING", port: deadPort, timeoutMs: 3_000 },
				restart: "no",
				persist: false,
				detached: false,
			};
			const started = await client.request({ op: "start", spec });
			expect(started.op).toBe("start");
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeTrue();
			expect(started.daemon.state).toBe("starting");
			expect(started.daemon.readyMatch).toBe("LISTENING");
			expect(started.daemon.readyPending).toEqual(["port"]);

			const stopped = await client.request({ op: "stop", name: "never-ready", timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error("unexpected stop result");
			// Terminal states carry no stale readiness noise.
			expect(stopped.daemon.readyPending).toBeUndefined();
		} finally {
			await shutdown(client);
		}
	}, 20_000);
});
