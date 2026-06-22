import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDocumentConversionCacheDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

export const MARKIT_CONVERSION_CACHE_VERSION = 1;
export const MAX_MARKIT_CONVERSION_CACHE_BYTES = 256 * 1024 * 1024;
export type MarkitConversionCacheStatus = "hit" | "miss" | "skipped";

interface MarkitConversionCacheEntry {
	version: number;
	content: string;
}

export function markitConversionCacheKey(bytes: Uint8Array, extension: string): string {
	const normalizedExtension = extension.trim().toLowerCase().replace(/^\.+/, "") || "bin";
	const safeExtension = normalizedExtension.replace(/[^a-z0-9]+/g, "_") || "bin";
	const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	return `v${MARKIT_CONVERSION_CACHE_VERSION}-${safeExtension}-${digest}`;
}

function cacheEntryPath(key: string): string {
	return path.join(getDocumentConversionCacheDir(), `${key}.json`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseCacheEntry(raw: string): MarkitConversionCacheEntry | null {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) return null;
	if (!("version" in parsed) || parsed.version !== MARKIT_CONVERSION_CACHE_VERSION) return null;
	if (!("content" in parsed) || typeof parsed.content !== "string") return null;
	return { version: MARKIT_CONVERSION_CACHE_VERSION, content: parsed.content };
}

export async function readMarkitConversionCache(
	key: string,
): Promise<{ status: "hit"; content: string } | { status: "miss" }> {
	const target = cacheEntryPath(key);
	let raw: string;
	try {
		raw = await fs.readFile(target, "utf8");
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("document conversion cache read failed", { error: errorMessage(error) });
		}
		return { status: "miss" };
	}

	let entry: MarkitConversionCacheEntry | null;
	try {
		entry = parseCacheEntry(raw);
	} catch (error) {
		logger.debug("document conversion cache read failed", { error: errorMessage(error) });
		entry = null;
	}

	if (!entry) {
		await fs.rm(target, { force: true }).catch(() => undefined);
		return { status: "miss" };
	}

	return { status: "hit", content: entry.content };
}

async function pruneMarkitConversionCache(cacheDir: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(cacheDir);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
		}
		return;
	}

	const entries: { path: string; size: number; mtimeMs: number }[] = [];
	let totalBytes = 0;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const entryPath = path.join(cacheDir, name);
		try {
			const stat = await fs.stat(entryPath);
			if (!stat.isFile()) continue;
			entries.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
			totalBytes += stat.size;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
			}
		}
	}

	if (totalBytes <= MAX_MARKIT_CONVERSION_CACHE_BYTES) return;

	entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const entry of entries) {
		if (totalBytes <= MAX_MARKIT_CONVERSION_CACHE_BYTES) break;
		try {
			await fs.rm(entry.path, { force: true });
			totalBytes -= entry.size;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
			}
		}
	}
}

export async function writeMarkitConversionCache(key: string, content: string): Promise<void> {
	const cacheDir = getDocumentConversionCacheDir();
	const target = path.join(cacheDir, `${key}.json`);
	const tempPath = path.join(cacheDir, `${key}.${process.pid}.${Date.now()}.tmp`);
	const payload = JSON.stringify({ version: MARKIT_CONVERSION_CACHE_VERSION, content });
	try {
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(tempPath, payload);
		await fs.rename(tempPath, target);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		logger.debug("document conversion cache write failed", { error: errorMessage(error) });
		return;
	}

	await pruneMarkitConversionCache(cacheDir);
}
