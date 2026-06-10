/**
 * Resolve auth-broker connection configuration for the local omp client.
 *
 * Precedence (highest first):
 *   1. `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` env vars.
 *   2. `auth.broker.url` / `auth.broker.token` in `~/.omp/agent/config.yml`
 *      (hidden from the settings UI; `!command` resolution supported).
 *   3. Token file `~/.omp/auth-broker.token` (paired with URL from env or config).
 *
 * Returns null when no broker URL is configured — caller falls back to the
 * local SQLite store.
 *
 * Reads config.yml directly (instead of going through `Settings.init`) because
 * `discoverAuthStorage` runs before the settings singleton is initialized in
 * `runRootCommand`, and we want hand-edited config entries to be honoured at
 * boot without forcing a startup reorder.
 */
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { resolveConfigValue } from "../config/resolve-config-value";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

/** Path to the local bearer token file. Created on the broker host by `omp auth-broker token`. */
export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

async function readTokenFile(): Promise<string | null> {
	try {
		const raw = await Bun.file(getAuthBrokerTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("auth-broker token file unreadable", { error: String(err) });
		return null;
	}
}

interface ConfigSnapshot {
	url?: string;
	token?: string;
}

async function readConfigYaml(): Promise<ConfigSnapshot> {
	const configPath = path.join(getAgentDir(), "config.yml");
	try {
		const raw = await Bun.file(configPath).text();
		const parsed = YAML.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const url = typeof record["auth.broker.url"] === "string" ? (record["auth.broker.url"] as string) : undefined;
		const token =
			typeof record["auth.broker.token"] === "string" ? (record["auth.broker.token"] as string) : undefined;
		return { url, token };
	} catch (err) {
		if (isEnoent(err)) return {};
		logger.warn("auth-broker config.yml unreadable", { error: String(err) });
		return {};
	}
}

/**
 * Process-lifetime memo for {@link resolveAuthBrokerConfig}. Keyed on the env
 * inputs (plus agent dir, which decides which config.yml is read) so tests
 * that flip `OMP_AUTH_BROKER_*` between cases still observe the change, while
 * repeated resolution within one CLI invocation (startup, subagent sessions)
 * skips the config.yml read and any `!command` token resolution.
 */
let cachedConfigKey: string | null = null;
let cachedConfigPromise: Promise<AuthBrokerClientConfig | null> | null = null;

/**
 * Read broker configuration. Returns null when the URL is missing
 * (broker disabled — local store is used). Throws when URL is set but no
 * token is available — the caller cannot fall back silently because the
 * user explicitly asked to use the broker.
 *
 * Successful resolutions (including "no broker configured") are memoized for
 * the process lifetime; failures are not, so a missing token can be fixed and
 * retried. Concurrent callers share one in-flight resolution.
 */
export function resolveAuthBrokerConfig(): Promise<AuthBrokerClientConfig | null> {
	const key = `${process.env.OMP_AUTH_BROKER_URL ?? ""}\u0000${process.env.OMP_AUTH_BROKER_TOKEN ?? ""}\u0000${getAgentDir()}`;
	if (cachedConfigPromise && cachedConfigKey === key) return cachedConfigPromise;
	const promise = resolveAuthBrokerConfigUncached();
	cachedConfigKey = key;
	cachedConfigPromise = promise;
	promise.catch(() => {
		if (cachedConfigPromise === promise) {
			cachedConfigPromise = null;
			cachedConfigKey = null;
		}
	});
	return promise;
}

async function resolveAuthBrokerConfigUncached(): Promise<AuthBrokerClientConfig | null> {
	const envUrl = process.env.OMP_AUTH_BROKER_URL;
	const envToken = process.env.OMP_AUTH_BROKER_TOKEN;

	let url = envUrl && envUrl.length > 0 ? envUrl : undefined;
	let configToken: string | undefined;
	if (!url || !envToken) {
		const fromConfig = await readConfigYaml();
		if (!url && fromConfig.url) {
			const resolved = await resolveConfigValue(fromConfig.url);
			if (resolved && resolved.length > 0) url = resolved;
		}
		if (fromConfig.token) {
			const resolved = await resolveConfigValue(fromConfig.token);
			if (resolved && resolved.length > 0) configToken = resolved;
		}
	}
	if (!url) return null;

	const token =
		(envToken && envToken.length > 0 ? envToken : undefined) ?? configToken ?? (await readTokenFile()) ?? undefined;
	if (!token) {
		throw new Error(
			`OMP_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set OMP_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}
