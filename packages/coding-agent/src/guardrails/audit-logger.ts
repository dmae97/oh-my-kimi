import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GuardrailAuditEvent } from "../types/guardrails.ts";

export function appendAuditEvent(auditPath: string, event: GuardrailAuditEvent): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			const dir = dirname(auditPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const line = `${JSON.stringify(event)}\n`;
			appendFileSync(auditPath, line, "utf-8");
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

export function readAuditEvents(auditPath: string): GuardrailAuditEvent[] {
	if (!existsSync(auditPath)) return [];
	const content = readFileSync(auditPath, "utf-8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as GuardrailAuditEvent);
}
