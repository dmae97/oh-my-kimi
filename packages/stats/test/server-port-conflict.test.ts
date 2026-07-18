import { afterEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { STATS_DASHBOARD_HEADER } from "../src/port-conflict";
import { startServer } from "../src/server";

const holderProcesses: Array<Subprocess<"ignore", "pipe", "pipe">> = [];

async function startBunHolder(responseExpr: string) {
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = reservation.port;
	reservation.stop(true);

	const source = `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => ${responseExpr} }); process.stdout.write("ready"); await Promise.withResolvers().promise;`;
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
	it("reuses a live stats dashboard identified by its header", async () => {
		const existing = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/api/stats/models"
					? Response.json([], { headers: { [STATS_DASHBOARD_HEADER]: "1" } })
					: new Response("dashboard"),
		});

		try {
			const server = await startServer(existing.port);
			expect(server.port).toBe(existing.port);
			server.stop();

			// The foreign server is untouched: it still answers on the port.
			const response = await fetch(`http://127.0.0.1:${existing.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe("1");
			await response.body?.cancel();
		} finally {
			existing.stop(true);
		}
	});

	it("does not reuse a foreign 200 responder and reclaims the port instead", async () => {
		// An SPA dev server catch-all: 200 JSON, but no dashboard header and not
		// the models array shape. Must not be treated as a reusable dashboard.
		const holder = await startBunHolder('Response.json({ app: "spa" })');
		const server = await startServer(holder.port);

		try {
			expect(server.port).toBe(holder.port);
			expect(await holder.child.exited).not.toBe(0);
			const response = await fetch(`http://127.0.0.1:${holder.port}/api/stats/models`);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe("1");
			await response.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("reclaims an unresponsive Bun listener and starts the dashboard", async () => {
		const holder = await startBunHolder('new Response("holder", { status: 404 })');
		const server = await startServer(holder.port);

		try {
			expect(server.port).toBe(holder.port);
			expect(await holder.child.exited).not.toBe(0);
		} finally {
			server.stop();
		}
	});
});
