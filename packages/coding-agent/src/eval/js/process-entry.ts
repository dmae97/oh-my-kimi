import { WorkerCore } from "./worker-core";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

/** Start the JavaScript evaluator inside a subprocess IPC transport. */
export function startJsEvalProcess(transport: {
	send(message: WorkerOutbound): void;
	onMessage(handler: (message: WorkerInbound) => void): () => void;
}): void {
	new WorkerCore({
		send: message => transport.send(message),
		onMessage: handler => transport.onMessage(handler),
		// The parent owns process lifetime and kills the subprocess after the
		// WorkerCore `closed` acknowledgement has crossed IPC.
		close: () => {},
	});
}
