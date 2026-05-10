/**
 * Internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, pi://, local://).
 */
import { parseInternalUrl } from "./parse";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/**
 * Router for internal URL schemes.
 *
 * Dispatches URLs like `agent://output_id` or `memory://root/memory_summary.md` to
 * registered protocol handlers.
 */
export class InternalUrlRouter {
	#handlers = new Map<string, ProtocolHandler>();

	/**
	 * Register a protocol handler.
	 * @param handler Handler to register (uses handler.scheme as key)
	 */
	register(handler: ProtocolHandler): void {
		this.#handlers.set(handler.scheme, handler);
	}

	/**
	 * Check if the router can handle a URL.
	 * @param input URL string to check
	 */
	canHandle(input: string): boolean {
		const match = input.match(/^([a-z][a-z0-9+.-]*):\/\//i);
		if (!match) return false;
		const scheme = match[1].toLowerCase();
		return this.#handlers.has(scheme);
	}

	/**
	 * Resolve an internal URL to its content.
	 * @param input URL string (e.g., "agent://reviewer_0", "skill://notion-pages")
	 * @throws Error if scheme is not registered or resolution fails
	 */
	async resolve(input: string): Promise<InternalResource> {
		const parsed = parseInternalUrl(input);
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		const handler = this.#handlers.get(scheme);

		if (!handler) {
			const available = Array.from(this.#handlers.keys())
				.map(s => `${s}://`)
				.join(", ");
			throw new Error(`Unknown protocol: ${scheme}://\nSupported: ${available || "none"}`);
		}

		const resource = await handler.resolve(parsed as InternalUrl);
		return { ...resource, immutable: resource.immutable ?? handler.immutable };
	}
}
