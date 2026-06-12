export type RuntimeSandboxMode = "read-only" | "workspace-write";

export type RuntimeSandboxEnforcement = "env-only" | "provider-native" | "not-enforced";

export type RuntimeNetworkPolicy = "unspecified" | "allowed" | "blocked-planned";

export type RuntimeSecretEnvPolicy = "drop-by-default" | "explicit-grants";

export interface RuntimeSandboxProfile {
  readonly mode: RuntimeSandboxMode;
  readonly enforcement: RuntimeSandboxEnforcement;
  readonly cwd: string;
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
  readonly network: RuntimeNetworkPolicy;
  readonly secretEnvPolicy: RuntimeSecretEnvPolicy;
  readonly notes?: readonly string[];
}

export interface CreateRuntimeSandboxProfileOptions {
  readonly cwd: string;
  readonly mode?: RuntimeSandboxMode;
  readonly enforcement?: RuntimeSandboxEnforcement;
  readonly writableRoots?: readonly string[];
  readonly readableRoots?: readonly string[];
  readonly network?: RuntimeNetworkPolicy;
  readonly secretEnvPolicy?: RuntimeSecretEnvPolicy;
  readonly notes?: readonly string[];
}

export function createRuntimeSandboxProfile(
  options: CreateRuntimeSandboxProfileOptions
): RuntimeSandboxProfile {
  const mode = options.mode ?? "read-only";
  const enforcement = options.enforcement ?? "env-only";
  return {
    mode,
    enforcement,
    cwd: options.cwd,
    writableRoots: options.writableRoots ?? defaultWritableRoots(mode, enforcement, options.cwd),
    readableRoots: options.readableRoots ?? [options.cwd],
    network: options.network ?? "unspecified",
    secretEnvPolicy: options.secretEnvPolicy ?? "drop-by-default",
    notes: options.notes ?? defaultSandboxNotes(enforcement),
  };
}

function defaultWritableRoots(
  mode: RuntimeSandboxMode,
  enforcement: RuntimeSandboxEnforcement,
  cwd: string
): readonly string[] {
  if (mode === "workspace-write" && enforcement === "provider-native") return [cwd];
  return [];
}

function defaultSandboxNotes(enforcement: RuntimeSandboxEnforcement): readonly string[] {
  if (enforcement === "provider-native") {
    return [
      "OMK sanitizes child env.",
      "Runtime receives provider-native sandbox flags.",
      "OMK does not yet enforce OS-level filesystem or network isolation.",
    ];
  }
  if (enforcement === "env-only") {
    return [
      "Child runtime env is sanitized.",
      "OS-level sandboxing is future work.",
    ];
  }
  return ["OS-level sandbox enforcement is not configured."];
}
