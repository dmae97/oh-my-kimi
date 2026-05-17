import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import buckets from "./data/emojis.json" with { type: "json" };

// Bucket layout: `{ "<first-char>": [["<name>", "<emoji>"], ...] }`, with each
// bucket pre-sorted by name. Built offline by scripts/build-emojis.py
// so the runtime never has to allocate sorted arrays or filter flag sequences.
type Entry = readonly [name: string, char: string];
const BUCKETS = buckets as unknown as Readonly<Record<string, readonly Entry[]>>;

const MAX_SUGGESTIONS = 12;

function lowerBound(arr: readonly Entry[], target: string): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid]![0] < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function lookupExact(name: string): string | undefined {
	const bucket = BUCKETS[name[0] ?? ""];
	if (!bucket) return undefined;
	const i = lowerBound(bucket, name);
	const hit = bucket[i];
	return hit && hit[0] === name ? hit[1] : undefined;
}

// Shortcode-name characters mirror the GitHub/gemoji grammar: `a-z`, `A-Z`,
// `0-9`, `_`, `+`, `-`.
function isNameCharCode(c: number): boolean {
	return (
		(c >= 0x61 && c <= 0x7a) ||
		(c >= 0x41 && c <= 0x5a) ||
		(c >= 0x30 && c <= 0x39) ||
		c === 0x5f ||
		c === 0x2b ||
		c === 0x2d
	);
}

// Token boundary to the left of an opening `:`: start-of-string or one of
// the punctuation characters we treat as a "fresh token" marker (whitespace,
// opening brackets, `>` for quoted blocks).
function hasLeftBoundary(text: string, colonIdx: number): boolean {
	if (colonIdx === 0) return true;
	const c = text.charCodeAt(colonIdx - 1);
	return (
		c === 0x20 || // space
		c === 0x09 || // tab
		c === 0x0a || // \n
		c === 0x0d || // \r
		c === 0x28 || // (
		c === 0x5b || // [
		c === 0x7b || // {
		c === 0x3e // >
	);
}

interface EmojiTrigger {
	/** Full token including the leading `:` (e.g. `:joy`). */
	prefix: string;
	/** Lowercased name portion (e.g. `joy`). May be empty when only `:` has been typed. */
	query: string;
}

// Walk back over name characters then verify an opening `:` with a left
// boundary. Cheaper than a regex on every keystroke and avoids allocating
// match arrays.
function extractTrigger(text: string): EmojiTrigger | null {
	let i = text.length;
	while (i > 0 && isNameCharCode(text.charCodeAt(i - 1))) i--;
	if (i === 0 || text.charCodeAt(i - 1) !== 0x3a) return null;
	const colonIdx = i - 1;
	if (!hasLeftBoundary(text, colonIdx)) return null;
	const name = text.slice(i);
	return { prefix: `:${name}`, query: name.toLowerCase() };
}

export function getEmojiSuggestions(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
	const trigger = extractTrigger(textBeforeCursor);
	if (!trigger) return null;
	// Wait until the user has typed at least one letter so a bare `:` in prose
	// (e.g. "note:") does not spam the popup.
	if (trigger.query.length === 0) return null;

	const bucket = BUCKETS[trigger.query[0]!];
	if (!bucket) return null;

	const items: AutocompleteItem[] = [];
	for (let i = lowerBound(bucket, trigger.query); i < bucket.length && items.length < MAX_SUGGESTIONS; i++) {
		const [name, char] = bucket[i]!;
		if (!name.startsWith(trigger.query)) break;
		items.push({
			value: char,
			label: `${char}  :${name}:`,
		});
	}
	if (items.length === 0) return null;
	return { items, prefix: trigger.prefix };
}

export function applyEmojiCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const before = currentLine.slice(0, cursorCol - prefix.length);
	const after = currentLine.slice(cursorCol);
	const newLines = [...lines];
	newLines[cursorLine] = before + item.value + after;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: before.length + item.value.length,
	};
}

export function tryEmojiInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
	const len = textBeforeCursor.length;
	// Cheap early-out: inline replace only fires on a trailing `:`.
	if (len === 0 || textBeforeCursor.charCodeAt(len - 1) !== 0x3a) return null;

	// Walk back over the candidate name, then require an opening `:` with a
	// left boundary.
	const closeIdx = len - 1;
	let nameStart = closeIdx;
	while (nameStart > 0 && isNameCharCode(textBeforeCursor.charCodeAt(nameStart - 1))) nameStart--;
	if (nameStart === closeIdx) return null; // empty name (`::`)
	if (nameStart === 0 || textBeforeCursor.charCodeAt(nameStart - 1) !== 0x3a) return null;
	const openIdx = nameStart - 1;
	if (!hasLeftBoundary(textBeforeCursor, openIdx)) return null;

	const name = textBeforeCursor.slice(nameStart, closeIdx).toLowerCase();
	const char = lookupExact(name);
	if (!char) return null;
	// Replace `:name:` (name + 2 colons) with the emoji character.
	return { replaceLen: name.length + 2, insert: char };
}

export function isEmojiPrefix(prefix: string): boolean {
	return prefix.startsWith(":");
}
