import { parentPort } from "node:worker_threads";
import type { Transport, WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { WorkerCore } from "./tab-worker";

if (!parentPort) throw new Error("tab-worker-entry: missing parentPort");

const transport: Transport = {
	send(msg, transferList) {
		parentPort!.postMessage(msg, transferList ?? []);
	},
	onMessage(handler) {
		const wrap = (message: unknown): void => handler(message as WorkerOutbound | WorkerInbound);
		parentPort!.on("message", wrap);
		return () => parentPort!.off("message", wrap);
	},
	close() {
		parentPort!.close();
	},
};

new WorkerCore(transport);
