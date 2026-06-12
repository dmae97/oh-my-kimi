import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export function compareCodepoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const leftCode = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightCode = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftCode !== rightCode) return leftCode - rightCode;
  }

  return leftPoints.length - rightPoints.length;
}

export function stableJsonStringify(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const entries = Object.entries(objectValue)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareCodepoints(left, right));

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
      .join(",")}}`;
  }

  return "null";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableValueHash(value: unknown): string {
  return sha256Hex(stableJsonStringify(value));
}
