const LOADER_INJECTION_VARS: readonly string[] = ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES"];

const SECRET_NAME_PATTERNS: readonly RegExp[] = [
	/_API_KEY$/i,
	/_API_TOKEN$/i,
	/_ACCESS_TOKEN$/i,
	/_SECRET$/i,
	/_SECRET_KEY$/i,
	/_PRIVATE_KEY$/i,
	/_PASSWORD$/i,
	/_PASSWD$/i,
	/_TOKEN$/i,
	/^NPM_TOKEN$/i,
	/^NODE_AUTH_TOKEN$/i,
	/^GITHUB_TOKEN$/i,
	/^GH_TOKEN$/i,
	/^GITLAB_TOKEN$/i,
	/^OPENAI_API_KEY$/i,
	/^ANTHROPIC_API_KEY$/i,
	/^GOOGLE_API_KEY$/i,
	/^AZURE_API_KEY$/i,
	/^AWS_ACCESS_KEY_ID$/i,
	/^AWS_SECRET_ACCESS_KEY$/i,
];

export interface FilterSandboxEnvOptions {
	readonly allowlist?: readonly string[];
	readonly extraBlocklist?: readonly string[];
}

function isSecretName(name: string, allowlist: Set<string>): boolean {
	if (allowlist.has(name)) return false;
	return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export function filterSandboxEnv(
	env: NodeJS.ProcessEnv,
	options: FilterSandboxEnvOptions = {},
): Record<string, string> {
	const allowlist = new Set(options.allowlist ?? []);
	const extraBlocklist = new Set(options.extraBlocklist ?? []);
	const result: Record<string, string> = {};

	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (LOADER_INJECTION_VARS.includes(key)) continue;
		if (extraBlocklist.has(key)) continue;
		if (isSecretName(key, allowlist)) continue;
		result[key] = value;
	}

	return result;
}
