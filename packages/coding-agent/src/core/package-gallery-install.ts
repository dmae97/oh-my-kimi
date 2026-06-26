import { assessGalleryTrialGate } from "./package-gallery-trial.ts";
import type { GalleryInstallSpec, GalleryPackageIdentity, GalleryTrialReview } from "./package-gallery-types.ts";
import { validateExactNpmVersion } from "./package-procurement.ts";

export function buildGalleryInstallSpec(
	identity: GalleryPackageIdentity,
	codeExecution: boolean,
	options: { readonly local?: boolean } = {},
): GalleryInstallSpec {
	if (identity.kind === "npm") {
		const version = assertExactVersion(identity.version);
		const source = `npm:${identity.name}@${version}`;
		return {
			kind: "npm",
			source,
			installCommand: `omk install ${source}`,
			tryEphemeralCommand: `omk -e ${source}`,
			trust: codeExecution ? "code-execution" : "declarative",
		};
	}
	if (identity.kind === "git") {
		if (!isFullCommitSha(identity.ref)) {
			throw new Error("Gallery git install requires a full commit SHA.");
		}
		const source = `git:${identity.repo}@${identity.ref}`;
		return {
			kind: "git",
			source,
			installCommand: `omk install ${source}`,
			tryEphemeralCommand: `omk -e ${source}`,
			trust: codeExecution ? "code-execution" : "declarative",
		};
	}
	if (options.local !== true) {
		throw new Error("Gallery local installs require an explicit local option.");
	}
	return {
		kind: "local",
		source: identity.path,
		installCommand: `omk install ${identity.path} -l`,
		tryEphemeralCommand: `omk -e ${identity.path}`,
		trust: codeExecution ? "code-execution" : "declarative",
	};
}

export function buildGalleryInstallSpecFromReview(
	identity: GalleryPackageIdentity,
	review: GalleryTrialReview,
): GalleryInstallSpec {
	const status = assessGalleryTrialGate(identity, review);
	if (status.outcome === "blocked") {
		throw new Error(`Gallery trial blocked: ${status.reasons.join(", ")}`);
	}
	return buildGalleryInstallSpec(identity, expectedResourcesRequireCode(review));
}

function assertExactVersion(version: string | undefined): string {
	const verdict = validateExactNpmVersion(version);
	if (!verdict.ok) {
		throw new Error(`Gallery npm install requires an exact pinned version: ${verdict.message}`);
	}
	return verdict.version;
}

function isFullCommitSha(ref: string | undefined): ref is string {
	return typeof ref === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref);
}

function expectedResourcesRequireCode(review: GalleryTrialReview): boolean {
	return (
		review.candidate?.expectedResources?.some((resource) => resource === "extension" || resource === "tool") ?? false
	);
}
