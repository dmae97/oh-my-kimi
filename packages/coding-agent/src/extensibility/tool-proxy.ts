/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 */
export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, {
				get() {
					const value = (tool as Record<PropertyKey, unknown>)[key];
					// Bind real methods so `this` is preserved through the wrapper, but leave
					// callable values that aren't plain functions untouched — notably an ArkType
					// `Type` (the `parameters` schema) is callable yet lacks `Function.prototype.bind`.
					return typeof value === "function" && typeof value.bind === "function" ? value.bind(tool) : value;
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}
