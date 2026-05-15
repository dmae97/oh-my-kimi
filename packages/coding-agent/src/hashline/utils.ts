export function stripTrailingCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function trimTrailingWhitespace(line: string): string {
	let end = line.length;
	while (end > 0) {
		const ch = line.charCodeAt(end - 1);
		if (ch !== 0x20 && ch !== 0x09) break;
		end--;
	}
	return end === line.length ? line : line.slice(0, end);
}
