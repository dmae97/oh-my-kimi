import { afterEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { STATS_DASHBOARD_HEADER } from "../src/port-conflict";
import { startServer } from "../src/server";

const holderProcesses: Array<Subprocess<"ignore", "pipe", "pipe">> = [];

async function startBunHolder(responseExpr: string, options?: { statsOwned?: boolean }) {
	// Bind the wildcard address: `startServer` binds the wildcard too, and on
	// macOS SO_REUSEADDR lets a wildcard bind coexist with a 127.0.0.1-only
	// listener, which would bypass the EADDRINUSE path this suite exercises.
	const reservation = Bun.serve({
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = reservation.port;
	reservation.stop(true);

	const source = `Bun.serve({ port: ${port}, fetch: () => ${responseExpr} }); process.stdout.write("ready"); await Promise.withResolvers().promise;`;
	const args = [process.execPath, "-e", source];
	if (options?.statsOwned) args.push("omp-stats");
	const child = Bun.spawn(args, {
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

			// The existing dashboard is untouched: it still answers on the port.
			const response = await fetch(`http://127.0.0.1:${existing.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe("1");
			await response.body?.cancel();
		} finally {
			existing.stop(true);
		}
	});

	it("refuses to stop a foreign 200 responder", async () => {
		const holder = await startBunHolder('Response.json({ app: "spa" })');

		await expect(startServer(holder.port)).rejects.toThrow("not identifiable as an omp stats dashboard");
		expect(holder.child.exitCode).toBeNull();
		const response = await fetch(`http://127.0.0.1:${holder.port}/api/stats/models`);
		expect(await response.json()).toEqual({ app: "spa" });
	});

	it("refuses to stop an unrelated Bun listener that fails the probe", async () => {
		const holder = await startBunHolder('new Response("foreign", { status: 404 })');

		await expect(startServer(holder.port)).rejects.toThrow("not identifiable as an omp stats dashboard");
		expect(holder.child.exitCode).toBeNull();
	});

	it("reclaims an unresponsive confirmed stats listener", async () => {
		const holder = await startBunHolder('new Response("holder", { status: 404 })', { statsOwned: true });
		const server = await startServer(holder.port);

		try {
			expect(server.port).toBe(holder.port);
			expect(await holder.child.exited).not.toBe(0);
		} finally {
			server.stop();
		}
	});
});
