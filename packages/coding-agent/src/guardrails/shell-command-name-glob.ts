import { curlValue, ENV_VALUE_OPTIONS } from "./shell-command-option.ts";
import { type NormalizedStaticShell, normalizeStaticShell } from "./shell-command-tokenizer.ts";
import {
	consumeShellCommandWrapper,
	type ShellCommandWrapperState,
	shellCommandWrapper,
} from "./shell-command-wrapper.ts";

function activeSource(shell: NormalizedStaticShell, index: number): boolean {
	const source = shell.sources[index];
	return source !== undefined && !source.escaped && source.quoteStart === undefined;
}

function bracketEnd(shell: NormalizedStaticShell, start: number, end: number): number | undefined {
	if (shell.text[start] !== "[" || !activeSource(shell, start)) return undefined;
	let cursor = start + 1;
	if (cursor < end && (shell.text[cursor] === "!" || shell.text[cursor] === "^") && activeSource(shell, cursor)) {
		cursor++;
	}
	let members = 0;
	if (cursor < end && shell.text[cursor] === "]" && activeSource(shell, cursor)) {
		members++;
		cursor++;
	}
	while (cursor < end) {
		if (shell.text[cursor] === "]" && activeSource(shell, cursor) && members > 0) return cursor;
		if (
			shell.text[cursor] === "[" &&
			activeSource(shell, cursor) &&
			".=:".includes(shell.text[cursor + 1] ?? "") &&
			activeSource(shell, cursor + 1)
		) {
			const terminator = `${shell.text[cursor + 1]}]`;
			const nestedEnd = shell.text.indexOf(terminator, cursor + 2);
			if (nestedEnd >= 0 && nestedEnd + 1 < end && activeSource(shell, nestedEnd + 1)) {
				members++;
				cursor = nestedEnd + 2;
				continue;
			}
		}
		members++;
		cursor++;
	}
	return undefined;
}

function activeGlob(shell: NormalizedStaticShell, start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		if (!activeSource(shell, index)) continue;
		const character = shell.text[index];
		if (character === "*" || character === "?") return true;
		const close = bracketEnd(shell, index, end);
		if (close !== undefined) return true;
	}
	return false;
}

function separator(shell: NormalizedStaticShell, start: number, end: number, delimiters: string): number {
	for (let index = start; index < end; index++) {
		const close = bracketEnd(shell, index, end);
		if (close !== undefined) {
			index = close;
			continue;
		}
		if (delimiters.includes(shell.text[index])) return index;
	}
	return end;
}

function previousArgument(shell: NormalizedStaticShell, index: number): string | undefined {
	const current = shell.words[index];
	const previous = shell.words[index - 1];
	return current !== undefined && previous !== undefined && /^\s*$/.test(shell.text.slice(previous.end, current.start))
		? shell.text.slice(previous.start, previous.end)
		: undefined;
}

function nameLike(shell: NormalizedStaticShell, start: number, end: number, allowLeadingQuestion: boolean): boolean {
	const first = shell.text[start];
	if (
		first === undefined ||
		(!/[A-Za-z_*_]/.test(first) && first !== "[" && !(allowLeadingQuestion && first === "?"))
	) {
		return false;
	}
	for (let index = start; index < end; index++) {
		const close = bracketEnd(shell, index, end);
		if (close !== undefined) {
			index = close;
			continue;
		}
		if ("/:.".includes(shell.text[index])) return false;
	}
	return true;
}

function hasActiveQueryNameGlob(
	shell: NormalizedStaticShell,
	wordStart: number,
	wordEnd: number,
	commandTreatsArgumentsAsUrls: boolean,
): boolean {
	const text = shell.text.slice(wordStart, wordEnd);
	const question = text.indexOf("?");
	if (question < 0) return false;
	const markerStart = wordStart + question;
	const hasQuerySeparator = separator(shell, markerStart + 1, wordEnd, "=&#") < wordEnd;
	const structuralQuery = hasQuerySeparator && (question === 0 || text.slice(0, question).startsWith("/"));
	if (!commandTreatsArgumentsAsUrls && !text.slice(0, question).includes("://") && !structuralQuery) return false;
	let marker = markerStart;
	while (marker < wordEnd) {
		const nameStart = marker + 1;
		const nameEnd = separator(shell, nameStart, wordEnd, "=&#");
		if (activeGlob(shell, nameStart, nameEnd)) return true;
		if (nameEnd >= wordEnd || shell.text[nameEnd] === "#") return false;
		if (shell.text[nameEnd] === "&") {
			marker = nameEnd;
			continue;
		}
		const next = separator(shell, nameEnd + 1, wordEnd, "&#");
		if (next >= wordEnd || shell.text[next] === "#") return false;
		marker = next;
	}
	return false;
}

