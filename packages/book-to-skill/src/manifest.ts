import {
	type ArtifactDigest,
	type CompilerIdentity,
	PROVENANCE_SCHEMA_VERSION,
	type ProvenanceManifest,
	type SourceDigest,
	type UpstreamIdentity,
} from "./types.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function bytes(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} has unexpected or missing fields`);
	}
}

function parseUpstream(value: unknown): UpstreamIdentity {
	const input = record(value, "compiler.upstream");
	exactKeys(input, ["repository", "commit", "declaredVersion"], "compiler.upstream");
	const commit = string(input.commit, "compiler.upstream.commit");
	if (!COMMIT_PATTERN.test(commit)) throw new Error("compiler.upstream.commit must be a 40-character Git commit");
	return Object.freeze({
		repository: string(input.repository, "compiler.upstream.repository"),
		commit,
		declaredVersion: string(input.declaredVersion, "compiler.upstream.declaredVersion"),
	});
}

function parseCompiler(value: unknown): CompilerIdentity {
	const input = record(value, "compiler");
	exactKeys(input, ["package", "version", "upstream"], "compiler");
	if (input.package !== "omk-book-to-skill") throw new Error("compiler.package must be omk-book-to-skill");
	return Object.freeze({
		package: "omk-book-to-skill",
		version: string(input.version, "compiler.version"),
		upstream: parseUpstream(input.upstream),
	});
}

function parseSha(value: unknown, label: string): string {
	const digest = string(value, label);
	if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
	return digest;
}

function parseSource(value: unknown, index: number): SourceDigest {
	const input = record(value, `sources[${index}]`);
	exactKeys(input, ["id", "name", "sha256", "bytes"], `sources[${index}]`);
	const name = string(input.name, `sources[${index}].name`);
	if (name.includes("/") || name.includes("\\")) throw new Error(`sources[${index}].name must be a basename`);
	return Object.freeze({
		id: string(input.id, `sources[${index}].id`),
		name,
		sha256: parseSha(input.sha256, `sources[${index}].sha256`),
		bytes: bytes(input.bytes, `sources[${index}].bytes`),
	});
}

function parseArtifact(value: unknown, index: number): ArtifactDigest {
	const input = record(value, `artifacts[${index}]`);
	exactKeys(input, ["path", "sha256", "bytes"], `artifacts[${index}]`);
	const path = string(input.path, `artifacts[${index}].path`);
	if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
		throw new Error(`artifacts[${index}].path must stay inside the skill directory`);
	}
	return Object.freeze({
		path,
		sha256: parseSha(input.sha256, `artifacts[${index}].sha256`),
		bytes: bytes(input.bytes, `artifacts[${index}].bytes`),
	});
}

function unique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

export function parseProvenanceManifest(value: unknown): ProvenanceManifest {
	const input = record(value, "manifest");
	exactKeys(input, ["schemaVersion", "compiler", "recordedAt", "sources", "artifacts"], "manifest");
	if (input.schemaVersion !== PROVENANCE_SCHEMA_VERSION)
		throw new Error(`Unsupported schemaVersion: ${String(input.schemaVersion)}`);
	const recordedAt = string(input.recordedAt, "recordedAt");
	if (!Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt) {
		throw new Error("recordedAt must be a canonical ISO timestamp");
	}
	if (!Array.isArray(input.sources) || input.sources.length === 0)
		throw new Error("sources must be a non-empty array");
	if (!Array.isArray(input.artifacts) || input.artifacts.length === 0)
		throw new Error("artifacts must be a non-empty array");
	const sources = input.sources.map(parseSource);
	const artifacts = input.artifacts.map(parseArtifact);
	unique(
		sources.map((entry) => entry.id),
		"source ids",
	);
	unique(
		artifacts.map((entry) => entry.path),
		"artifact paths",
	);
	if (!artifacts.some((entry) => entry.path === "SKILL.md")) throw new Error("artifacts must include SKILL.md");
	return Object.freeze({
		schemaVersion: PROVENANCE_SCHEMA_VERSION,
		compiler: parseCompiler(input.compiler),
		recordedAt,
		sources: Object.freeze(sources),
		artifacts: Object.freeze(artifacts),
	});
}
