/**
 * Small deterministic hash helper for sourceResultHash.
 */
import { createHash } from "node:crypto";

export function hashResult(result: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(result), "utf-8")
    .digest("hex")
    .slice(0, 16);
}
