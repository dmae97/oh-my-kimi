import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

type RequestLine = {
	id?: unknown;
	method?: unknown;
	params?: unknown;
	jsonrpc?: unknown;
};

async function withSocketServer(
	handleLine: (line: string, socket: net.Socket) => void,
	run: (socketPath: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "cmux-browser-test-"));
	const socketPath = join(dir, "cmux.sock");
	const server = net.createServer(socket => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", chunk => {
			buffer += String(chunk);
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				handleLine(line, socket);
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	try {
		await run(socketPath);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
}

describe("CmuxSocketClient", () => {
	it("authenticates, frames JSON requests, and returns the result", async () => {
		const lines: string[] = [];
		const requests: RequestLine[] = [];

		await withSocketServer(
			(line, socket) => {
				lines.push(line);
				if (line.startsWith("auth ")) {
					socket.write("OK\n");
					return;
				}
				const request = JSON.parse(line) as RequestLine;
				requests.push(request);
				socket.write(`${JSON.stringify({ ok: true, result: { echoed: request.params } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({ socketPath, password: "secret" });
				try {
					const result = await client.request("browser.navigate", {
						surface_id: "surface-1",
						url: "https://example.com",
					});

					expect(result).toEqual({
						echoed: { surface_id: "surface-1", url: "https://example.com" },
					});
					expect(lines[0]).toBe("auth secret");
					expect(requests).toHaveLength(1);
					expect(requests[0]?.id).toEqual(expect.any(String));
					expect(requests[0]?.method).toBe("browser.navigate");
					expect(requests[0]?.params).toEqual({
						surface_id: "surface-1",
						url: "https://example.com",
					});
					expect(requests[0]).not.toHaveProperty("jsonrpc");
				} finally {
					client.close();
				}
			},
		);
	});

	it("throws ToolError for ok:false not_supported responses", async () => {
		await withSocketServer(
			(_line, socket) => {
				socket.write(`${JSON.stringify({ ok: false, error: { code: "not_supported", message: "x" } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({ socketPath });
				try {
					await client.request("browser.drag", {});
					throw new Error("Expected cmux request to fail");
				} catch (error) {
					expect(error).toBeInstanceOf(ToolError);
					expect(error).toHaveProperty("message", "not_supported: x");
				} finally {
					client.close();
				}
			},
		);
	});

	it("serializes sequential requests on one socket", async () => {
		const seenMethods: string[] = [];
		let pendingFirstResponse: (() => void) | undefined;
		const firstRequestSeen = Promise.withResolvers<void>();

		await withSocketServer(
			(line, socket) => {
				const request = JSON.parse(line) as RequestLine;
				seenMethods.push(String(request.method));
				if (request.method === "first") {
					firstRequestSeen.resolve();
					pendingFirstResponse = () => {
						socket.write(`${JSON.stringify({ ok: true, result: { index: 1 } })}\n`);
					};
					return;
				}
				socket.write(`${JSON.stringify({ ok: true, result: { index: 2 } })}\n`);
			},
			async socketPath => {
				const client = new CmuxSocketClient({ socketPath });
				try {
					const first = client.request("first", {});
					const second = client.request("second", {});
					await firstRequestSeen.promise;
					expect(seenMethods).toEqual(["first"]);
					pendingFirstResponse?.();
					expect(await first).toEqual({ index: 1 });
					expect(await second).toEqual({ index: 2 });
					expect(seenMethods).toEqual(["first", "second"]);
				} finally {
					client.close();
				}
			},
		);
	});
});
