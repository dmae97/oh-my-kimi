import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DoctorErrorCategory = "network" | "auth" | "model" | "config" | "unknown";

export interface ProviderDoctorResult {
	provider: string;
	status: "ok" | "fail";
	baseUrl?: string;
	checks: ProviderDoctorCheck[];
	error?: {
		category: DoctorErrorCategory;
		message: string;
	};
}

export interface ProviderDoctorCheck {
	name: string;
	status: "ok" | "fail" | "skipped";
	message?: string;
}

interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
}

export function getAgentDir(): string {
	return join(homedir(), ".omk", "agent");
}

function loadJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function resolveConfig(providerId: string): { config: ProviderConfig; source: string } | undefined {
	const agentDir = getAgentDir();

	const modelsPath = join(agentDir, "models.json");
	const models = loadJson<{ providers?: Record<string, ProviderConfig> }>(modelsPath);
	if (models?.providers?.[providerId]) {
		return { config: models.providers[providerId], source: "models.json" };
	}

	const authPath = join(agentDir, "auth.json");
	const auth = loadJson<Record<string, { type: string; key?: string }>>(authPath);
	if (auth?.[providerId]) {
		return {
			config: { apiKey: auth[providerId].key },
			source: "auth.json",
		};
	}

	return undefined;
}

export async function diagnoseProvider(providerId: string): Promise<ProviderDoctorResult> {
	const resolved = resolveConfig(providerId);
	if (!resolved) {
		return {
			provider: providerId,
			status: "fail",
			checks: [],
			error: { category: "config", message: `Provider "${providerId}" not found in models.json or auth.json` },
		};
	}

	const { config } = resolved;
	const checks: ProviderDoctorCheck[] = [];

	// 1. Config presence
	checks.push({
		name: "config-present",
		status: "ok",
		message: `Found provider config in ${resolved.source}`,
	});

	// 2. Base URL reachability
	if (config.baseUrl) {
		try {
			const res = await fetch(config.baseUrl, { method: "GET" });
			checks.push({
				name: "base-url-reachable",
				status: res.ok ? "ok" : "fail",
				message: `HTTP ${res.status}`,
			});
		} catch (err) {
			checks.push({
				name: "base-url-reachable",
				status: "fail",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	} else {
		checks.push({ name: "base-url-reachable", status: "skipped", message: "No baseUrl configured" });
	}

	// 3. API key presence (never log the value)
	checks.push({
		name: "api-key-present",
		status: config.apiKey ? "ok" : "skipped",
		message: config.apiKey ? "API key is configured" : "No API key configured",
	});

	// 4. Models endpoint probe
	if (config.baseUrl) {
		try {
			const headers: Record<string, string> = {};
			if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
			const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, { headers });
			checks.push({
				name: "models-endpoint",
				status: res.ok ? "ok" : "fail",
				message: `HTTP ${res.status}`,
			});
		} catch (err) {
			checks.push({
				name: "models-endpoint",
				status: "fail",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	} else {
		checks.push({ name: "models-endpoint", status: "skipped", message: "No baseUrl configured" });
	}

	const failed = checks.find((c) => c.status === "fail");
	let error: ProviderDoctorResult["error"];
	if (failed) {
		const category: DoctorErrorCategory =
			failed.name === "base-url-reachable"
				? "network"
				: failed.name === "api-key-present"
					? "auth"
					: failed.name === "models-endpoint"
						? "model"
						: "unknown";
		error = { category, message: failed.message ?? `${failed.name} failed` };
	}

	return {
		provider: providerId,
		status: failed ? "fail" : "ok",
		baseUrl: config.baseUrl,
		checks,
		error,
	};
}
