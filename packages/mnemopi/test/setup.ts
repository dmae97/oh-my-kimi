import { afterEach, beforeEach } from "bun:test";

import * as Beam from "@oh-my-pi/pi-mnemopi/core/beam";
import * as Embeddings from "@oh-my-pi/pi-mnemopi/core/embeddings";
import type { CompleteOptions, LlmBackend } from "@oh-my-pi/pi-mnemopi/core/llm-backends";
import * as LlmBackends from "@oh-my-pi/pi-mnemopi/core/llm-backends";
import * as Memory from "@oh-my-pi/pi-mnemopi/core/memory";

type ResettableModule = Record<string, unknown>;

const RESET_FUNCTION_NAMES = [
	"resetForTests",
	"resetModuleStateForTests",
	"resetMemoryForTests",
	"resetBeamForTests",
	"resetEmbeddingStateForTests",
	"resetHostLlmBackendForTests",
	"resetLlmBackendStateForTests",
] as const;

const RESETTABLE_MODULES: readonly ResettableModule[] = [Memory, Beam, LlmBackends, Embeddings];

function callResetFunctions(moduleExports: ResettableModule): void {
	for (const name of RESET_FUNCTION_NAMES) {
		const reset = moduleExports[name];
		if (typeof reset === "function") {
			reset();
		}
	}
}

export function resetModuleStateForTests(): void {
	for (const moduleExports of RESETTABLE_MODULES) {
		callResetFunctions(moduleExports);
	}
}

export function disableLocalLlmForTests(): void {
	LlmBackends.setHostLlmBackend(null);
}

export function withLocalLlm(fakeResponseOrBackend: string | LlmBackend = "fake summary"): LlmBackend {
	const backend =
		typeof fakeResponseOrBackend === "string"
			? new FakeLocalLlmBackend(fakeResponseOrBackend)
			: fakeResponseOrBackend;

	LlmBackends.setHostLlmBackend(backend);
	return backend;
}

class FakeLocalLlmBackend implements LlmBackend {
	readonly name = "fake-local-llm";

	constructor(public response: string) {}

	complete(_prompt: string, _opts?: CompleteOptions): string {
		return this.response;
	}

	createChatCompletion(): { choices: [{ message: { content: string } }] } {
		return { choices: [{ message: { content: this.response } }] };
	}
}
export const RUN_EMBEDDINGS = Bun.env.EMBEDDINGS === "1";


beforeEach(() => {
	// Real embeddings (fastembed + onnxruntime-node, ~270MB peers) install on
	// demand via `bun install` on first use. Default the suite to the lightweight
	// FTS-only mode; embedding-specific tests opt back in explicitly with withEnv()
	// or a fake provider.
	if (!RUN_EMBEDDINGS) {
		process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	} else {
		delete process.env.MNEMOPI_NO_EMBEDDINGS;
	}
	resetModuleStateForTests();
	disableLocalLlmForTests();
});

afterEach(() => {
	resetModuleStateForTests();
	disableLocalLlmForTests();
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
});
