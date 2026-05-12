/**
 * HTTP loopback bridge that lets the Python kernel synchronously invoke
 * host-side tools by name, mirroring the JS worker's `tool.<name>(args)` proxy.
 *
 * The Python prelude builds a `tool` proxy that POSTs to `/v1/tool` over a
 * 127.0.0.1 loopback socket; the host resolves the request against the
 * `ToolSession` registered for the current execution and forwards to the same
 * `callSessionTool` implementation the JS bridge uses.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import { callSessionTool, type JsStatusEvent } from "../js/tool-bridge";

export interface PyToolBridgeEntry {
	toolSession: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface PyToolBridgeInfo {
	url: string;
	token: string;
}

interface BridgeServer {
	info: PyToolBridgeInfo;
	stop: () => Promise<void>;
}

const registrations = new Map<string, PyToolBridgeEntry>();
let serverPromise: Promise<BridgeServer> | null = null;

async function startServer(): Promise<BridgeServer> {
	const token = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method !== "POST" || url.pathname !== "/v1/tool") {
				return new Response("Not Found", { status: 404 });
			}
			if (req.headers.get("authorization") !== `Bearer ${token}`) {
				return new Response("Forbidden", { status: 403 });
			}

			let body: { session?: unknown; name?: unknown; args?: unknown };
			try {
				body = (await req.json()) as { session?: unknown; name?: unknown; args?: unknown };
			} catch {
				return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
			}
			const sessionId = typeof body.session === "string" ? body.session : "";
			const name = typeof body.name === "string" ? body.name : "";
			if (!sessionId || !name) {
				return Response.json({ ok: false, error: "Missing session/name" }, { status: 400 });
			}
			const entry = registrations.get(sessionId);
			if (!entry) {
				return Response.json(
					{ ok: false, error: `No active Python tool bridge session: ${sessionId}` },
					{ status: 200 },
				);
			}

			try {
				const value = await callSessionTool(name, body.args, {
					session: entry.toolSession,
					signal: entry.signal,
					emitStatus: entry.emitStatus,
				});
				return Response.json({ ok: true, value });
			} catch (err) {
				return Response.json({
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	});

	const info: PyToolBridgeInfo = {
		url: `http://${server.hostname}:${server.port}`,
		token,
	};
	logger.debug("Python tool bridge listening", { url: info.url });

	return {
		info,
		stop: async () => {
			await server.stop(true);
		},
	};
}

/** Starts the bridge server lazily and returns its connection info. */
export async function ensurePyToolBridge(): Promise<PyToolBridgeInfo> {
	if (!serverPromise) {
		serverPromise = startServer();
	}
	try {
		const server = await serverPromise;
		return server.info;
	} catch (err) {
		serverPromise = null;
		throw err;
	}
}

/**
 * Register a tool session for the duration of one execution. The returned
 * function MUST be called to remove the entry once execution finishes.
 */
export function registerPyToolBridge(sessionId: string, entry: PyToolBridgeEntry): () => void {
	registrations.set(sessionId, entry);
	return () => {
		if (registrations.get(sessionId) === entry) {
			registrations.delete(sessionId);
		}
	};
}

/** Stop the bridge and clear registrations. Test-only / shutdown helper. */
export async function disposePyToolBridge(): Promise<void> {
	registrations.clear();
	const pending = serverPromise;
	serverPromise = null;
	if (!pending) return;
	try {
		const server = await pending;
		await server.stop();
	} catch (err) {
		logger.debug("Failed to stop Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
