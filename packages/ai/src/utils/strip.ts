/**
 * Helper to standardise removing transient parsing or serialization keys
 * from internally managed LLM structures by setting them to undefined.
 * Avoids delete as it is slow and deoptimizes the object's hidden class.
 */
export function stripVariant<T>(container: object, key: keyof T): void {
	if (Object.hasOwn(container, key)) {
		Reflect.set(container, key, undefined);
	}
}
