interface ComplexityScan {
	readonly reasons: readonly string[];
}

/**
 * Detect the §9.3 rewrite-forbidding tokens outside quoted literals:
 * `| > >> < && || ; & $( \`` plus newlines. Inside single quotes everything
 * is literal; inside double quotes command substitution (`$(`, backtick)
 * stays active per POSIX, other operators are literal.
 */
export function scanShellComplexity(command: string): ComplexityScan {
	const reasons = new Set<string>();
	let inSingle = false;
	let inDouble = false;
	for (let index = 0; index < command.length; index++) {
		const ch = command[index];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			}
			continue;
		}
		if (ch === "\\") {
			// Escaped character is literal both bare and inside double quotes.
			index += 1;
			continue;
		}
		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "`" || (ch === "$" && command[index + 1] === "(")) {
				reasons.add("shell.operator.substitution");
			}
			continue;
		}
		switch (ch) {
			case "'":
				inSingle = true;
				break;
			case '"':
				inDouble = true;
				break;
			case "`":
				reasons.add("shell.operator.substitution");
				break;
			case "$":
				if (command[index + 1] === "(") {
					reasons.add("shell.operator.substitution");
				}
				break;
			case "|":
				reasons.add(command[index + 1] === "|" ? "shell.operator.list" : "shell.operator.pipe");
				if (command[index + 1] === "|") {
					index += 1;
				}
				break;
			case "&":
				reasons.add(command[index + 1] === "&" ? "shell.operator.list" : "shell.operator.background");
				if (command[index + 1] === "&") {
					index += 1;
				}
				break;
			case ";":
				reasons.add("shell.operator.list");
				break;
			case ">":
			case "<":
				reasons.add("shell.operator.redirect");
				break;
			case "\n":
				reasons.add("shell.multiline");
				break;
			default:
				break;
		}
	}
	if (inSingle || inDouble) {
		reasons.add("shell.unbalanced-quote");
	}
	return { reasons: [...reasons] };
}
