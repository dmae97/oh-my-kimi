/**
 * CommandEnvelope — normalized CLI input.
 * Represents any input to the OMK pipeline: slash commands, direct chat, piped input.
 */

export type CommandKind = "chat" | "run" | "status" | "model" | "memory" | "theme" | "doctor" | "slash" | "pipe" | "resume" | "system";

export type CommandSource = "cli" | "stdin" | "api" | "hook";

export interface CommandEnvelope {
  readonly kind: CommandKind;
  readonly source: CommandSource;
  readonly rawText: string;
  readonly providerPolicy?: string;
  readonly outputProfile?: OutputProfile;
  readonly debug?: boolean;
  readonly timestamp?: string;
}

/**
 * OutputProfile — controls how results are rendered to the user.
 */

export type OutputFormat = "theme" | "nlp" | "json" | "jsonl" | "markdown" | "silent";

export type StdoutMode = "human" | "machine" | "theme" | "nlp" | "raw" | "json";

export interface OutputProfile {
  readonly format: OutputFormat;
  readonly progress: "none" | "live" | "compact" | "jsonl";
  readonly color: "auto" | "always" | "never";
  readonly rawProvider: boolean;
  readonly explainRouting: boolean;
  readonly stdoutMode: StdoutMode;
}

/**
 * OmkEvent — normalized events flowing through the pipeline.
 * ProviderEventNormalizer converts raw provider events to these.
 */

export type OmkEventType =
  | "turn_started"
  | "progress"
  | "mcp_status"
  | "warning"
  | "result"
  | "error"
  | "turn_finished";

export interface OmkEvent {
  readonly type: OmkEventType;
  readonly timestamp: string;
  readonly turnId?: string;
  readonly data?: OmkEventData;
}

export type OmkEventData =
  | {
      readonly kind: "turn_started";
      readonly intent: string;
      readonly provider: string;
    }
  | { readonly kind: "progress"; readonly message: string; readonly percent?: number }
  | {
      readonly kind: "mcp_status";
      readonly server: string;
      readonly status: "connected" | "failed" | "skipped";
    }
  | { readonly kind: "warning"; readonly message: string; readonly code?: string }
  | { readonly kind: "result"; readonly content: string; readonly format: OutputFormat }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: string;
      readonly recoverable: boolean;
    }
  | {
      readonly kind: "turn_finished";
      readonly durationMs: number;
      readonly tokenUsage?: { readonly input: number; readonly output: number };
    };

/**
 * CapabilityInventory — what's available (not what's activated).
 */

export interface CapabilityInventory {
  readonly mcp: readonly McpServerStatus[];
  readonly skills: readonly string[];
  readonly hooks: readonly string[];
  readonly toolsEnabled: boolean;
}

export interface McpServerStatus {
  readonly name: string;
  readonly connected: boolean;
  readonly failed: boolean;
  readonly error?: string;
}

/**
 * CapabilityPlan — what gets activated for this turn.
 */

export type FailurePolicy = "required-only" | "strict" | "lenient";

export interface CapabilityPlan {
  readonly availableMcp: readonly string[];
  readonly requiredMcp: readonly string[];
  readonly optionalMcp: readonly string[];
  readonly disabledMcp: readonly string[];
  readonly selectedSkills: readonly string[];
  readonly failurePolicy: FailurePolicy;
}
