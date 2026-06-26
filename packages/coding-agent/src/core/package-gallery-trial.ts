import { trialIdentity } from "./package-gallery-identity.ts";
import type {
	GalleryPackageIdentity,
	GalleryTrialGateStatus,
	GalleryTrialReviewInput,
} from "./package-gallery-types.ts";

export function inferExtensionCapabilityBadges(source: string): string[] {
	const stripped = stripCommentsAndStrings(source);
	const badges = new Set<string>();
	if (/\bomk\s*\.\s*registerTool\s*\(/.test(stripped)) badges.add("tools");
	if (/\bomk\s*\.\s*on\s*\(/.test(stripped)) badges.add("hooks");
	if (/\bomk\s*\.\s*registerProvider\s*\(/.test(stripped)) badges.add("provider");
	if (/\bomk\s*\.\s*registerMessageRenderer\s*\(/.test(stripped)) badges.add("ui");
	if (/session_before_compact/.test(source) && /\bomk\s*\.\s*on\s*\(/.test(stripped)) badges.add("compaction");
	return ["tools", "hooks", "provider", "ui", "compaction"].filter((badge) => badges.has(badge));
}

export function assessGalleryTrialGate(
	identity: GalleryPackageIdentity,
	review: GalleryTrialReviewInput,
): GalleryTrialGateStatus {
	const reasons: string[] = [];

	if (!review.pinned) reasons.push("exact-pin-required");
	for (const capability of review.capabilities) {
		if (capability === "credential-read" || capability === "host-socket") {
			reasons.push(`capability-hard-block: ${capability}`);
		}
	}
	if (review.licenseVerdict === "reject") reasons.push("license-blocked");
	if (review.lifecycleVerdict === "reject") reasons.push("lifecycle-scripts-blocked");
	if (review.pathCompatibility === "pi-hardcoded") reasons.push("pi-hardcoded-paths");
	if (review.adoption === "reject" || review.adoption === "deferred") {
		reasons.push(...review.rejectedReasons);
	}

	const dedupedReasons = unique(reasons);
	return {
		outcome: dedupedReasons.length === 0 ? "admitted" : "blocked",
		identity: trialIdentity(identity),
		adoption: review.adoption,
		pinned: review.pinned,
		reasons: dedupedReasons,
	};
}

function stripCommentsAndStrings(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
