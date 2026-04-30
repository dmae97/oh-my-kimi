/**
 * List available models with optional fuzzy search
 */
import { type Api, getSupportedEfforts, type Model } from "@oh-my-pi/pi-ai";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { fuzzyFilter } from "../utils/fuzzy";

interface ProviderRow {
	provider: string;
	model: string;
	context: string;
	maxOut: string;
	thinking: string;
	images: string;
}

interface CanonicalRow {
	canonical: string;
	selected: string;
	variants: string;
	context: string;
	maxOut: string;
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function renderTable<T extends Record<string, string>>(rows: T[], headers: T): void {
	const widths = Object.fromEntries(
		Object.keys(headers).map(key => [key, Math.max(headers[key]!.length, ...rows.map(row => row[key]!.length))]),
	) as Record<keyof T, number>;

	const headerLine = Object.keys(headers)
		.map(key => headers[key as keyof T]!.padEnd(widths[key as keyof T]))
		.join("  ");
	writeLine(headerLine);

	for (const row of rows) {
		const line = Object.keys(headers)
			.map(key => row[key as keyof T]!.padEnd(widths[key as keyof T]))
			.join("  ");
		writeLine(line);
	}
}

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void> {
	const models = modelRegistry.getAvailable();

	if (models.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}

	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, model => `${model.provider} ${model.id}`);
	}

	const filteredCanonical = modelRegistry
		.getCanonicalModels({ availableOnly: true, candidates: filteredModels })
		.map(record => {
			const selected = modelRegistry.resolveCanonicalModel(record.id, {
				availableOnly: true,
				candidates: filteredModels,
			});
			if (!selected) return undefined;
			return {
				canonical: record.id,
				selected: `${selected.provider}/${selected.id}`,
				variants: String(record.variants.length),
				context: formatNumber(selected.contextWindow),
				maxOut: formatNumber(selected.maxTokens),
			} satisfies CanonicalRow;
		})
		.filter((row): row is CanonicalRow => row !== undefined)
		.sort((left, right) => left.canonical.localeCompare(right.canonical));

	if (filteredModels.length === 0 && filteredCanonical.length === 0) {
		writeLine(`No models matching "${searchPattern}"`);
		return;
	}

	filteredModels.sort((left, right) => {
		const providerCmp = left.provider.localeCompare(right.provider);
		if (providerCmp !== 0) return providerCmp;
		return left.id.localeCompare(right.id);
	});

	const providerRows = filteredModels.map(model => ({
		provider: model.provider,
		model: model.id,
		context: formatNumber(model.contextWindow),
		maxOut: formatNumber(model.maxTokens),
		thinking: model.thinking ? getSupportedEfforts(model).join(",") : model.reasoning ? "yes" : "-",
		images: model.input.includes("image") ? "yes" : "no",
	})) satisfies ProviderRow[];

	if (filteredCanonical.length > 0) {
		writeLine("Canonical models");
		renderTable(filteredCanonical, {
			canonical: "canonical",
			selected: "selected",
			variants: "variants",
			context: "context",
			maxOut: "max-out",
		});
		if (providerRows.length > 0) {
			writeLine();
		}
	}

	if (providerRows.length > 0) {
		writeLine("Provider models");
		renderTable(providerRows, {
			provider: "provider",
			model: "model",
			context: "context",
			maxOut: "max-out",
			thinking: "thinking",
			images: "images",
		});
	}
}
