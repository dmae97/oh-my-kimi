#!/usr/bin/env bun
/**
 * Dev harness: runs the Bun API server (auto-restarting on server edits via
 * `--watch`) and a Vite dev server (React Fast Refresh for the dashboard)
 * together, tearing both down on one Ctrl-C. Vite proxies `/api` to the API
 * server; the shared port travels through `HARBOR_API_PORT`.
 *
 * Extra args pass through to the API server:
 *   bun run dev -- --port 4700 --jobs-dir ../../runs/harbor
 *
 * Vite runs under Node (its bin shebang), the API under Bun; only the frontend
 * hot-reloads in place, while server-side changes trigger a fast `--watch` restart.
 */
const args = Bun.argv.slice(2);
const portIndex = args.indexOf("--port");
const apiPort = portIndex >= 0 ? (args[portIndex + 1] ?? "4700") : "4700";
process.env.HARBOR_API_PORT = apiPort;

const io = { stdout: "inherit", stderr: "inherit", stdin: "inherit", env: { ...process.env } } as const;
const api = Bun.spawn(["bun", "--watch", "src/server.ts", ...args], io);
const web = Bun.spawn(["vite"], io);

let stopping = false;
const stop = (): void => {
	if (stopping) return;
	stopping = true;
	try {
		api.kill();
	} catch {}
	try {
		web.kill();
	} catch {}
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race([api.exited, web.exited]);
stop();
process.exit(0);
