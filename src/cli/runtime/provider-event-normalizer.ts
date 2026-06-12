import type { TaskResult } from "../../contracts/orchestration.js";
import type { NormalizedRunEvent } from "./types.js";

export interface NormalizeProviderTaskResultInput {
  readonly taskId: string;
  readonly taskTitle?: string;
  readonly role?: string;
  readonly result: TaskResult;
  readonly timestamp?: string;
  readonly durationMs?: number;
}

export interface NormalizeProviderTelemetryEventInput {
  readonly type: string;
  readonly nodeId?: string;
  readonly provider?: string;
  readonly data?: unknown;
  readonly timestamp?: string;
}

export function normalizeProviderTaskResult(
  input: NormalizeProviderTaskResultInput
): readonly NormalizedRunEvent[] {
  const metadata = asRecord(input.result.metadata);
  if (!metadata) return [];
  const provider = stringField(metadata, "provider");
  if (!provider) return [];

  const timestamp = input.timestamp ?? new Date().toISOString();
  const common = {
    provider,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    role: input.role,
    requestedProvider: stringField(metadata, "requestedProvider"),
    authority: stringField(metadata, "providerAuthority"),
    durationMs: input.durationMs,
    attempts: numberField(metadata, "providerAttemptCount"),
    timestamp,
  };

  const events: NormalizedRunEvent[] = [
    input.result.success
      ? { type: "provider-request-completed", ...common }
      : {
          type: "provider-request-failed",
          ...common,
          error: summarizeProviderError(input.result),
        },
  ];

  const fallback = asRecord(metadata.providerFallback);
  if (fallback) {
    const from = stringField(fallback, "from");
    const to = stringField(fallback, "to");
    const reason = stringField(fallback, "reason");
    if (from && to && reason) {
      events.push({
        type: "provider-fallback",
        taskId: input.taskId,
        from,
        to,
        reason,
        attempts: numberField(fallback, "attempts"),
        failureKind: stringField(fallback, "failureKind"),
        timestamp,
      });
    }
  }

  const assist = asRecord(metadata.providerAssist);
  if (assist) {
    const assistProvider = stringField(assist, "provider");
    const participation = stringField(assist, "participation");
    const success = booleanField(assist, "success");
    if (assistProvider && participation === "advisory" && success !== undefined) {
      events.push({
        type: "provider-assist",
        taskId: input.taskId,
        provider: assistProvider,
        participation: "advisory",
        success,
        model: stringField(assist, "model"),
        modelTier: stringField(assist, "modelTier"),
        summary: stringField(assist, "summary"),
        failureReason: stringField(assist, "failureReason"),
        timestamp,
      });
    }
  }

  const skip = asRecord(metadata.providerSkip);
  if (skip) {
    const skipProvider = stringField(skip, "provider");
    const reason = stringField(skip, "reason");
    if (skipProvider && reason) {
      events.push({
        type: "provider-skip",
        taskId: input.taskId,
        provider: skipProvider,
        reason,
        attempts: numberField(skip, "attempts"),
        failureKind: stringField(skip, "failureKind"),
        timestamp,
      });
    }
  }

  return events;
}

export function normalizeProviderTelemetryEvent(
  input: NormalizeProviderTelemetryEventInput
): NormalizedRunEvent | undefined {
  const taskId = input.nodeId;
  const provider = input.provider;
  if (!taskId || !provider) return undefined;

  const timestamp = input.timestamp ?? new Date().toISOString();
  const data = asRecord(input.data);
  const role = data ? stringField(data, "role") : undefined;
  const durationMs = data ? numberField(data, "durationMs") : undefined;

  if (input.type === "provider.request.started") {
    return {
      type: "provider-request-started",
      provider,
      taskId,
      role,
      timestamp,
    };
  }

  if (input.type === "provider.request.completed") {
    return {
      type: "provider-request-completed",
      provider,
      taskId,
      role,
      durationMs,
      timestamp,
    };
  }

  if (input.type === "provider.request.failed") {
    return {
      type: "provider-request-failed",
      provider,
      taskId,
      role,
      durationMs,
      error: data ? stringField(data, "error") ?? "provider request failed" : "provider request failed",
      timestamp,
    };
  }

  return undefined;
}

function summarizeProviderError(result: TaskResult): string {
  const message = [result.stderr, result.stdout]
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!message) return "provider request failed";
  return message.split(/\r?\n/)[0]?.slice(0, 500) || "provider request failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
