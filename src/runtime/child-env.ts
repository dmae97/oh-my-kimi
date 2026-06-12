export type ChildEnvSource = Readonly<Record<string, string | undefined>>;

export const DEFAULT_CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "OMK_ORIGINAL_HOME",
  "OMK_PROJECT_ROOT",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

export interface ChildEnvOptions {
  readonly parentEnv?: ChildEnvSource;
  readonly overrideEnv?: ChildEnvSource;
  readonly inheritParentEnv?: boolean;
  readonly allowedParentEnvNames?: readonly string[];
  readonly allowedSecretEnvNames?: readonly string[];
  readonly allowSecretPassthrough?: boolean;
}

export interface ChildEnvAuditMetadata {
  readonly grantedSecretEnvNames: readonly string[];
  readonly deniedSecretEnvNames: readonly string[];
  readonly deniedChildEnvNames: readonly string[];
}

export interface ChildEnvBuildResult {
  readonly env: Record<string, string>;
  readonly metadata: ChildEnvAuditMetadata;
}

export interface RuntimeChildEnvMetadata {
  readonly runtimeId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly role?: string;
  readonly goal?: string;
}

const SECRET_LIKE_ENV_NAME =
  /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|BEARER|COOKIE|CREDENTIAL|PASS(?:WORD)?|PRIVATE|SECRET|SESSION|TOKEN)(?:_|$)/iu;

const DENIED_CHILD_ENV_NAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^AWS_/iu,
  /^GOOGLE_APPLICATION_CREDENTIALS$/iu,
  /^GITHUB_TOKEN$/iu,
  /^GH_TOKEN$/iu,
  /^NPM_TOKEN$/iu,
  /^NODE_AUTH_TOKEN$/iu,
  /^SSH_AUTH_SOCK$/iu,
  /^KUBECONFIG$/iu,
  /(?:^|_)DOTENV(?:_|$)/iu,
  /(?:^|_)ENV_FILE(?:_|$)/iu,
  /(?:^|_)ENV_PATH(?:_|$)/iu,
]);

function normalizeEnvName(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

function envNameSet(names: readonly string[]): Set<string> {
  return new Set(names.map((name) => normalizeEnvName(name)));
}

function sortedNames(names: ReadonlySet<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function validEnvName(name: string): boolean {
  return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

function validEnvValue(value: string | undefined): value is string {
  return value !== undefined && !value.includes("\0");
}

export function isSecretLikeEnvName(name: string): boolean {
  return SECRET_LIKE_ENV_NAME.test(name);
}

export function isDeniedChildEnvName(name: string): boolean {
  return DENIED_CHILD_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function hasExplicitSecretGrant(name: string, options: ChildEnvOptions, allowedSecretNames: ReadonlySet<string>): boolean {
  return options.allowSecretPassthrough === true && allowedSecretNames.has(normalizeEnvName(name));
}

export function buildChildEnvWithMetadata(options: ChildEnvOptions = {}): ChildEnvBuildResult {
  const parentEnv = options.parentEnv ?? process.env;
  const allowedNames = envNameSet(options.allowedParentEnvNames ?? DEFAULT_CHILD_ENV_ALLOWLIST);
  const allowedSecretNames = envNameSet(options.allowedSecretEnvNames ?? []);
  const inheritParentEnv = options.inheritParentEnv ?? false;
  const childEnv: Record<string, string> = {};
  const grantedSecretEnvNames = new Set<string>();
  const deniedSecretEnvNames = new Set<string>();
  const deniedChildEnvNames = new Set<string>();

  for (const [name, value] of Object.entries(parentEnv)) {
    if (!validEnvName(name) || !validEnvValue(value)) continue;
    const normalizedName = normalizeEnvName(name);
    const isAllowed = allowedNames.has(normalizedName);
    if (isDeniedChildEnvName(name)) {
      deniedChildEnvNames.add(name);
      continue;
    }
    if (!isAllowed && !inheritParentEnv) continue;
    if (isSecretLikeEnvName(name)) {
      if (!hasExplicitSecretGrant(name, options, allowedSecretNames)) {
        deniedSecretEnvNames.add(name);
        continue;
      }
      grantedSecretEnvNames.add(name);
    }
    childEnv[name] = value;
  }

  for (const [name, value] of Object.entries(options.overrideEnv ?? {})) {
    if (!validEnvName(name) || !validEnvValue(value)) continue;
    if (isDeniedChildEnvName(name)) {
      deniedChildEnvNames.add(name);
      continue;
    }
    if (isSecretLikeEnvName(name)) {
      if (!hasExplicitSecretGrant(name, options, allowedSecretNames)) {
        deniedSecretEnvNames.add(name);
        continue;
      }
      grantedSecretEnvNames.add(name);
    }
    childEnv[name] = value;
  }

  return {
    env: childEnv,
    metadata: {
      grantedSecretEnvNames: sortedNames(grantedSecretEnvNames),
      deniedSecretEnvNames: sortedNames(deniedSecretEnvNames),
      deniedChildEnvNames: sortedNames(deniedChildEnvNames),
    },
  };
}

export function buildChildEnv(options: ChildEnvOptions = {}): Record<string, string> {
  const { env } = buildChildEnvWithMetadata(options);
  return env;
}

export function runtimeMetadataEnv(metadata: RuntimeChildEnvMetadata): Record<string, string> {
  return buildChildEnv({
    parentEnv: {},
    overrideEnv: {
      OMK_RUNTIME_ID: metadata.runtimeId,
      OMK_RUN_ID: metadata.runId,
      OMK_NODE_ID: metadata.nodeId,
      OMK_ROLE: metadata.role,
      OMK_GOAL: metadata.goal,
    },
  });
}
