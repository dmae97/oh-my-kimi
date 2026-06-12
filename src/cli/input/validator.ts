/**
 * Phase 1 — Validator
 * Lightweight validation for resolved input before building CommandEnvelope.
 */

import { existsSync } from "node:fs";
import type { NormalizedInput, NormalizedCliError } from "../runtime/types.js";

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly NormalizedCliError[];
}

export function validateInput(input: NormalizedInput): ValidationResult {
  const errors: NormalizedCliError[] = [];

  if (!input.goal && !input.taskFile) {
    errors.push({
      kind: "validation",
      message: "A goal or task file is required.",
      hint: "Provide a positional goal, --goal, --goal-file, or pipe via stdin. For fixed tasks use --file.",
    });
  }

  if (input.teamFile && !existsSync(input.teamFile)) {
    errors.push({
      kind: "validation",
      message: `Team file not found: ${input.teamFile}`,
      hint: "Check the path or generate one with `omk init`.",
    });
  }

  if (input.taskFile && !existsSync(input.taskFile)) {
    errors.push({
      kind: "validation",
      message: `Task file not found: ${input.taskFile}`,
      hint: "Check the path or use `omk task --generate` to scaffold one.",
    });
  }

  if (input.goalFile && !existsSync(input.goalFile)) {
    errors.push({
      kind: "validation",
      message: `Goal file not found: ${input.goalFile}`,
      hint: "Check the path.",
    });
  }

  return { valid: errors.length === 0, errors };
}
