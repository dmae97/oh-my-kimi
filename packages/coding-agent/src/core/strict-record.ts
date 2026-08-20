export function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const compare = (left: string, right: string): number => left.localeCompare(right);
	const actual = Object.keys(value).sort(compare);
	const expected = [...keys].sort(compare);
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
