import * as path from "node:path";
import type { MnemosyneOptions } from "@oh-my-pi/pi-mnemosyne";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";

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
	return sanitizeBankName(configured) ?? DEFAULT_SHARED_BANK;
}

function projectBank(configured: string | undefined, cwd: string): string {
	const projectRoot = git.repo.resolveSync(cwd)?.repoRoot ?? path.resolve(cwd);
	const project = projectBankSegment(projectRoot);
	const base = sanitizeBankName(configured);
	return limitBankName(base ? `${base}-${project}` : project);
}

function projectBankSegment(projectRoot: string): string {
	const project = sanitizeBankName(path.basename(projectRoot)) ?? "default";
	return limitBankName(`${project}-${Bun.hash(path.resolve(projectRoot)).toString(36)}`);
}

function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
