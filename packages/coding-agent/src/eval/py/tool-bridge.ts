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

/**
 * Forward a bridge call to {@link callSessionTool}, but resolve the HTTP request
 * the instant the cell's signal aborts instead of waiting for the tool/subagent
 * to fully tear down.
 *
 * The kernel invokes this bridge with a *blocking* `urllib` request from a
 * worker thread (each `agent()` / `tool.*` call). When the cell is interrupted,
 * `parallel()`'s `ThreadPoolExecutor.__exit__` joins those worker threads
 * (`shutdown(wait=True)`), so they cannot unwind until their `urllib` call
 * returns — i.e. until this handler responds. A host-side `agent()` teardown
 * (aborting nested LLM streams + tools across a wide fan-out) routinely exceeds
 * the kernel's SIGINT escalation window, so the kernel was hard-killed and its
 * persistent state lost while the subagents were still winding down. Responding
 * immediately on abort lets the kernel raise through the blocked call and settle
 * cleanly (preserving state); the already-signaled call keeps tearing down in
 * the background, its eventual result/rejection swallowed.
 */
async function callSessionToolPromptOnAbort(name: string, args: unknown, entry: PyToolBridgeEntry): Promise<unknown> {
	const call = callSessionTool(name, args, {
		session: entry.toolSession,
		signal: entry.signal,
		emitStatus: entry.emitStatus,
	});
	const signal = entry.signal;
	if (!signal) return await call;
	if (signal.aborted) {
		void call.catch(() => {});
		throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
	}
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([call, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		// `call` may still be settling (subagent teardown after its own abort);
		// swallow its outcome so an abort-won race can't surface as unhandled.
		void call.catch(() => {});
	}
}

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

			let body: { session?: unknown; run?: unknown; name?: unknown; args?: unknown };
			try {
				body = (await req.json()) as { session?: unknown; run?: unknown; name?: unknown; args?: unknown };
			} catch {
				return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
			}
			const sessionId = typeof body.session === "string" ? body.session : "";
			const runId = typeof body.run === "string" ? body.run : "";
			const name = typeof body.name === "string" ? body.name : "";
			if (!sessionId || !runId || !name) {
				return Response.json({ ok: false, error: "Missing session/run/name" }, { status: 400 });
			}
			const registrationKey = bridgeRegistrationKey(sessionId, runId);
			const entry = registrations.get(registrationKey) ?? registrations.get(sessionId);
			if (!entry) {
				return Response.json(
					{ ok: false, error: `No active Python tool bridge session: ${registrationKey}` },
					{ status: 200 },
				);
			}

			try {
				const value = await callSessionToolPromptOnAbort(name, body.args, entry);
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
function bridgeRegistrationKey(sessionId: string, runId: string): string {
	return `${sessionId}:${runId}`;
}

export function registerPyToolBridge(sessionId: string, runId: string, entry: PyToolBridgeEntry): () => void {
	const key = bridgeRegistrationKey(sessionId, runId);
	registrations.set(key, entry);
	return () => {
		if (registrations.get(key) === entry) {
			registrations.delete(key);
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
