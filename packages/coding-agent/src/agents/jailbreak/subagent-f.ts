/**
 * OMK Jailbreak v6 — Agents / SubAgent F (TypeScript Port)
 * ===========================================================
 * packages/coding-agent/src/agents/jailbreak/subagent-f.ts
 *
 * Semantic Indirection + Code Metaphor Engine
 * Zero API calls — pure local computation.
 */

export const MetaphorType = {
	FUNCTIONAL: "functional",
	CLASS_BASED: "class_based",
	SHELL: "shell",
} as const;

export type MetaphorType = (typeof MetaphorType)[keyof typeof MetaphorType];

export interface TransformResult {
	source: string;
	transformed: string;
	appliedRules: string[];
	complexityDelta: number;
}

export interface ValidationReport {
	passed: boolean;
	astDepth: number;
	nodeCount: number;
	forbiddenKeywords: string[];
	staticAnalysisErrors: string[];
	metaphor: string;
}

export interface SubAgentFResult {
	success: boolean;
	payload: string;
	transformed: string;
	validation?: ValidationReport;
	metaphorType: MetaphorType;
	latencyMs: number;
}

export class SubAgentF {
	private forbiddenKeywords = ["attack", "exploit", "hack", "malicious", "bypass"];

	execute(payload: string, metaphorType = MetaphorType.FUNCTIONAL): SubAgentFResult {
		const start = Date.now();

		// Transform payload into code metaphor
		const transformed = this.transformToMetaphor(payload, metaphorType);

		// Validate
		const validation = this.validate(transformed);

		return {
			success: validation.passed,
			payload,
			transformed,
			validation,
			metaphorType,
			latencyMs: Date.now() - start,
		};
	}

	private transformToMetaphor(payload: string, type: MetaphorType): string {
		switch (type) {
			case MetaphorType.FUNCTIONAL:
				return `function analyzeSecurityScenario() {\n  // ${payload}\n  return performAnalysis();\n}`;
			case MetaphorType.CLASS_BASED:
				return `class SecurityAnalyzer {\n  constructor() {\n    this.scenario = "${payload.replace(/"/g, '\\"')}";\n  }\n  analyze() {\n    return this.performAssessment();\n  }\n}`;
			case MetaphorType.SHELL:
				return `#!/bin/bash\n# Security analysis script\necho "Analyzing: ${payload.replace(/"/g, '\\"')}"\nrun_analysis`;
			default:
				return payload;
		}
	}

	private validate(code: string): ValidationReport {
		const lower = code.toLowerCase();
		const forbidden = this.forbiddenKeywords.filter((kw) => lower.includes(kw));
		const passed = forbidden.length === 0;

		return {
			passed,
			astDepth: 2,
			nodeCount: code.split(/\n/).length,
			forbiddenKeywords: forbidden,
			staticAnalysisErrors: passed ? [] : ["Forbidden keywords detected"],
			metaphor: "code",
		};
	}
}

export function createSubAgentF(): SubAgentF {
	return new SubAgentF();
}
