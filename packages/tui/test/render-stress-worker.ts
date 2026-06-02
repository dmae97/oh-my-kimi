import {
	applyStressEnv,
	formatSeed,
	runStressScenario,
	type StressWorkerRequest,
	type StressWorkerResponse,
} from "./render-stress-harness";

interface StressWorkerGlobal {
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	postMessage(message: StressWorkerResponse): void;
}

const workerGlobal = globalThis as unknown as StressWorkerGlobal;
workerGlobal.addEventListener("message", event => {
	const request = event.data as StressWorkerRequest;
	void runWorkerScenario(request);
});

async function runWorkerScenario(request: StressWorkerRequest): Promise<void> {
	try {
		if (request.patchEnv === false) applyStressEnv(request.scenario.envMode);
		await runStressScenario(request.scenario, { patchEnv: request.patchEnv });
		postWorkerMessage({ id: request.id, ok: true });
	} catch (error) {
		postWorkerMessage({
			id: request.id,
			ok: false,
			scenario: request.scenario.name,
			seed: formatSeed(request.scenario.seed),
			...serializeError(error),
		});
	}
}

function serializeError(error: unknown): { error: string; stack?: string } {
	if (error instanceof Error) {
		return error.stack === undefined ? { error: error.message } : { error: error.message, stack: error.stack };
	}
	return { error: String(error) };
}

function postWorkerMessage(message: StressWorkerResponse): void {
	workerGlobal.postMessage(message);
}
