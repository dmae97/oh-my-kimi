/**
 * Protocol handler for rule:// URLs.
 *
 * Resolves rule names to their content files.
 *
 * URL forms:
 * - rule://<name> - Reads rule content
 */
import type { Rule } from "../capability/rule";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface RuleProtocolOptions {
	/**
	 * Returns the currently loaded rules.
	 */
	getRules: () => readonly Rule[];
}

/**
 * Handler for rule:// URLs.
 *
 * Resolves rule names to their content.
 */
export class RuleProtocolHandler implements ProtocolHandler {
	readonly scheme = "rule";
	readonly immutable = true;

	constructor(private readonly options: RuleProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const rules = this.options.getRules();

		// Extract rule name from host
		const ruleName = url.rawHost || url.hostname;
		if (!ruleName) {
			throw new Error("rule:// URL requires a rule name: rule://<name>");
		}

		// Find the rule
		const rule = rules.find(r => r.name === ruleName);
		if (!rule) {
			const available = rules.map(r => r.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown rule: ${ruleName}\nAvailable: ${availableStr}`);
		}

		return {
			url: url.href,
			content: rule.content,
			contentType: "text/markdown",
			size: Buffer.byteLength(rule.content, "utf-8"),
			sourcePath: rule.path,
			notes: [],
		};
	}
}
