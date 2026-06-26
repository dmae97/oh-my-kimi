import type {
	Adoption,
	GateVerdict,
	PathCompatibility,
	ProcurementReview,
	ResourceKind,
} from "./package-procurement.ts";

export type GalleryManifestKey = "omk" | "pi";
export type GalleryResourceType = "extension" | "skill" | "prompt" | "theme";
export type GalleryTrust = "declarative" | "code-execution";

export interface GalleryManifest {
	readonly manifestKey: GalleryManifestKey;
	readonly extensions: readonly string[];
	readonly skills: readonly string[];
	readonly prompts: readonly string[];
	readonly themes: readonly string[];
	readonly video?: string;
	readonly image?: string;
	readonly description?: string;
}

export type GalleryPackageIdentity =
	| { readonly kind: "npm"; readonly name: string; readonly version?: string }
	| { readonly kind: "git"; readonly repo: string; readonly ref?: string }
	| { readonly kind: "local"; readonly path: string };

export interface GalleryInstallSpec {
	readonly kind: GalleryPackageIdentity["kind"];
	readonly source: string;
	readonly installCommand: string;
	readonly tryEphemeralCommand: string;
	readonly trust: GalleryTrust;
}

export interface GalleryPreviewInput {
	readonly video?: string;
	readonly image?: string;
	readonly resourceTypes?: readonly GalleryResourceType[];
	readonly themeName?: string;
}

export type GalleryPreview =
	| { readonly kind: "video"; readonly url: string }
	| { readonly kind: "image"; readonly url: string }
	| { readonly kind: "generated-theme"; readonly marker: string };

export interface GalleryTrialReview {
	readonly pinned: boolean;
	readonly capabilities: readonly string[];
	readonly adoption: Adoption;
	readonly rejectedReasons: readonly string[];
	readonly licenseVerdict?: GateVerdict;
	readonly lifecycleVerdict?: GateVerdict;
	readonly pathCompatibility?: PathCompatibility;
	readonly candidate?: { readonly expectedResources?: readonly ResourceKind[] };
}

export interface GalleryTrialGateStatus {
	readonly outcome: "admitted" | "blocked";
	readonly identity: string;
	readonly adoption: Adoption;
	readonly pinned: boolean;
	readonly reasons: readonly string[];
}

export type GalleryTrialReviewInput = GalleryTrialReview | ProcurementReview;

export const GALLERY_RESOURCE_ORDER: readonly GalleryResourceType[] = ["extension", "skill", "prompt", "theme"];
