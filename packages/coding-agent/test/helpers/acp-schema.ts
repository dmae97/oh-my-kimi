import { expect } from "bun:test";
import type * as z from "zod/v4";

function formatIssues(error: z.ZodError): string {
	return error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("\n");
}

export function expectAcpStructure(schema: z.ZodType, value: unknown): void {
	const result = schema.safeParse(value);
	expect(result.success, result.success ? undefined : formatIssues(result.error)).toBe(true);
}

export function expectAcpStructureRejects(schema: z.ZodType, value: unknown): void {
	const result = schema.safeParse(value);
	expect(result.success).toBe(false);
}
