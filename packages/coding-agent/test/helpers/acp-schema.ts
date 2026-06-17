import { expect } from "bun:test";
import type { Type } from "arktype";

function formatIssues(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function expectAcpStructure(schema: Type, value: unknown): void {
	const result = schema(value);
	const isValid = !(result instanceof Error);
	expect(isValid, isValid ? undefined : formatIssues(result)).toBe(true);
}

export function expectAcpStructureRejects(schema: Type, value: unknown): void {
	const result = schema(value);
	const isValid = !(result instanceof Error);
	expect(isValid).toBe(false);
}
