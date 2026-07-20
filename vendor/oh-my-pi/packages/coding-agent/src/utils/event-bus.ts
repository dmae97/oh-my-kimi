import { logger } from "@oh-my-pi/pi-utils";

export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	}

	clear(): void {
		this.#listeners.clear();
	}
}
