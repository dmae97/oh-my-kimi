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
	},
};

new WorkerCore(transport);
