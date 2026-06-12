/**
 * Phase 1 — InputResolver
 * Resolves the actual goal/content from argv, stdin, or file.
 */

import { readFileSync } from "node:fs";
import type { NormalizedInput, InputSource } from "../runtime/types.js";

export interface ResolveInputOptions {
  readonly source: InputSource;
  readonly positionalArgs: readonly string[];
  readonly flags: Record<string, string | boolean | undefined>;
  readonly hasStdinPipe: boolean;
  readonly cwd: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

export async function resolveInput(opts: ResolveInputOptions): Promise<Pick<NormalizedInput, "source" | "goal" | "goalFile" | "teamFile" | "taskFile" | "orchestratorFile" | "coordinatorFile">> {
  let goal: string | undefined;
  let goalFile: string | undefined;
  const teamFile = typeof opts.flags["team"] === "string" ? opts.flags["team"] : undefined;
  const taskFile = typeof opts.flags["file"] === "string" ? opts.flags["file"] : undefined;
  const orchestratorFile = typeof opts.flags["orchestrator"] === "string" ? opts.flags["orchestrator"] : undefined;
  const coordinatorFile = typeof opts.flags["coordinator"] === "string" ? opts.flags["coordinator"] : undefined;

  if (opts.source === "stdin" && opts.hasStdinPipe) {
    goal = await readStdin();
  } else if (opts.source === "file") {
    const path = typeof opts.flags["goal-file"] === "string" ? opts.flags["goal-file"] : undefined;
    if (path) {
      goalFile = path;
      goal = readFileSync(path, "utf-8");
    }
  } else {
    // argv positional goal
    if (opts.positionalArgs.length > 0) {
      goal = opts.positionalArgs.join(" ");
    }
    // fallback to --goal flag
    if (!goal && typeof opts.flags["goal"] === "string") {
      goal = opts.flags["goal"];
    }
  }

  return {
    source: opts.source,
    goal: goal?.trim() || undefined,
    goalFile,
    teamFile,
    taskFile,
    orchestratorFile,
    coordinatorFile,
  };
}
