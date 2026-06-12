/**
 * Reasoning Trace Engine — trace store, evidence summaries, privacy redaction.
 *
 * Implements the RTE from OMK CLI V2 Runtime Architecture:
 * - Structured trace capture (NOT raw CoT)
 * - Evidence summaries for user-facing display
 * - Privacy-aware redaction for dataset export
 * - Consent-level based filtering
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type {
  ReasoningTrace,
  ReasoningTraceStore,
  TraceStoreOptions,
  TraceSearchResult,
  TraceSummary,
  ConsentAwareNlgInput,
  ConsentAwareNlgOutput,
  TraceResult,
  TracePrivacy,
  TraceToolCall,
  TraceDecision,
} from "./contracts/reasoning-trace.js";

import type { RequestIntent } from "./debloat-nlp.js";

// ── Trace Factory ───────────────────────────────────────────────

export function createReasoningTrace(input: {
  turnId: string;
  userRequest: string;
  intent: RequestIntent;
  risk: string;
  confidence: number;
  planSummary: string;
  planSteps: readonly string[];
  toolsSelected: readonly string[];
  mcpSelected: readonly string[];
  skillsSelected: readonly string[];
  toolSequence: readonly TraceToolCall[];
  decisionRecords: readonly TraceDecision[];
  durationMs: number;
  retries?: number;
  testResult?: ReasoningTrace["evidence"]["testResult"];
  diffSummary?: string;
  filesChanged?: readonly string[];
  commandsRun?: readonly string[];
  status: TraceResult["status"];
  resultSummary: string;
  failureReason?: string;
  acceptReject: TraceResult["acceptReject"];
  resultConfidence: number;
  privacyLevel: TracePrivacy["level"];
  consentGiven?: boolean;
}): ReasoningTrace {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    turnId: input.turnId,
    timestamp: now,
    userIntent: {
      raw: input.userRequest,
      classified: input.intent,
      risk: input.risk,
      confidence: input.confidence,
    },
    plan: {
      summary: input.planSummary,
      steps: input.planSteps,
      toolsSelected: input.toolsSelected,
      mcpSelected: input.mcpSelected,
      skillsSelected: input.skillsSelected,
    },
    execution: {
      toolSequence: input.toolSequence,
      decisionRecords: input.decisionRecords,
      durationMs: input.durationMs,
      retries: input.retries ?? 0,
    },
    evidence: {
      testResult: input.testResult,
      diffSummary: input.diffSummary,
      filesChanged: input.filesChanged ?? [],
      commandsRun: input.commandsRun ?? [],
      screenshots: [],
    },
    result: {
      status: input.status,
      summary: input.resultSummary,
      failureReason: input.failureReason,
      acceptReject: input.acceptReject,
      confidence: input.resultConfidence,
    },
    privacy: {
      level: input.privacyLevel,
      redacted: false,
      includedInDataset: false,
      consentGiven: input.consentGiven ?? false,
      redactionRules: [],
    },
  };
}

// ── Privacy Redaction ───────────────────────────────────────────

const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string; label: string }> = [
  { pattern: /(?:sk|sk-|key-|api[_-]?key[_=:]?\s*)[A-Za-z0-9_-]{20,}/gi, replacement: "[API_KEY_REDACTED]", label: "api_key" },
  { pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}/g, replacement: "[GITHUB_TOKEN_REDACTED]", label: "github_token" },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: "[PRIVATE_KEY_REDACTED]", label: "private_key" },
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, replacement: "[PASSWORD_REDACTED]", label: "password" },
  { pattern: /\/home\/[^/\s]+/g, replacement: "/home/[USER]", label: "home_path" },
  { pattern: /\/Users\/[^/\s]+/g, replacement: "/Users/[USER]", label: "user_path" },
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL_REDACTED]", label: "email" },
];

export function redactText(text: string, level: TracePrivacy["level"]): { text: string; applied: readonly string[] } {
  let result = text;
  const applied: string[] = [];

  for (const { pattern, replacement, label } of REDACTION_PATTERNS) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before && !applied.includes(label)) {
      applied.push(label);
    }
  }

  if (level === "l0") {
    return { text: "[REDACTED_L0]", applied: ["full_redaction"] };
  }

  return { text: result, applied };
}

export function redactTrace(trace: ReasoningTrace): ReasoningTrace {
  const { text: redactedIntent, applied: intentRedactions } = redactText(trace.userIntent.raw, trace.privacy.level);
  const { text: redactedPlan, applied: planRedactions } = redactText(trace.plan.summary, trace.privacy.level);
  const { text: redactedResult, applied: resultRedactions } = redactText(trace.result.summary, trace.privacy.level);

  const redactedTools = trace.execution.toolSequence.map((tc) => ({
    ...tc,
    args: tc.args ? redactText(tc.args, trace.privacy.level).text : undefined,
    resultSummary: redactText(tc.resultSummary, trace.privacy.level).text,
  }));

  const redactedDiff = trace.evidence.diffSummary
    ? redactText(trace.evidence.diffSummary, trace.privacy.level).text
    : undefined;

  const allRedactions = [...new Set([...intentRedactions, ...planRedactions, ...resultRedactions])];

  return {
    ...trace,
    userIntent: { ...trace.userIntent, raw: redactedIntent },
    plan: { ...trace.plan, summary: redactedPlan },
    execution: { ...trace.execution, toolSequence: redactedTools },
    evidence: { ...trace.evidence, diffSummary: redactedDiff },
    result: { ...trace.result, summary: redactedResult },
    privacy: {
      ...trace.privacy,
      redacted: true,
      redactionRules: allRedactions,
    },
  };
}

// ── Evidence Summary ────────────────────────────────────────────

export function summarizeTrace(trace: ReasoningTrace): TraceSummary {
  const toolNames = [...new Set(trace.execution.toolSequence.map((t) => t.name))];
  const testStr = trace.evidence.testResult
    ? `${trace.evidence.testResult.passed}/${trace.evidence.testResult.passed + trace.evidence.testResult.failed} passed`
    : undefined;

  const durationSec = Math.round(trace.execution.durationMs / 1000);
  const durationStr = durationSec < 60 ? `${durationSec}s` : `${Math.round(durationSec / 60)}m ${durationSec % 60}s`;

  return {
    intent: trace.userIntent.classified,
    planSummary: trace.plan.summary,
    toolsUsed: toolNames,
    testResult: testStr,
    outcome: trace.result.summary,
    duration: durationStr,
    confidence: trace.result.confidence,
  };
}

// ── Consent-Aware NLG ───────────────────────────────────────────

export function generateConsentReport(input: ConsentAwareNlgInput): ConsentAwareNlgOutput {
  const trace = input.consentLevel === "l0" ? redactTrace(input.trace) : input.trace;
  const summary = summarizeTrace(trace);
  const redactedFields: string[] = [];

  const files = input.includeFiles ? trace.evidence.filesChanged : [];
  const commands = input.includeCommands ? trace.evidence.commandsRun : [];

  if (!input.includeFiles) redactedFields.push("filesChanged");
  if (!input.includeCommands) redactedFields.push("commandsRun");

  if (input.consentLevel === "l0") {
    redactedFields.push("full_redaction");
  }

  const lines: string[] = [];
  const lang = input.language;

  if (lang === "ko") {
    lines.push(`## 작업 추론 요약`);
    lines.push(`**의도:** ${summary.intent} (신뢰도: ${Math.round(summary.confidence * 100)}%)`);
    lines.push(`**계획:** ${summary.planSummary}`);
    if (summary.toolsUsed.length > 0) lines.push(`**사용 도구:** ${summary.toolsUsed.join(", ")}`);
    if (summary.testResult) lines.push(`**테스트:** ${summary.testResult}`);
    lines.push(`**결과:** ${summary.outcome}`);
    lines.push(`**소요 시간:** ${summary.duration}`);
    if (files.length > 0) {
      lines.push(`**변경 파일:** ${files.length}개`);
    }
    if (commands.length > 0) {
      lines.push(`**실행 명령:** ${commands.length}개`);
    }
    if (trace.result.failureReason) {
      lines.push(`**실패 원인:** ${trace.result.failureReason}`);
    }
  } else {
    lines.push(`## Reasoning Summary`);
    lines.push(`**Intent:** ${summary.intent} (confidence: ${Math.round(summary.confidence * 100)}%)`);
    lines.push(`**Plan:** ${summary.planSummary}`);
    if (summary.toolsUsed.length > 0) lines.push(`**Tools:** ${summary.toolsUsed.join(", ")}`);
    if (summary.testResult) lines.push(`**Tests:** ${summary.testResult}`);
    lines.push(`**Outcome:** ${summary.outcome}`);
    lines.push(`**Duration:** ${summary.duration}`);
    if (files.length > 0) {
      lines.push(`**Files changed:** ${files.length}`);
    }
    if (commands.length > 0) {
      lines.push(`**Commands run:** ${commands.length}`);
    }
    if (trace.result.failureReason) {
      lines.push(`**Failure reason:** ${trace.result.failureReason}`);
    }
  }

  const eligible = input.consentLevel !== "l0" && trace.privacy.consentGiven;

  return {
    summary,
    report: lines.join("\n"),
    redactedFields,
    eligibleForDataset: eligible,
  };
}

// ── File-Based Trace Store ──────────────────────────────────────

export function createReasoningTraceStore(options?: TraceStoreOptions): ReasoningTraceStore {
  const baseDir = options?.baseDir ?? ".omk/traces";
  const maxTraces = options?.maxTraces ?? 1000;

  return {
    async append(trace: ReasoningTrace): Promise<void> {
      await mkdir(baseDir, { recursive: true });
      const filePath = join(baseDir, `${trace.id}.json`);
      await writeFile(filePath, JSON.stringify(trace, null, 2), "utf-8");

      // Enforce max traces limit
      const entries = await readdir(baseDir);
      const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
      if (jsonFiles.length > maxTraces) {
        const toDelete = jsonFiles.slice(0, jsonFiles.length - maxTraces);
        for (const f of toDelete) {
          await unlink(join(baseDir, f)).catch(() => {});
        }
      }
    },

    async load(traceId: string): Promise<ReasoningTrace | undefined> {
      try {
        const filePath = join(baseDir, `${traceId}.json`);
        const data = await readFile(filePath, "utf-8");
        return JSON.parse(data) as ReasoningTrace;
      } catch {
        return undefined;
      }
    },

    async search(query: string, limit = 10): Promise<readonly TraceSearchResult[]> {
      const all = await this.list(maxTraces);
      const queryLower = query.toLowerCase();
      const results: TraceSearchResult[] = [];

      for (const trace of all) {
        let relevance = 0;
        if (trace.userIntent.raw.toLowerCase().includes(queryLower)) relevance += 3;
        if (trace.plan.summary.toLowerCase().includes(queryLower)) relevance += 2;
        if (trace.result.summary.toLowerCase().includes(queryLower)) relevance += 1;
        for (const tc of trace.execution.toolSequence) {
          if (tc.name.toLowerCase().includes(queryLower)) relevance += 1;
        }
        if (relevance > 0) {
          results.push({ trace, relevance });
        }
      }

      return results.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
    },

    async list(limit = 100): Promise<readonly ReasoningTrace[]> {
      try {
        const entries = await readdir(baseDir);
        const jsonFiles = entries
          .filter((e) => e.endsWith(".json"))
          .sort()
          .reverse()
          .slice(0, limit);

        const traces: ReasoningTrace[] = [];
        for (const f of jsonFiles) {
          try {
            const data = await readFile(join(baseDir, f), "utf-8");
            traces.push(JSON.parse(data) as ReasoningTrace);
          } catch {
            // Skip corrupted files
          }
        }
        return traces;
      } catch {
        return [];
      }
    },

    async clear(): Promise<void> {
      try {
        const entries = await readdir(baseDir);
        for (const f of entries.filter((e) => e.endsWith(".json"))) {
          await unlink(join(baseDir, f)).catch(() => {});
        }
      } catch {
        // Directory doesn't exist
      }
    },

    async exportRedacted(level: TracePrivacy["level"]): Promise<readonly ReasoningTrace[]> {
      const all = await this.list(maxTraces);
      return all
        .filter((t) => t.privacy.consentGiven && t.privacy.level !== "l0")
        .map((t) => redactTrace({ ...t, privacy: { ...t.privacy, level } }));
    },
  };
}
