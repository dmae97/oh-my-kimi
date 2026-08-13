export type PiCompatibilityTarget = "coding-agent" | "agent-core" | "agent-core-node" | "ai" | "ai-oauth" | "tui";

const PI_NAMESPACES = ["@earendil-works", "@mariozechner"] as const;

export const LEGACY_PI_RUNTIME_ALIASES: Readonly<Record<string, PiCompatibilityTarget>> = Object.freeze(
	Object.fromEntries(
		PI_NAMESPACES.flatMap((namespace) => [
			[`${namespace}/pi-coding-agent`, "coding-agent"],
			[`${namespace}/pi-agent-core`, "agent-core"],
			[`${namespace}/pi-agent-core/node`, "agent-core-node"],
			[`${namespace}/pi-ai`, "ai"],
			[`${namespace}/pi-ai/compat`, "ai"],
			[`${namespace}/pi-ai/oauth`, "ai-oauth"],
			[`${namespace}/pi-tui`, "tui"],
		]),
	) as Record<string, PiCompatibilityTarget>,
);

const LEGACY_PI_IMPORT =
	/^@(mariozechner|earendil-works|oh-my-pi)\/pi-(?:agent-core|ai|coding-agent|natives|tui|utils)(?:\/|$)/u;

export function isLegacyPiRuntimeImport(specifier: string): boolean {
	return LEGACY_PI_IMPORT.test(specifier);
}

export function isSupportedLegacyPiRuntimeImport(specifier: string): boolean {
	return Object.getOwnPropertyDescriptor(LEGACY_PI_RUNTIME_ALIASES, specifier) !== undefined;
}
