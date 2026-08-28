/**
 * Context file shape.
 *
 * This six-field record described what `resource-loader.ts` produces, so it
 * lived there — and every module that merely wanted to *describe* a context
 * file therefore had to depend on the 1,000-line loader that produces them.
 * That dependency is what pulled the system-prompt builders into the loader's
 * import cycle.
 *
 * The vocabulary now sits below both: the loader imports it to declare its
 * output, and prompt builders import it to declare their input, without either
 * side reaching the other.
 *
 * Type only, no imports. This module is the bottom of that chain.
 */

export interface ContextFile {
	path: string;
	content: string;
	isGlobal?: boolean;
	containsJailbreak?: boolean;
	sanitized?: boolean;
}
