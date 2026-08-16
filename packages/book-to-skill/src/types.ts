export const PROVENANCE_SCHEMA_VERSION = "omk.book-to-skill.provenance.v1" as const;
export const PROVENANCE_FILE_NAME = ".book-to-skill-provenance.json";

export interface UpstreamIdentity {
	readonly repository: string;
	readonly commit: string;
	readonly declaredVersion: string;
}

export interface CompilerIdentity {
	readonly package: "omk-book-to-skill";
	readonly version: string;
	readonly upstream: UpstreamIdentity;
}

export interface SourceDigest {
	readonly id: string;
	readonly name: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface ArtifactDigest {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface ProvenanceManifest {
	readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
	readonly compiler: CompilerIdentity;
	readonly recordedAt: string;
	readonly sources: readonly SourceDigest[];
	readonly artifacts: readonly ArtifactDigest[];
}

export interface VerificationIssue {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
}

export interface VerificationReport {
	readonly status: "pass" | "fail" | "inconclusive";
	readonly artifactIntegrity: "pass" | "fail";
	readonly sourceIntegrity: "pass" | "fail" | "not-checked";
	readonly issues: readonly VerificationIssue[];
	readonly manifest?: ProvenanceManifest;
}

export interface RecordProvenanceOptions {
	readonly skillDir: string;
	readonly sources: readonly string[];
	readonly compiler: CompilerIdentity;
	readonly recordedAt?: string;
	readonly mergeSources?: boolean;
}

export interface VerifyProvenanceOptions {
	readonly skillDir: string;
	readonly sources?: readonly string[];
}
