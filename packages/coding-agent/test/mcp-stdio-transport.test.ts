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

			expect(result.cmd).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", `"${shim}" "serve" "--mcp"`]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves non-Windows commands untouched", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
			{ cwd: "/", env: {}, platform: "linux" },
		);

		expect(result.cmd).toEqual(["codegraph", "serve", "--mcp"]);
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
// exits between the `initialize` response and the `notifications/initialized`
// send. Contract defended here:
//
//   1. notify() always settles — no unhandled rejection ever escapes when
//      the underlying FileSink throws synchronously.
//   2. A failed write tears the transport down (`onClose` fires) AND surfaces
//      a rejection to the caller so `initializeConnection()` doesn't return a
//      "connected" handle wrapping a dead transport.
//
// On Linux, Bun's FileSink absorbs the EPIPE so the only failure surfaced is
// the "Transport not connected" guard on subsequent calls; on Windows the
// write actually throws. Either way the tracker must stay empty.
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

	it("does not surface unhandled rejections when the subprocess exits mid-handshake", async () => {
		// Subprocess that responds to a single line on stdin, echoes a stock
		// initialize response, then exits. Mirrors the real-world MCP server
		// that crashes between the initialize response and the
		// notifications/initialized that the client sends right after.
		const script = [
			'let buf = "";',
			'process.stdin.on("data", (chunk) => {',
			"  buf += chunk;",
			'  const nl = buf.indexOf("\\n");',
			"  if (nl < 0) return;",
			"  const line = buf.slice(0, nl);",
			"  const msg = JSON.parse(line);",
			"  process.stdout.write(",
			'    JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n",',
			"  );",
			"  process.exit(0);",
			"});",
		].join("\n");

		const tracker = trackUnhandled();
		transport = new StdioTransport({ type: "stdio", command: "bun", args: ["-e", script] });
		let closed = false;
		transport.onClose = () => {
			closed = true;
		};

		try {
			await transport.connect();
			await transport.request("initialize", {});
			// Fire several notifies — covers both the "subprocess just exited"
			// race (write may fail) and the "already torn down" guard path
			// (subsequent calls reject with `Transport not connected`). Every
			// rejection is handled here; the contract under test is that none
			// of them leak as an unhandled rejection.
			for (let i = 0; i < 5; i++) {
				await transport.notify("notifications/initialized").catch(() => {});
			}

			// Let any deferred microtasks settle so an escaped rejection has
			// a chance to fire `unhandledRejection` before we assert.
			await Bun.sleep(50);

			expect(tracker.capture()).toEqual([]);
			expect(closed).toBe(true);
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
