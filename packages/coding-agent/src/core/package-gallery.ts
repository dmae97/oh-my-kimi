export { dedupeGalleryEntries, normalizeRepoIdentity, trialIdentity } from "./package-gallery-identity.ts";
export { buildGalleryInstallSpec, buildGalleryInstallSpecFromReview } from "./package-gallery-install.ts";
export {
	classifyGalleryResourceTypes,
	filterGalleryEntriesByType,
	filterManifestEntriesInsideRoot,
	hasGalleryKeyword,
	isValidGalleryImageUrl,
	isValidGalleryVideoUrl,
	normalizeGalleryManifest,
	resolveGalleryTypeFacet,
	selectGalleryPreview,
} from "./package-gallery-manifest.ts";
export { assessGalleryTrialGate, inferExtensionCapabilityBadges } from "./package-gallery-trial.ts";
export {
	GALLERY_RESOURCE_ORDER,
	type GalleryInstallSpec,
	type GalleryManifest,
	type GalleryManifestKey,
	type GalleryPackageIdentity,
	type GalleryPreview,
	type GalleryPreviewInput,
	type GalleryResourceType,
	type GalleryTrialGateStatus,
	type GalleryTrialReview,
	type GalleryTrialReviewInput,
	type GalleryTrust,
} from "./package-gallery-types.ts";
