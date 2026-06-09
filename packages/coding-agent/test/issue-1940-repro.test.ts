import { describe, expect, it } from "bun:test";
import { TinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

class FakeTinyWorker {
	terminated = false;
	#messageHandlers = new Set<(message: TinyTitleWorkerOutbound) => void>();
	#onSend: (message: TinyTitleWorkerInbound, worker: FakeTinyWorker) => void;

	constructor(onSend: (message: TinyTitleWorkerInbound, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyTitleWorkerInbound): void {
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyTitleWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(): () => void {
		return () => {};
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	emit(message: TinyTitleWorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("tiny title client prompt options", () => {
	it("forwards a custom system prompt on local title requests", async () => {
		let sent: TinyTitleWorkerInbound | undefined;
		const worker = new FakeTinyWorker((message, worker) => {
			sent = message;
			if (message.type === "generate") {
				worker.emit({ type: "title", id: message.id, title: "custom title" });
			}
		});
		const client = new TinyTitleClient(() => worker);

		try {
			const title = await client.generate("lfm2-350m", "Investigate routing", {
				systemPrompt: "Custom title prompt",
			});

			expect(title).toBe("custom title");
			expect(sent).toMatchObject({
				type: "generate",
				modelKey: "lfm2-350m",
				message: "Investigate routing",
				systemPrompt: "Custom title prompt",
			});
		} finally {
			await client.terminate();
		}
	});
});

describe("issue #1940 — local model failures release the worker process", () => {
	it("recycles the tiny-model worker after model execution returns an error", async () => {
		const first = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "error", id: message.id, error: "Error: Unknown failure" });
			}
		});
		const second = new FakeTinyWorker((message, worker) => {
			if (message.type === "complete") {
				worker.emit({ type: "completion", id: message.id, text: "recovered" });
			}
		});
		const workers = [first, second];
		let nextWorker = 0;
		const client = new TinyTitleClient(() => {
			const worker = workers[nextWorker];
			if (!worker) throw new Error("unexpected worker spawn");
			nextWorker += 1;
			return worker;
		});

		try {
			expect(await client.complete("qwen3-1.7b", "long prompt")).toBeNull();
			expect(first.terminated).toBe(true);
			expect(await client.complete("qwen3-1.7b", "retry prompt")).toBe("recovered");
			expect(nextWorker).toBe(2);
		} finally {
			await client.terminate();
		}
	});

	it("faults queued local completions when the failed worker is recycled", async () => {
		let firstRequestId = "";
		const worker = new FakeTinyWorker(message => {
			if (message.type !== "complete") return;
			firstRequestId ||= message.id;
		});
		const client = new TinyTitleClient(() => worker);

		try {
			const first = client.complete("qwen3-1.7b", "first prompt");
			const second = client.complete("qwen3-1.7b", "second prompt");
			worker.emit({ type: "error", id: firstRequestId, error: "Error: Unknown failure" });

			expect(await first).toBeNull();
			expect(await second).toBeNull();
			expect(worker.terminated).toBe(true);
		} finally {
			await client.terminate();
		}
	});
});
