import path from "node:path";
import type { MnemosyneOptions } from "@oh-my-pi/pi-mnemosyne";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export type MnemosyneLlmMode = "none" | "smol" | "remote";

export type MnemosyneProviderOptions = Pick<
	MnemosyneOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm"
>;

export interface MnemosyneBackendConfig {
	dbPath: string;
	bank: string;
	autoRecall: boolean;
	autoRetain: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	debug: boolean;
	providerOptions: MnemosyneProviderOptions;
	llmMode: MnemosyneLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

export function loadMnemosyneConfig(settings: Settings, agentDir: string): MnemosyneBackendConfig {
	const configuredDbPath = settings.get("mnemosyne.dbPath");
	const cwd = settings.getCwd();
	const bank = normalizeBank(settings.get("mnemosyne.bank"), cwd);
	const llmMode = settings.get("mnemosyne.llmMode");
	return {
		dbPath: configuredDbPath ?? path.join(getMemoriesDir(agentDir), "mnemosyne", "mnemosyne.db"),
		bank,
		autoRecall: settings.get("mnemosyne.autoRecall"),
		autoRetain: settings.get("mnemosyne.autoRetain"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemosyne.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemosyne.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemosyne.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemosyne.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemosyne.injectionTokenLimit"))),
		debug: settings.get("mnemosyne.debug"),
		providerOptions: {
			noEmbeddings: settings.get("mnemosyne.noEmbeddings"),
			embeddingModel: settings.get("mnemosyne.embeddingModel"),
			embeddingApiUrl: settings.get("mnemosyne.embeddingApiUrl"),
			embeddingApiKey: settings.get("mnemosyne.embeddingApiKey"),
			llm:
				llmMode === "remote"
					? {
							baseUrl: settings.get("mnemosyne.llmBaseUrl"),
							apiKey: settings.get("mnemosyne.llmApiKey"),
							model: settings.get("mnemosyne.llmModel"),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: settings.get("mnemosyne.llmBaseUrl"),
		llmApiKey: settings.get("mnemosyne.llmApiKey"),
		llmModel: settings.get("mnemosyne.llmModel"),
	};
}

function normalizeBank(configured: string | undefined, cwd: string): string {
	const raw = configured?.trim();
	if (raw) return raw;
	const base = path.basename(cwd) || "default";
	return base.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
