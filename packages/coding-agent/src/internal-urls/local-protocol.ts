import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parseInternalUrl } from "./parse";
import { validateRelativePath } from "./skill-protocol";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export interface LocalProtocolOptions {
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string | null;
}

function parseLocalUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("local:// URL escapes local root");
	}
}

function toLocalValidationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.replace("skill://", "local://"));
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
	const pending = [""];
	const files: string[] = [];

	while (pending.length > 0) {
		const relativeDir = pending.pop();
		if (relativeDir === undefined) continue;
		const absoluteDir = path.join(rootPath, relativeDir);
		const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				pending.push(entryPath);
				continue;
			}
			if (entry.isFile()) {
				files.push(entryPath.replaceAll(path.sep, "/"));
			}
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

async function buildListing(url: InternalUrl, localRoot: string): Promise<InternalResource> {
	const files = await listFilesRecursively(localRoot);
	const listing = files.length === 0 ? "(empty)" : files.map(file => `- [${file}](local://${file})`).join("\n");
	const content =
		`# Local\n\n` +
		`Session-scoped scratch space for large intermediate data, subagent handoffs, and reusable planning artifacts.\n\n` +
		`Root: ${localRoot}\n\n` +
		`${files.length} file${files.length === 1 ? "" : "s"} available:\n\n` +
		`${listing}\n`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: localRoot,
	};
}

function extractRelativePath(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;

	const combined = host
		? pathname && pathname !== "/"
			? `${host}${pathname}`
			: host
		: pathname && pathname !== "/"
			? pathname.slice(1)
			: "";

	if (!combined) {
		return "";
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(combined.replaceAll("\\", "/"));
	} catch {
		throw new Error(`Invalid URL encoding in local:// path: ${url.href}`);
	}
	try {
		validateRelativePath(decoded);
	} catch (error) {
		throw toLocalValidationError(error);
	}
	return decoded;
}

export function resolveLocalRoot(options: LocalProtocolOptions): string {
	const artifactsDir = options.getArtifactsDir?.();
	if (artifactsDir) {
		return path.resolve(artifactsDir, "local");
	}

	const sessionId = options.getSessionId?.() ?? "session";
	const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return path.join(os.tmpdir(), "omp-local", safeSessionId);
}

export function resolveLocalUrlToPath(input: string | InternalUrl, options: LocalProtocolOptions): string {
	const url = typeof input === "string" ? parseLocalUrl(input) : input;
	const localRoot = path.resolve(resolveLocalRoot(options));
	const relativePath = extractRelativePath(url);

	if (!relativePath) {
		return localRoot;
	}

	const resolved = path.resolve(localRoot, relativePath);
	ensureWithinRoot(resolved, localRoot);
	return resolved;
}

/**
 * Protocol handler for local:// URLs.
 *
 * URL forms:
 * - local:// - Lists all session local files
 * - local://<path> - Reads a file under session local root
 */
export class LocalProtocolHandler implements ProtocolHandler {
	readonly scheme = "local";
	readonly immutable = false;

	constructor(private readonly options: LocalProtocolOptions) {}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const localRoot = path.resolve(resolveLocalRoot(this.options));
		await fs.mkdir(localRoot, { recursive: true });

		let resolvedRoot: string;
		try {
			resolvedRoot = await fs.realpath(localRoot);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error("Unable to initialize local:// root");
			}
			throw error;
		}

		const relativePath = extractRelativePath(url);
		const targetPath = relativePath ? path.resolve(resolvedRoot, relativePath) : resolvedRoot;
		ensureWithinRoot(targetPath, resolvedRoot);

		if (targetPath === resolvedRoot) {
			return buildListing(url, resolvedRoot);
		}

		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			ensureWithinRoot(realParent, resolvedRoot);
		} catch (error) {
			if (!isEnoent(error)) {
				throw error;
			}
		}

		let realTargetPath: string;
		try {
			realTargetPath = await fs.realpath(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`Local file not found: ${url.href}`);
			}
			throw error;
		}

		ensureWithinRoot(realTargetPath, resolvedRoot);

		const stat = await fs.stat(realTargetPath);
		if (!stat.isFile()) {
			throw new Error(`local:// URL must resolve to a file: ${url.href}`);
		}

		const content = await Bun.file(realTargetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(realTargetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: realTargetPath,
			notes: ["Use write path local://<file> to persist large intermediate artifacts across turns."],
		};
	}
}
