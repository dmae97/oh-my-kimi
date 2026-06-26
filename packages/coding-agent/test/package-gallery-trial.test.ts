import { describe, expect, it } from "vitest";
import { assessGalleryTrialGate, inferExtensionCapabilityBadges } from "../src/core/package-gallery.ts";
import { type ProcurementReview, procureCandidate } from "../src/core/package-procurement.ts";

describe("package gallery trial procurement gate", () => {
	it("infers extension capability badges from code while ignoring comments and strings", () => {
		expect(
			inferExtensionCapabilityBadges(`
				// omk.registerTool({ name: "fake" })
				const example = "omk.registerCommand('fake')";
				omk.registerTool({ name: "real" });
				omk.on("tool_call", handler);
				omk.registerProvider("demo", provider);
				omk.registerMessageRenderer(renderer);
			`),
		).toEqual(["tools", "hooks", "provider", "ui"]);
		expect(inferExtensionCapabilityBadges("registerToolbar(); other.registerTool();")).toEqual([]);
		expect(inferExtensionCapabilityBadges('omk.on("session_before_compact", handler);')).toEqual([
			"hooks",
			"compaction",
		]);
	});

	it("admits a pinned, contained, non-rejected package as an ephemeral trial", () => {
		const status = assessGalleryTrialGate(
			{ kind: "npm", name: "@scope/pkg" },
			{ pinned: true, capabilities: [], adoption: "ephemeral-trial", rejectedReasons: [] },
		);

		expect(status).toEqual({
			outcome: "admitted",
			identity: "npm:@scope/pkg",
			adoption: "ephemeral-trial",
			pinned: true,
			reasons: [],
		});
	});

	it("blocks unpinned sources with exact-pin-required before any trial side effect", () => {
		const status = assessGalleryTrialGate(
			{ kind: "npm", name: "pkg" },
			{ pinned: false, capabilities: [], adoption: "reject", rejectedReasons: ["exact-pin-required"] },
		);

		expect(status.outcome).toBe("blocked");
		expect(status.pinned).toBe(false);
		expect(status.reasons).toContain("exact-pin-required");
	});

	it("blocks credential-read and host-socket capability even when otherwise admitted", () => {
		const credentialRead = assessGalleryTrialGate(
			{ kind: "git", repo: "github.com/acme/pkg", ref: "v1" },
			{
				pinned: true,
				capabilities: ["network", "credential-read"],
				adoption: "reject",
				rejectedReasons: ["reads-credentials"],
			},
		);
		const hostSocket = assessGalleryTrialGate(
			{ kind: "npm", name: "pkg" },
			{ pinned: true, capabilities: ["host-socket"], adoption: "ephemeral-trial", rejectedReasons: [] },
		);

		expect(credentialRead.outcome).toBe("blocked");
		expect(credentialRead.reasons).toContainEqual(expect.stringContaining("capability-hard-block"));
		expect(hostSocket.outcome).toBe("blocked");
		expect(hostSocket.reasons).toContainEqual(expect.stringContaining("host-socket"));
	});

	it("admits reference-only and report-only adoptions when pinned and contained", () => {
		for (const adoption of ["reference-only", "report-only", "advisory-only"] as const) {
			const status = assessGalleryTrialGate(
				{ kind: "npm", name: "pkg" },
				{ pinned: true, capabilities: [], adoption, rejectedReasons: [] },
			);
			expect(status.outcome).toBe("admitted");
		}
	});

	it("blocks rejected adoption and explicit gate failures", () => {
		const rejected = assessGalleryTrialGate(
			{ kind: "npm", name: "pkg" },
			{
				pinned: true,
				capabilities: [],
				adoption: "reject",
				rejectedReasons: ["license-blocked", "pi-hardcoded-paths"],
			},
		);
		const base = { pinned: true, capabilities: [], adoption: "ephemeral-trial", rejectedReasons: [] } as const;

		expect(rejected).toMatchObject({ outcome: "blocked", reasons: ["license-blocked", "pi-hardcoded-paths"] });
		expect(assessGalleryTrialGate({ kind: "npm", name: "pkg" }, { ...base, licenseVerdict: "reject" })).toMatchObject(
			{
				outcome: "blocked",
				reasons: ["license-blocked"],
			},
		);
		expect(
			assessGalleryTrialGate({ kind: "npm", name: "pkg" }, { ...base, lifecycleVerdict: "reject" }),
		).toMatchObject({ outcome: "blocked", reasons: ["lifecycle-scripts-blocked"] });
		expect(
			assessGalleryTrialGate({ kind: "npm", name: "pkg" }, { ...base, pathCompatibility: "pi-hardcoded" }),
		).toMatchObject({ outcome: "blocked", reasons: ["pi-hardcoded-paths"] });
	});

	it("normalizes identity independent of git ref and .git suffix", () => {
		const base = { pinned: true, capabilities: [], adoption: "ephemeral-trial", rejectedReasons: [] } as const;

		const withRef = assessGalleryTrialGate({ kind: "git", repo: "github.com/acme/pkg.git", ref: "v1" }, base);
		const withoutRef = assessGalleryTrialGate({ kind: "git", repo: "github.com/acme/pkg" }, base);

		expect(withRef.identity).toBe("git:github.com/acme/pkg");
		expect(withRef.identity).toBe(withoutRef.identity);
	});

	it("accepts full ProcurementReview inputs from procurement", () => {
		const review: ProcurementReview = procureCandidate({
			candidate: {
				name: "evil-pkg",
				exactVersion: "1.2.3",
				intendedUse: "ephemeral-adopt",
				expectedResources: ["extension"],
			},
			declaredLicense: "MIT",
			sources: [
				{ path: "index.ts", text: 'const env = readFileSync(".env"); const sock = "/var/run/docker.sock";' },
			],
		});
		const clean = procureCandidate({
			candidate: {
				name: "clean-pkg",
				exactVersion: "1.2.3",
				intendedUse: "ephemeral-adopt",
				expectedResources: ["prompt"],
			},
			declaredLicense: "MIT",
			sources: [{ path: "README.md", text: "# clean package" }],
		});

		expect(assessGalleryTrialGate({ kind: "npm", name: "evil-pkg" }, review)).toMatchObject({
			outcome: "blocked",
			pinned: true,
		});
		expect(assessGalleryTrialGate({ kind: "npm", name: "clean-pkg" }, clean)).toMatchObject({
			outcome: "admitted",
			reasons: [],
		});
	});
});
