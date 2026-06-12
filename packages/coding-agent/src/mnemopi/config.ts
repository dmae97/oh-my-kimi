import * as path from "node:path";
import type { MnemopiOptions } from "@oh-my-pi/pi-mnemopi";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";

export type MnemopiLlmMode = "none" | "smol" | "remote";

export type MnemopiScoping = "global" | "per-project" | "per-project-tagged";

export type MnemopiProviderOptions = Pick<
	MnemopiOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm" | "debug"
>;

export interface MnemopiBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	scoping?: MnemopiScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	debug: boolean;
	providerOptions: MnemopiProviderOptions;
	llmMode: MnemopiLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

export function loadMnemopiConfig(settings: Settings, agentDir: string): MnemopiBackendConfig {
	const configuredDbPath = settings.get("mnemopi.dbPath");
	const cwd = settings.getCwd();
	const scoping = settings.get("mnemopi.scoping");
	const scope = resolveBankScope(settings.get("mnemopi.bank"), cwd, scoping);
	const llmMode = settings.get("mnemopi.llmMode");
	return {
		dbPath: configuredDbPath ?? path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db"),
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks: scope.recallBanks,
		scoping,
		autoRecall: settings.get("mnemopi.autoRecall"),
		autoRetain: settings.get("mnemopi.autoRetain"),
		polyphonicRecall: settings.get("mnemopi.polyphonicRecall"),
		enhancedRecall: settings.get("mnemopi.enhancedRecall"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemopi.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemopi.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemopi.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemopi.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemopi.injectionTokenLimit"))),
		debug: settings.get("mnemopi.debug"),
		providerOptions: {
			noEmbeddings: settings.get("mnemopi.noEmbeddings"),
			debug: settings.get("mnemopi.debug"),
			embeddingModel: settings.get("mnemopi.embeddingModel"),
			embeddingApiUrl: settings.get("mnemopi.embeddingApiUrl"),
			embeddingApiKey: settings.get("mnemopi.embeddingApiKey"),
			llm:
				llmMode === "remote"
					? {
							baseUrl: settings.get("mnemopi.llmBaseUrl"),
							apiKey: settings.get("mnemopi.llmApiKey"),
							model: settings.get("mnemopi.llmModel"),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: settings.get("mnemopi.llmBaseUrl"),
		llmApiKey: settings.get("mnemopi.llmApiKey"),
		llmModel: settings.get("mnemopi.llmModel"),
	};
}

const DEFAULT_SHARED_BANK = "default";

interface MnemopiBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

// Mnemopi does not have built-in tag-filtered recall, so `per-project-tagged`
// maps to a project-local write bank plus a shared recall-visible bank.
function resolveBankScope(configured: string | undefined, cwd: string, scoping: MnemopiScoping): MnemopiBankScope {
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
