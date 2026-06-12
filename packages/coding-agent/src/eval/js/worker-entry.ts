import { parentPort } from "node:worker_threads";
import { WorkerCore } from "./worker-core";
import type { Transport, WorkerInbound, WorkerOutbound } from "./worker-protocol";

if (!parentPort) throw new Error("js worker-entry: missing parentPort");

const port = parentPort;
const transport: Transport = {
	send: (msg: WorkerOutbound) => port.postMessage(msg),
	onMessage: handler => {
		const wrap = (data: unknown): void => handler(data as WorkerInbound);
		port.on("message", wrap);
		return () => port.off("message", wrap);
	},
	close: () => {
		try {
			port.close();
		} catch {
			// Already closed.
		}

		// `parentPort.close()` only disconnects the channel in Bun; it does not
		// make the Worker emit `close` or reap ref'ed user handles. Exit from
		// inside the worker after `WorkerCore` has sent the `closed` ack so the
		// host can observe real worker exit without calling `Worker.terminate()`.
		setTimeout(() => process.exit(0), 0);
	},
};

new WorkerCore(transport);
