import { parentPort } from "node:worker_threads";
import {
	env,
	LogLevel,
	pipeline,
	StoppingCriteria,
	type TextGenerationPipeline,
	type TextGenerationStringOutput,
} from "@huggingface/transformers";
import { getTinyModelsCacheDir, prompt } from "@oh-my-pi/pi-utils";
import tinyTitleSystemPrompt from "../prompts/system/tiny-title-system.md" with { type: "text" };
import { getTinyTitleModelSpec, type TinyTitleLocalModelKey } from "./tiny-models";
import type { TinyTitleTransport, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./tiny-title-protocol";
import { formatTitleUserMessage, normalizeGeneratedTitle } from "./title-text";

const TITLE_PREFILL = "<title>";
const TITLE_CLOSE = "</title>";
const TITLE_MAX_NEW_TOKENS = 20;
const STOP_DECODE_WINDOW_TOKENS = 32;
const TINY_TITLE_SYSTEM_PROMPT = prompt.render(tinyTitleSystemPrompt);

env.cacheDir = getTinyModelsCacheDir();
env.allowLocalModels = false;
env.logLevel = LogLevel.ERROR;

class StopOnTextCriteria extends StoppingCriteria {
	#tokenizer: TextGenerationPipeline["tokenizer"];
	#text: string;

	constructor(tokenizer: TextGenerationPipeline["tokenizer"], text: string) {
		super();
		this.#tokenizer = tokenizer;
		this.#text = text;
	}

	_call(inputIds: number[][]): boolean[] {
		return inputIds.map(ids => {
			const tail = ids.slice(-STOP_DECODE_WINDOW_TOKENS);
			const text = this.#tokenizer.decode(tail, { skip_special_tokens: false, clean_up_tokenization_spaces: false });
			return text.includes(this.#text);
		});
	}
}

const pipelines = new Map<TinyTitleLocalModelKey, Promise<TextGenerationPipeline>>();
let generateQueue = Promise.resolve();

function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function sendLog(
	transport: TinyTitleTransport,
	level: "debug" | "warn" | "error",
	msg: string,
	meta?: Record<string, unknown>,
): void {
	transport.send({ type: "log", level, msg, meta });
}

function loadPipeline(
	modelKey: TinyTitleLocalModelKey,
	transport: TinyTitleTransport,
): Promise<TextGenerationPipeline> {
	const cached = pipelines.get(modelKey);
	if (cached) return cached;

	const spec = getTinyTitleModelSpec(modelKey);
	const startedAt = performance.now();
	const loaded = pipeline("text-generation", spec.repo, {
		device: "cpu",
		dtype: spec.dtype,
	}).then(
		generator => {
			sendLog(transport, "debug", "tiny-title: local model loaded", {
				modelKey,
				repo: spec.repo,
				elapsedMs: Math.round(performance.now() - startedAt),
			});
			return generator;
		},
		error => {
			pipelines.delete(modelKey);
			throw error;
		},
	);
	pipelines.set(modelKey, loaded);
	return loaded;
}

function buildPrompt(generator: TextGenerationPipeline, message: string): string {
	const chat = [
		{ role: "system", content: TINY_TITLE_SYSTEM_PROMPT },
		{ role: "user", content: formatTitleUserMessage(message) },
	];
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	return `${generator.tokenizer.apply_chat_template(chat, chatTemplateOptions)}${TITLE_PREFILL}`;
}

function extractTinyTitle(text: string): string | null {
	const titleStart = text.lastIndexOf(TITLE_PREFILL);
	const withoutPrefix = titleStart >= 0 ? text.slice(titleStart + TITLE_PREFILL.length) : text;
	const closeIndex = withoutPrefix.indexOf(TITLE_CLOSE);
	const withoutClose = closeIndex >= 0 ? withoutPrefix.slice(0, closeIndex) : withoutPrefix;
	const tagIndex = withoutClose.indexOf("<");
	const withoutTag = tagIndex >= 0 ? withoutClose.slice(0, tagIndex) : withoutClose;
	return normalizeGeneratedTitle(withoutTag);
}

async function generateTitle(
	transport: TinyTitleTransport,
	modelKey: TinyTitleLocalModelKey,
	message: string,
): Promise<string | null> {
	const generator = await loadPipeline(modelKey, transport);
	const promptText = buildPrompt(generator, message);
	const output: TextGenerationStringOutput = await generator(promptText, {
		max_new_tokens: TITLE_MAX_NEW_TOKENS,
		do_sample: false,
		return_full_text: false,
		stopping_criteria: new StopOnTextCriteria(generator.tokenizer, TITLE_CLOSE),
	});
	return extractTinyTitle(output[0]?.generated_text ?? "");
}

async function disposePipelines(): Promise<void> {
	const settled = await Promise.allSettled([...pipelines.values()]);
	pipelines.clear();
	await Promise.allSettled(
		settled.map(result => (result.status === "fulfilled" ? result.value.dispose() : Promise.resolve())),
	);
}

function handleGenerate(
	transport: TinyTitleTransport,
	request: Extract<TinyTitleWorkerInbound, { type: "generate" }>,
): void {
	generateQueue = generateQueue.then(
		async () => {
			try {
				const title = await generateTitle(transport, request.modelKey, request.message);
				transport.send({ type: "title", id: request.id, title });
			} catch (error) {
				transport.send({ type: "error", id: request.id, error: errorText(error) });
			}
		},
		async () => {
			try {
				const title = await generateTitle(transport, request.modelKey, request.message);
				transport.send({ type: "title", id: request.id, title });
			} catch (error) {
				transport.send({ type: "error", id: request.id, error: errorText(error) });
			}
		},
	);
}

export function startTinyTitleWorker(transport: TinyTitleTransport): void {
	transport.onMessage(message => {
		if (message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		if (message.type === "close") {
			void disposePipelines().finally(() => {
				transport.send({ type: "closed" });
				transport.close();
			});
			return;
		}
		handleGenerate(transport, message);
	});
}

if (!parentPort) throw new Error("tiny-title-worker: missing parentPort");

const port = parentPort;
const transport: TinyTitleTransport = {
	send: (message: TinyTitleWorkerOutbound) => port.postMessage(message),
	onMessage: handler => {
		const wrap = (data: unknown): void => handler(data as TinyTitleWorkerInbound);
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

startTinyTitleWorker(transport);
