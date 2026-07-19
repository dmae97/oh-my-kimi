export interface ShellCommandWrapperState {
	readonly kind: "command" | "exec";
	readonly options: boolean;
	readonly pendingName?: boolean;
	readonly lookup?: boolean;
}

export interface ShellCommandWrapperStep {
	readonly state?: ShellCommandWrapperState;
	readonly ambiguous?: boolean;
	readonly optionEnd?: number;
	readonly value?: boolean;
	readonly target?: boolean;
}

/** Recognize only wrappers whose option grammar is modeled below. */
export function shellCommandWrapper(commandName: string): ShellCommandWrapperState | undefined {
	const name = commandName.slice(commandName.lastIndexOf("/") + 1).replace(/\.exe$/i, "");
	return name === "command" || name === "exec" ? { kind: name, options: true } : undefined;
}

/** Consume one wrapper argument without mistaking option values for command names. */
export function consumeShellCommandWrapper(state: ShellCommandWrapperState, word: string): ShellCommandWrapperStep {
	if (state.kind === "command") {
		if (state.lookup && (!state.options || !word.startsWith("-") || word === "-")) {
			return { value: true };
		}
		if (state.options && word === "--") return { state: { ...state, options: false }, optionEnd: word.length };
		if (state.options && word.startsWith("-") && word !== "-") {
			if (!/^-[pVv]+$/.test(word)) return { ambiguous: true };
			return {
				state: /[Vv]/.test(word) ? { ...state, lookup: true } : state,
				optionEnd: word.length,
			};
		}
		return state.lookup ? { value: true } : { target: true };
	}
	if (state.pendingName) return { state: { ...state, pendingName: false }, value: true };
	if (state.options && word === "--") return { state: { ...state, options: false }, optionEnd: word.length };
	if (state.options && word.startsWith("-") && word !== "-") {
		for (let index = 1; index < word.length; index++) {
			if (word[index] === "c" || word[index] === "l") continue;
			if (word[index] !== "a") return { ambiguous: true };
			return index + 1 < word.length
				? { state, optionEnd: index + 1 }
				: { state: { ...state, pendingName: true }, optionEnd: word.length };
		}
		return { state, optionEnd: word.length };
	}
	return { target: true };
}
