/**
 * Tree-sitter-backed {@link BlockResolver} for the hashline `replace block N:`
 * operator. Bridges the pure hashline seam to the native `blockRangeAt`
 * primitive in `@oh-my-pi/pi-natives`, which infers the language from the file
 * path and returns the 1-indexed line span of the syntactic block beginning on
 * the requested line (or `null` when none can be resolved).
 */
import type { BlockResolver } from "@oh-my-pi/hashline";
import { blockRangeAt } from "@oh-my-pi/pi-natives";

export const nativeBlockResolver: BlockResolver = ({ path, text, line }) => {
	const range = blockRangeAt({ code: text, path, line });
	return range ? { start: range.startLine, end: range.endLine } : null;
};
