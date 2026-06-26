import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveStdioSpawnCommand, StdioTransport, writeFrame } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";

describe("resolveStdioSpawnCommand", () => {
	it("resolves bare Windows commands through PATHEXT and wraps .cmd shims with cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "serve" "--mcp""`,
			]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers a project-local .cmd shim over a same-named global one when no path segment is given", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cwd-"));
		const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-global-"));
		try {
			const localShim = path.join(projectDir, "server.cmd");
			const globalShim = path.join(globalDir, "server.cmd");
			await Bun.write(localShim, "@echo off\r\nrem local\r\n");
			await Bun.write(globalShim, "@echo off\r\nrem global\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "server.cmd", args: ["serve"] },
				{
					cwd: projectDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: globalDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `""${localShim}" "serve""`]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
			await fs.rm(globalDir, { recursive: true, force: true });
		}
	});

	it("launches npm .cmd shims through node so CodeGraph owns the stdio pipes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-codegraph-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			const entry = path.join(tempDir, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"GOTO start",
					":find_dp0",
					"SET dp0=%~dp0",
					"EXIT /b",
					":start",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\node.exe" (',
					'  SET "_prog=%dp0%\\node.exe"',
					") ELSE (",
					'  SET "_prog=node"',
					"  SET PATHEXT=%PATHEXT:;.JS;=;%",
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual(["node", entry, "serve", "--mcp"]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps non-node cmd-shim wrappers on the cmd.exe path instead of mislaunching them via node", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pyshim-"));
		try {
			const shim = path.join(tempDir, "pyserver.cmd");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\python.exe" (',
					'  SET "_prog=%dp0%\\python.exe"',
					") ELSE (",
					'  SET "_prog=python"',
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\pyserver\\cli.py" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "pyserver.cmd", args: ["serve"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `""${shim}" "serve""`]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("escapes percent-delimited args before routing .cmd shims through cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-percent-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--header", "Authorization=%TOKEN%"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "serve" "--header" "Authorization=^%TOKEN^%""`,
			]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("escapes quoted JSON args before routing .cmd shims through cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-quotes-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["--config", '{"a":"b&c|d"}'] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "--config" "{^"a^":^"b&c|d^"}""`,
			]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves extension-less absolute Windows paths to the sibling .cmd shim", async () => {
		// Mirrors npm's Windows shim layout: bare `codegraph` (shebang script),
		// `codegraph.cmd` (cmd.exe wrapper), and `codegraph.ps1` siblings under
		// %AppData%\Roaming\npm. uv_spawn rejects the extensionless script;
		// the resolver must promote the bare absolute path to its `.cmd`
		// sibling so the launch succeeds (see #2174). The test rig pins
		// PATHEXT to a single lowercase extension so the candidate filename
		// matches the file we create on the case-sensitive test host.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-abs-"));
		try {
			const bare = path.join(tempDir, "codegraph");
			const shim = `${bare}.cmd`;
			await Bun.write(bare, "#!/bin/sh\n");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: bare, args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/s",
				"/c",
				`""${shim}" "serve" "--mcp""`,
			]);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("wraps explicit Windows .cmd commands with cmd.exe while preserving quoted argv", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "C:\\Users\\me\\AppData\\Roaming\\npm",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/s",
			"/c",
			`""codegraph.cmd" "serve" "--mcp""`,
		]);
		expect(result.windowsHide).toBe(true);
		expect(result.detached).toBe(false);
	});

	it("routes unresolvable bare Windows commands through cmd.exe so PATHEXT can find a .cmd shim (#3250)", async () => {
		// Bun.spawn -> CreateProcess only appends `.exe` to extensionless names.
		// Commands shipped as `.cmd` shims (`npx`, `yarn`, most pnpm-installed
		// binaries on Windows) cannot be launched directly. When our PATH walk
		// finds nothing — empty PATH under a restricted parent, locked-down
		// shell, UNC mounts that reject `fs.access` — we must delegate to
		// cmd.exe so its native PATHEXT lookup runs. The legacy fallback
		// handed `Bun.spawn` the bare name and the subprocess died ~140ms
		// after spawn with ENOENT/EINVAL (issue #3250).
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "npx", args: ["-y", "cloakbrowser-mcp@latest"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/s",
			"/c",
			`""npx" "-y" "cloakbrowser-mcp@latest""`,
		]);
		expect(result.windowsHide).toBe(true);
		expect(result.detached).toBe(false);
	});

	it("leaves non-Windows commands untouched", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
			{ cwd: "/", env: {}, platform: "linux" },
		);

		expect(result.cmd).toEqual(["codegraph", "serve", "--mcp"]);
		expect(result.windowsHide).toBeUndefined();
		expect(result.detached).toBe(true);
	});

	it("never detaches Windows stdio launches so nested cmd.exe wrappers keep stdout routed back to the parent pipe (#3544)", async () => {
		// The reporter's failing shape is `cmd.exe` → `node wrapper` →
		// `cmd.exe /C npx.cmd -y mcp-remote`. Detaching the direct hidden
		// `cmd.exe` strips its inherited console; the nested console
		// grandchildren (`node`, `npx.cmd`, `mcp-remote`) then allocate a
		// brand-new visible conhost whose stdout no longer routes back through
		// our pipe — the proxy reports the bridge is up while OMP times out on
		// the MCP `initialize` response. `windowsHide` only hides the direct
		// child's window (#3536); the only fix that keeps the grandchild
		// attached to the same console session is `detached: false`. Pin every
		// Windows return shape here so the contract cannot regress for the
		// direct-`cmd.exe` launcher the reporter used.
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "cmd.exe", args: ["/C", "node .codex\\mcp-wrapper.js"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.detached).toBe(false);
		expect(result.windowsHide).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// writeFrame — the seam that catches synchronous FileSink throws AND neutralizes
// asynchronous (Promise) rejections, so the async `notify` / `#sendResponse` /
// `request` paths never let an un-awaited broken-pipe rejection escape as a fatal
// unhandled rejection. See issue #1710 and its async follow-up.
// ---------------------------------------------------------------------------

describe("writeFrame", () => {
	it("writes and flushes, returning true on success", () => {
		const sink = {
			writes: [] as string[],
			flushed: 0,
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, '{"k":1}\n')).toBe(true);
		expect(sink.writes).toEqual(['{"k":1}\n']);
		expect(sink.flushed).toBe(1);
	});

	it("returns false when write() throws synchronously (broken pipe)", () => {
		const sink = {
			flushed: 0,
			write() {
				throw new Error("EPIPE: broken pipe, write");
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.flushed).toBe(0);
	});

	it("returns false when flush() throws after a successful write", () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				throw new Error("EPIPE: broken pipe, flush");
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.writes).toEqual(["anything\n"]);
	});

	it("does not propagate non-Error throws either", () => {
		const sink = {
			write() {
				throw "string-thrown-non-error";
			},
			flush() {},
		};

		expect(writeFrame(sink, "x")).toBe(false);
	});

	it("returns true and neutralizes an asynchronous write rejection (broken pipe surfaced as a Promise)", async () => {
		const sink = {
			flushed: 0,
			write() {
				return Promise.reject(new Error("EPIPE: broken pipe, write"));
			},
			flush() {
				this.flushed++;
			},
		};

		const tracker = trackUnhandled();
		try {
			// No synchronous throw, so the frame is "accepted"; the async rejection
			// must be neutralized rather than escaping as an unhandled rejection.
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("returns true and neutralizes an asynchronous flush rejection", async () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				return Promise.reject(new Error("EPIPE: broken pipe, flush"));
			},
		};

		const tracker = trackUnhandled();
		try {
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.notify — end-to-end behavior against a real subprocess that
// exits before or while a notification is sent. Contract defended here:
//
//   1. notify() always settles — no unhandled rejection ever escapes when
//      the underlying FileSink observes a closed pipe.
//   2. A failed write tears the transport down (`onClose` fires) and surfaces
//      a rejection to the caller when the platform reports one synchronously.
//
// On platforms where the pipe accepts the write, read-loop EOF still closes the
// transport. The request/response parsing path is covered separately; this test
// intentionally avoids requiring subprocess stdout because Bun's test runner can
// hand stdout-writing child processes an unusable fd on some hosts.
// ---------------------------------------------------------------------------

function trackUnhandled(): { release: () => unknown[]; capture: () => unknown[] } {
	const seen: unknown[] = [];
	const listener = (reason: unknown) => {
		seen.push(reason);
	};
	process.on("unhandledRejection", listener);
	return {
		release: () => {
			process.off("unhandledRejection", listener);
			return seen.slice();
		},
		capture: () => seen.slice(),
	};
}

describe("StdioTransport.notify", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("rejects synchronously when called before connect()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("rejects with 'Transport not connected' after close()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		await transport.connect();
		await transport.close();

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("does not surface unhandled rejections when the subprocess exits before notify settles", async () => {
		const tracker = trackUnhandled();
		const closed = Promise.withResolvers<void>();
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});
		transport.onClose = () => {
			closed.resolve();
		};

		try {
			await transport.connect();
			const notify = transport.notify("notifications/initialized").catch((error: unknown) => {
				expect(error).toBeInstanceOf(Error);
			});

			await closed.promise;
			await notify;
			await Promise.resolve();

			expect(tracker.capture()).toEqual([]);
			expect(transport.connected).toBe(false);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.close — authoritative resource teardown that must keep
// cleaning up the subprocess and read loop even when `#handleClose()` has
// already flipped `#connected` (read-loop EOF, or a notify() write failure
// in the connectToServer() failure path). See PR #1711 follow-up.
//
// Bun's parent-side stdout reader only sees EOF when the subprocess
// actually exits, so the "subprocess closed its stdout but stayed alive"
// state we'd love to test directly cannot be reproduced through a real
// subprocess on this platform. Instead we exercise the post-handleClose
// code path via the natural read-loop-EOF route and pair it with explicit
// idempotency checks; the reviewer-flagged leak surfaces on Windows where
// the notify() write actually throws.
// ---------------------------------------------------------------------------

describe("StdioTransport.close", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("completes cleanup when called after the read loop has already torn down", async () => {
		// Subprocess exits cleanly; the read loop sees EOF and fires
		// `#handleClose()`, flipping `#connected` to false. `close()` then
		// runs in exactly the state the reviewer flagged — `#connected`
		// already false, `#process` and `#readLoop` still set — and must
		// still null them out instead of early-returning.
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();

		// Wait for the read loop to observe EOF and fire #handleClose.
		for (let i = 0; i < 100 && transport.connected; i++) {
			await Bun.sleep(10);
		}
		expect(transport.connected).toBe(false);
		expect(closeCount).toBe(1);

		// Must not throw and must not re-fire onClose.
		await transport.close();
		expect(closeCount).toBe(1);

		// Second close is a no-op too — every resource is already released.
		await transport.close();
		expect(closeCount).toBe(1);
	});

	it("is idempotent — repeat close() calls fire onClose exactly once", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();
		await transport.close();
		await transport.close();
		await transport.close();

		expect(closeCount).toBe(1);
		expect(transport.connected).toBe(false);
	});
});
