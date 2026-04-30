const FIREWORKS_WIRE_PREFIX = "accounts/fireworks/models/";
const VERSION_SEPARATOR_PATTERN = /(?<=\d)p(?=\d)/g;
const VERSION_DOT_PATTERN = /(?<=\d)\.(?=\d)/g;

export function toFireworksPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_WIRE_PREFIX) ? modelId.slice(FIREWORKS_WIRE_PREFIX.length) : modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFireworksWireModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_WIRE_PREFIX) ? modelId.slice(FIREWORKS_WIRE_PREFIX.length) : modelId;
	return `${FIREWORKS_WIRE_PREFIX}${stripped.replace(VERSION_DOT_PATTERN, "p")}`;
}
