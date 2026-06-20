/**
 * Get the API key or OAuth token for a provider.
 */

import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { isAuthenticated, ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../sdk";
import { getAvailableAuthMethods } from "../web/search/providers/perplexity-auth";

export default class Token extends Command {
	static description = "Get the API key or OAuth token for a provider";

	static args = {
		provider: Args.string({
			description: "Provider ID (e.g. anthropic, openai)",
			required: true,
		}),
	};

	static flags = {
		raw: Flags.boolean({
			description: "Output the raw credential value without parsing nested JSON structures",
			default: false,
		}),
		"force-refresh": Flags.boolean({
			description: "Force refresh the OAuth token even if it has not expired",
			default: false,
		}),
	};

	static examples = [
		"# Get API key for Anthropic\n  omp token anthropic",
		"# Get raw Copilot credential JSON\n  omp token github-copilot --raw",
		"# Force refresh and get Gemini CLI token\n  omp token google-gemini-cli --force-refresh",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Token);
		const providerName = args.provider ?? "";
		const provider = providerName.toLowerCase();

		const authStorage = await discoverAuthStorage();
		try {
			const modelRegistry = new ModelRegistry(authStorage);

			// Resolve the API key / token
			let apiKey: string | undefined;

			if (provider === "perplexity") {
				const methods = await getAvailableAuthMethods(authStorage, undefined, {
					forceRefresh: flags["force-refresh"],
				});
				const printable = methods.find(m => m.type === "oauth" || m.type === "api_key");
				if (printable) {
					apiKey = printable.type === "oauth" ? printable.access.accessToken : printable.apiKey;
				}
			}

			if (!apiKey) {
				apiKey = await modelRegistry.getApiKeyForProvider(provider, undefined, {
					forceRefresh: flags["force-refresh"],
				});
			}

			if (!isAuthenticated(apiKey)) {
				// Find all active/configured providers
				const activeProviders = new Set<string>();
				for (const p of PROVIDER_REGISTRY) {
					if (authStorage.hasAuth(p.id)) {
						activeProviders.add(p.id);
					}
				}
				const all = authStorage.getAll();
				for (const p in all) {
					if (authStorage.hasAuth(p)) {
						activeProviders.add(p);
					}
				}

				const msg = `No active credential found for provider "${providerName}".`;
				process.stderr.write(`${chalk.red(msg)}\n`);
				if (activeProviders.size > 0) {
					process.stderr.write(`Configured providers: ${Array.from(activeProviders).sort().join(", ")}\n`);
				}
				process.exitCode = 1;
				return;
			}

			if (!flags.raw) {
				try {
					const parsed = JSON.parse(apiKey);
					if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
						process.stdout.write(`${parsed.token}\n`);
						return;
					}
				} catch {
					// Not a JSON string, print as-is
				}
			}

			process.stdout.write(`${apiKey}\n`);
		} finally {
			authStorage.close();
		}
	}
}
