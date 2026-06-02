import { afterEach, describe, expect, it } from "bun:test";
import { StdioTransport, writeFrame } from "../src/mcp/transports/stdio";

// ---------------------------------------------------------------------------
// writeFrame — the seam that swallows synchronous FileSink failures so the
// async `notify` / `#sendResponse` paths can never leak unhandled rejections
// when an MCP subprocess exits between read-loop ticks. See issue #1710.
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
});

// ---------------------------------------------------------------------------
// StdioTransport.notify — guards and end-to-end behavior with a real
// subprocess that exits between the `initialize` response and the
// `notifications/initialized` send. The harness can't directly reproduce the
// Windows EPIPE on Linux (Bun's FileSink absorbs it), but the contract we
// defend is platform-independent: no unhandled rejection ever escapes
// notify(), even when the read loop hasn't yet flipped #connected.
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
			// race and the "already torn down" guard path. None may yield an
			// unhandled rejection.
			for (let i = 0; i < 5; i++) {
				await transport.notify("notifications/initialized").catch(err => {
					// Re-throwing "Transport not connected" is fine (handled).
					if (!(err instanceof Error) || err.message !== "Transport not connected") {
						throw err;
					}
				});
			}

			// Let any deferred microtasks settle.
			await Bun.sleep(50);

			expect(tracker.capture()).toEqual([]);
			expect(closed).toBe(true);
		} finally {
			tracker.release();
		}
	});
});