export function hasActiveShellNameGlob(shell: NormalizedStaticShell): boolean {
	let optionsEnded = false;
	let commandName: string | undefined;
	let commandWord = -1;
	let wrapper: ShellCommandWrapperState | undefined;
	for (let index = 0; index < shell.words.length; index++) {
		const word = shell.words[index];
		const previousWord = shell.words[index - 1];
		if (previousWord !== undefined && /[;&|()\n]/.test(shell.text.slice(previousWord.end, word.start))) {
			if (wrapper !== undefined) return true;
			optionsEnded = false;
			commandName = undefined;
			wrapper = undefined;
		}
		const text = shell.text.slice(word.start, word.end);
		const previous = previousArgument(shell, index);
		const assignment = separator(shell, word.start, word.end, "=");
		const commandWasUnset = commandName === undefined;
		const staticAssignment =
			assignment < word.end &&
			nameLike(shell, word.start, assignment, false) &&
			!activeGlob(shell, word.start, assignment);
		if (commandWasUnset && !staticAssignment) {
			commandName = text;
			commandWord = index;
			wrapper = shellCommandWrapper(text);
		}
		let wrapperOptionEnd: number | undefined;
		let wrapperValue = false;
		if (wrapper !== undefined && index !== commandWord) {
			const step = consumeShellCommandWrapper(wrapper, text);
			if (step.ambiguous) return true;
			wrapper = step.state;
			wrapperOptionEnd = step.optionEnd;
			wrapperValue = step.value === true;
			if (step.target) {
				commandName = text;
				commandWord = index;
				optionsEnded = false;
				wrapper = shellCommandWrapper(text);
			}
		}
		let envCommand = commandName !== undefined && /(?:^|\/)env(?:\.exe)?$/.test(commandName);
		const envAssignment = assignment < word.end && nameLike(shell, word.start, assignment, true);
		const envOptionValue = envCommand && previous !== undefined && ENV_VALUE_OPTIONS.has(previous);
		if (envCommand && index !== commandWord && !text.startsWith("-") && !envAssignment && !envOptionValue) {
			commandName = text;
			commandWord = index;
			optionsEnded = false;
			wrapper = shellCommandWrapper(text);
			envCommand = false;
		}
		const curlCommand = commandName !== undefined && /(?:^|\/)curl(?:\.exe)?$/.test(commandName);
		const currentCurlValue = !optionsEnded && curlCommand ? curlValue(text) : undefined;
		const previousCurlValue =
			!optionsEnded && curlCommand && previous !== undefined ? curlValue(previous) : undefined;
		const valueFromPrevious = previousCurlValue !== undefined && previousCurlValue.offset === previous?.length;
		const fileValue =
			(currentCurlValue?.kind === "file" && currentCurlValue.offset < text.length) ||
			(valueFromPrevious && previousCurlValue?.kind === "file");
		const headerValue =
			(currentCurlValue?.kind === "header" && currentCurlValue.offset < text.length) ||
			(valueFromPrevious && previousCurlValue?.kind === "header");
		const optionValue = fileValue || headerValue || envOptionValue || wrapperValue;
		if (!optionsEnded && !optionValue && text === "--") {
			optionsEnded = true;
			continue;
		}
		const optionPrefix =
			!optionsEnded && !valueFromPrevious && !envOptionValue && !wrapperValue
				? /^--?/.exec(text)?.[0].length
				: undefined;
		if (optionPrefix !== undefined) {
			const optionEnd =
				wrapperOptionEnd ??
				currentCurlValue?.offset ??
				separator(shell, word.start + optionPrefix, word.end, "=") - word.start;
			if (activeGlob(shell, word.start + optionPrefix, word.start + optionEnd)) return true;
		}
		const shellCommand = commandName !== undefined && /(?:^|\/)(?:ba|da|k|z)?sh(?:\.exe)?$/i.test(commandName);
		if (shellCommand && index !== commandWord && /^-[A-Za-z]*c[A-Za-z]*$/.test(text)) {
			const script = previousArgument(shell, index + 1) === text ? shell.words[index + 1] : undefined;
			if (script !== undefined) normalizeStaticShell(shell.text.slice(script.start, script.end));
		}
		if (commandName !== undefined && /(?:^|\/)eval$/.test(commandName) && index === commandWord + 1) {
			let last = index;
			while (
				previousArgument(shell, last + 1) === shell.text.slice(shell.words[last].start, shell.words[last].end)
			) {
				last++;
			}
			normalizeStaticShell(shell.text.slice(word.start, shell.words[last].end));
		}
		if (
			!fileValue &&
			!headerValue &&
			hasActiveQueryNameGlob(shell, word.start, word.end, index !== commandWord && curlCommand)
		) {
			return true;
		}
		const explicitEnvironment = index !== commandWord && (envCommand || commandName === "export");
		if (
			(commandWasUnset || explicitEnvironment) &&
			assignment < word.end &&
			(!text.startsWith("?") || explicitEnvironment) &&
			nameLike(shell, word.start, assignment, explicitEnvironment) &&
			activeGlob(shell, word.start, assignment)
		) {
			return true;
		}
		const headerStart = headerValue
			? currentCurlValue?.kind === "header"
				? word.start + currentCurlValue.offset
				: word.start
			: undefined;
		if (headerStart !== undefined) {
			const headerEnd = separator(shell, headerStart, word.end, ":=");
			if (activeGlob(shell, headerStart, headerEnd)) return true;
		}
	}
	return wrapper !== undefined;
}
