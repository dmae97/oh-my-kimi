import { afterEach, beforeEach } from "bun:test";

import * as Beam from "../src/core/beam/index";
import * as Embeddings from "../src/core/embeddings";
import type { CompleteOptions, LlmBackend } from "../src/core/llm-backends";
import * as LlmBackends from "../src/core/llm-backends";
import * as Memory from "../src/core/memory";

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

beforeEach(() => {
	resetModuleStateForTests();
	disableLocalLlmForTests();
});

afterEach(() => {
	resetModuleStateForTests();
	disableLocalLlmForTests();
});
