import path from "node:path";
import type { MnemosyneOptions } from "@oh-my-pi/pi-mnemosyne";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export type MnemosyneLlmMode = "none" | "smol" | "remote";

export type MnemosyneScoping = "global" | "per-project" | "per-project-tagged";

export type MnemosyneProviderOptions = Pick<
	MnemosyneOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm"
>;

export interface MnemosyneBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	scoping?: MnemosyneScoping;
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
	const scoping = settings.get("mnemosyne.scoping");
	const scope = resolveBankScope(settings.get("mnemosyne.bank"), cwd, scoping);
	const llmMode = settings.get("mnemosyne.llmMode");
	return {
		dbPath: configuredDbPath ?? path.join(getMemoriesDir(agentDir), "mnemosyne", "mnemosyne.db"),
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks: scope.recallBanks,
		scoping,
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

const DEFAULT_SHARED_BANK = "default";

interface MnemosyneBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

// Mnemosyne does not have built-in tag-filtered recall, so `per-project-tagged`
// maps to a project-local write bank plus a shared recall-visible bank.
function resolveBankScope(configured: string | undefined, cwd: string, scoping: MnemosyneScoping): MnemosyneBankScope {
	const project = projectBank(configured, cwd);
	const globalBank = sharedBank(configured);
	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: [project],
			};
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

function sharedBank(configured: string | undefined): string {
	const raw = configured?.trim();
	return raw || DEFAULT_SHARED_BANK;
}

function projectBank(configured: string | undefined, cwd: string): string {
	const project = normalizeProjectName(cwd);
	const raw = configured?.trim();
	return raw ? `${raw}-${project}` : project;
}

function normalizeProjectName(cwd: string): string {
	const base = path.basename(cwd) || "default";
	return base.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
