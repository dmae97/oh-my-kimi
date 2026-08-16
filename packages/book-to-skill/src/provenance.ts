import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectArtifactDigests, digestSources } from "./file-digests.ts";
import { parseProvenanceManifest } from "./manifest.ts";
import {
	type ArtifactDigest,
	PROVENANCE_FILE_NAME,
	PROVENANCE_SCHEMA_VERSION,
	type ProvenanceManifest,
	type RecordProvenanceOptions,
	type SourceDigest,
	type VerificationIssue,
	type VerificationReport,
	type VerifyProvenanceOptions,
} from "./types.ts";

export { PROVENANCE_FILE_NAME, PROVENANCE_SCHEMA_VERSION } from "./types.ts";

function manifestPath(skillDir: string): string {
	return resolve(skillDir, PROVENANCE_FILE_NAME);
}

function readManifest(skillDir: string): ProvenanceManifest {
	const path = manifestPath(skillDir);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Provenance manifest must be a regular file");
	if (stat.size > 1024 * 1024) throw new Error("Provenance manifest exceeds the 1 MiB limit");
	return parseProvenanceManifest(JSON.parse(readFileSync(path, "utf8")));
}

function mergeSourceDigests(existing: readonly SourceDigest[], added: readonly SourceDigest[]): SourceDigest[] {
	const seen = new Set<string>();
	const merged: SourceDigest[] = [];
	for (const entry of [...existing, ...added]) {
		const key = `${entry.name}\0${entry.bytes}\0${entry.sha256}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(Object.freeze({ ...entry, id: `source-${merged.length + 1}` }));
	}
	return merged;
}

function writeManifest(path: string, manifest: ProvenanceManifest): void {
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(temporary, `${JSON.stringify(manifest, undefined, "\t")}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function recordProvenance(options: RecordProvenanceOptions): ProvenanceManifest {
	const skillDir = resolve(options.skillDir);
	let existingSources: readonly SourceDigest[] = [];
	if (options.mergeSources && existsSync(manifestPath(skillDir))) {
		existingSources = readManifest(skillDir).sources;
	}
	const sources = mergeSourceDigests(existingSources, digestSources(options.sources.map((path) => resolve(path))));
	if (sources.length === 0) throw new Error("At least one source file is required to record provenance");
	const manifest = parseProvenanceManifest({
		schemaVersion: PROVENANCE_SCHEMA_VERSION,
		compiler: options.compiler,
		recordedAt: options.recordedAt ?? new Date().toISOString(),
		sources,
		artifacts: collectArtifactDigests(skillDir),
	});
	writeManifest(manifestPath(skillDir), manifest);
	return manifest;
}

function issue(code: string, message: string, path?: string): VerificationIssue {
	return Object.freeze(path ? { code, message, path } : { code, message });
}

function compareArtifacts(expected: readonly ArtifactDigest[], actual: readonly ArtifactDigest[]): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	const current = new Map(actual.map((entry) => [entry.path, entry]));
	for (const entry of expected) {
		const observed = current.get(entry.path);
		if (!observed) issues.push(issue("artifact.missing", "Recorded artifact is missing", entry.path));
		else if (observed.sha256 !== entry.sha256)
			issues.push(issue("artifact.hash-mismatch", "Artifact SHA-256 changed", entry.path));
		else if (observed.bytes !== entry.bytes)
			issues.push(issue("artifact.size-mismatch", "Artifact size changed", entry.path));
		current.delete(entry.path);
	}
	for (const path of current.keys()) issues.push(issue("artifact.unrecorded", "Unrecorded artifact is present", path));
	return issues;
}

function compareSources(expected: readonly SourceDigest[], paths: readonly string[]): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	let actual: SourceDigest[];
	try {
		actual = digestSources(paths.map((path) => resolve(path)));
	} catch (error) {
		return [issue("source.unreadable", error instanceof Error ? error.message : String(error))];
	}
	if (actual.length !== expected.length) {
		issues.push(
			issue("source.count-mismatch", `Expected ${expected.length} source files, received ${actual.length}`),
		);
	}
	for (let index = 0; index < Math.min(actual.length, expected.length); index++) {
		const recorded = expected[index];
		const observed = actual[index];
		if (!recorded || !observed) continue;
		if (recorded.name !== observed.name)
			issues.push(issue("source.name-mismatch", "Source basename changed", observed.name));
		if (recorded.sha256 !== observed.sha256)
			issues.push(issue("source.hash-mismatch", "Source SHA-256 changed", observed.name));
		if (recorded.bytes !== observed.bytes)
			issues.push(issue("source.size-mismatch", "Source size changed", observed.name));
	}
	return issues;
}

function failedReport(error: unknown): VerificationReport {
	return Object.freeze({
		status: "fail",
		artifactIntegrity: "fail",
		sourceIntegrity: "not-checked",
		issues: Object.freeze([issue("manifest.invalid", error instanceof Error ? error.message : String(error))]),
	});
}

export function verifyProvenance(options: VerifyProvenanceOptions): VerificationReport {
	const skillDir = resolve(options.skillDir);
	let manifest: ProvenanceManifest;
	try {
		manifest = readManifest(skillDir);
	} catch (error) {
		return failedReport(error);
	}

	let artifactIssues: VerificationIssue[];
	try {
		artifactIssues = compareArtifacts(manifest.artifacts, collectArtifactDigests(skillDir));
	} catch (error) {
		artifactIssues = [issue("artifact.unreadable", error instanceof Error ? error.message : String(error))];
	}
	const sourceIssues = options.sources ? compareSources(manifest.sources, options.sources) : [];
	const artifactIntegrity = artifactIssues.length === 0 ? "pass" : "fail";
	const sourceIntegrity = options.sources ? (sourceIssues.length === 0 ? "pass" : "fail") : "not-checked";
	const issues = Object.freeze([...artifactIssues, ...sourceIssues]);
	const status = issues.length > 0 ? "fail" : sourceIntegrity === "not-checked" ? "inconclusive" : "pass";
	return Object.freeze({ status, artifactIntegrity, sourceIntegrity, issues, manifest });
}
