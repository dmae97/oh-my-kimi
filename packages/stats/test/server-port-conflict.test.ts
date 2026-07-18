import { afterEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { startServer } from "../src/server";

const holderProcesses: Array<Subprocess<"ignore", "pipe", "pipe">> = [];

async function startBunHolder(status: number) {
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = reservation.port;
	reservation.stop(true);

	const source = `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("holder", { status: ${status} }) }); process.stdout.write("ready"); await Promise.withResolvers().promise;`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	holderProcesses.push(child);

	const reader = child.stdout.getReader();
	const ready = await reader.read();
	reader.releaseLock();
	if (!ready.done && new TextDecoder().decode(ready.value) === "ready") {
		return { child, port };
	}

	await child.exited;
	const stderr = await new Response(child.stderr).text();
	throw new Error(`Holder failed to listen on port ${port}: ${stderr}`);
}

afterEach(async () => {
	for (const child of holderProcesses) {
		child.kill();
		await child.exited;
	}
	holderProcesses.length = 0;
});

describe("startServer port conflicts", () => {
	it("reuses a live stats dashboard without stopping it", async () => {
		const existing = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/api/stats/models" ? Response.json([]) : new Response("dashboard"),
		});

		try {
			const server = await startServer(existing.port);
			expect(server.port).toBe(existing.port);
			server.stop();

			const response = await fetch(`http://127.0.0.1:${existing.port}/api/stats/models`);
			expect(response.status).toBe(200);
			await response.body?.cancel();
		} finally {
			existing.stop(true);
		}
	});

	it("reclaims an unresponsive Bun listener and starts the dashboard", async () => {
		const holder = await startBunHolder(404);
		const server = await startServer(holder.port);

		try {
			expect(server.port).toBe(holder.port);
			expect(await holder.child.exited).not.toBe(0);
		} finally {
			server.stop();
		}
	});
});
