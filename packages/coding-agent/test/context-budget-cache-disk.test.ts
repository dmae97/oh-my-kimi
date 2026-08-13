import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONTEXT_BUDGET_DISK_CACHE_SCHEMA_VERSION,
	createDiskContextBudgetCacheProviderV2,
} from "../src/core/context-budget-v2-cache-disk.ts";
import type { ContextBudgetRepresentationCacheEntryV2 } from "../src/core/context-budget-v2-types.ts";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-ctx-disk-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function entry(
	overrides: Partial<ContextBudgetRepresentationCacheEntryV2> = {},
): ContextBudgetRepresentationCacheEntryV2 {
	return {
		kind: "summary",
		text: "rendered representation text",
		estimatedTokens: 7,
		fidelity: "lossy",
		sourceHash: "source-a",
		representationFingerprint: "fingerprint-a",
		modelId: "model-a",
		tokenizerId: "heuristic-v1",
		policyVersion: "context-budget-v2",
		createdAtEpochMs: 1_000,
		...overrides,
	};
}

function snapshotFile(): string {
	return path.join(dir, "representations.json");
}

describe("disk context-budget cache provider", () => {
	it("survives a process boundary: a second provider reads the first one's entries", () => {
		const first = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		first.writeRepresentation({ key: "k1", entry: entry() });
		first.close();

		const second = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		const read = second.readRepresentation("k1");
		expect(read?.entry.text).toBe("rendered representation text");
		expect(read?.layer).toBe("workspace");
		expect(second.lastLoadError).toBeUndefined();
	});

	it("persists negative entries too", () => {
		const first = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0, now: () => 42 });
		first.writeNegativeRepresentation({ key: "n1", reason: "too-large" });
		first.close();

		const second = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		expect(second.readNegativeRepresentation("n1")).toMatchObject({ reason: "too-large", createdAtEpochMs: 42 });
	});

	it("keeps plan entries in memory only", () => {
		const first = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		first.writeRepresentation({ key: "k1", entry: entry() });
		first.writePlan({
			key: "p1",
			entry: { plan: { planHash: "h" } as never, sourceHashes: {}, createdAtEpochMs: 1 },
		});
		expect(first.readPlan("p1")?.layer).toBe("session");
		first.close();

		const raw = JSON.parse(fs.readFileSync(snapshotFile(), "utf8"));
		expect(Object.keys(raw)).not.toContain("plans");
		expect(createDiskContextBudgetCacheProviderV2({ dir }).readPlan("p1")).toBeUndefined();
	});

	it("writes atomically and leaves no temp file behind", () => {
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		provider.writeRepresentation({ key: "k1", entry: entry() });
		provider.close();
		expect(fs.readdirSync(dir)).toEqual(["representations.json"]);
	});

	it("starts empty and reports why when the snapshot is corrupt", () => {
		fs.writeFileSync(snapshotFile(), "{not json", "utf8");
		const provider = createDiskContextBudgetCacheProviderV2({ dir });
		expect(provider.size).toBe(0);
		expect(provider.lastLoadError).toBe("snapshot is not valid JSON");
		expect(provider.readRepresentation("k1")).toBeUndefined();
	});

	it("rejects a snapshot written by another schema version", () => {
		fs.writeFileSync(
			snapshotFile(),
			JSON.stringify({ schemaVersion: "something-else", representations: [["k1", entry()]], negatives: [] }),
			"utf8",
		);
		const provider = createDiskContextBudgetCacheProviderV2({ dir });
		expect(provider.lastLoadError).toBe("snapshot schema mismatch");
		expect(provider.size).toBe(0);
	});

	it("drops individual malformed entries without discarding the whole snapshot", () => {
		fs.writeFileSync(
			snapshotFile(),
			JSON.stringify({
				schemaVersion: CONTEXT_BUDGET_DISK_CACHE_SCHEMA_VERSION,
				representations: [
					["good", entry()],
					["missing-source-hash", { ...entry(), sourceHash: "" }],
					["negative-estimate", { ...entry(), estimatedTokens: -1 }],
					["not-an-object", "nope"],
					["wrong-arity"],
				],
				negatives: [],
			}),
			"utf8",
		);
		const provider = createDiskContextBudgetCacheProviderV2({ dir });
		expect(provider.size).toBe(1);
		expect(provider.readRepresentation("good")).toBeDefined();
		expect(provider.readRepresentation("negative-estimate")).toBeUndefined();
	});

	it("discards an oversized snapshot instead of loading it", () => {
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		// maxBytes floors at 1024, so the snapshot has to clear that to be rejected.
		provider.writeRepresentation({ key: "k1", entry: entry({ text: "x".repeat(4096) }) });
		provider.close();
		expect(fs.statSync(snapshotFile()).size).toBeGreaterThan(1024);

		const reloaded = createDiskContextBudgetCacheProviderV2({ dir, maxBytes: 1024 });
		expect(reloaded.size).toBe(0);
		expect(reloaded.lastLoadError).toMatch(/exceeds maxBytes/u);
	});

	it("evicts least-recently-used entries beyond maxEntries", () => {
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0, maxEntries: 2 });
		provider.writeRepresentation({ key: "a", entry: entry() });
		provider.writeRepresentation({ key: "b", entry: entry() });
		provider.readRepresentation("a"); // refresh a
		provider.writeRepresentation({ key: "c", entry: entry() });
		expect(provider.readRepresentation("b")).toBeUndefined();
		expect(provider.readRepresentation("a")).toBeDefined();
		expect(provider.readRepresentation("c")).toBeDefined();
	});

	it("does not persist an entry whose text exceeds the per-entry cap", () => {
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0, maxEntryTextLength: 8 });
		provider.writeRepresentation({ key: "huge", entry: entry({ text: "x".repeat(64) }) });
		// Still served in-process, but never written to disk.
		expect(provider.readRepresentation("huge")).toBeDefined();
		expect(fs.existsSync(snapshotFile())).toBe(false);
	});

	it("keeps credential-shaped representation text in memory only", () => {
		const credential = "synthetic-disk-cache-secret";
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		provider.writeRepresentation({ key: "k1", entry: entry() });
		provider.writeRepresentation({ key: "k1", entry: entry({ text: `api_key = "${credential}"` }) });

		expect(provider.readRepresentation("k1")?.entry.text).toContain(credential);
		provider.close();
		expect(fs.readFileSync(snapshotFile(), "utf8")).not.toContain(credential);
		expect(createDiskContextBudgetCacheProviderV2({ dir }).readRepresentation("k1")).toBeUndefined();
	});

	it.each([
		["AWS access key", `AKIA${"1234567890ABCDEF"}`],
		["JWT", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "syntheticSignature123"].join(".")],
		["Fernet token", `gAAAAA${"A".repeat(32)}`],
		["v2 GCM envelope", `v2:${"A".repeat(32)}`],
	])("does not persist %s shapes", (_label, credential) => {
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		provider.writeRepresentation({ key: "k1", entry: entry({ text: credential }) });
		expect(provider.readRepresentation("k1")?.entry.text).toBe(credential);
		provider.close();

		const persisted = fs.existsSync(snapshotFile()) ? fs.readFileSync(snapshotFile(), "utf8") : "";
		expect(persisted).not.toContain(credential);
	});

	it("filters credential-shaped keys and negative reasons", () => {
		const credential = `AKIA${"1234567890ABCDEF"}`;
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		provider.writeRepresentation({ key: "safe", entry: entry() });
		provider.writeRepresentation({ key: credential, entry: entry() });
		provider.writeNegativeRepresentation({ key: "negative", reason: `api_key = "${credential}"` });
		provider.close();

		const persisted = fs.readFileSync(snapshotFile(), "utf8");
		expect(persisted).not.toContain(credential);
		const reloaded = createDiskContextBudgetCacheProviderV2({ dir });
		expect(reloaded.readRepresentation(credential)).toBeUndefined();
		expect(reloaded.readNegativeRepresentation("negative")).toBeUndefined();
	});

	it("deletes a legacy snapshot containing credential-shaped text", () => {
		const credential = "synthetic-legacy-cache-secret";
		fs.writeFileSync(
			snapshotFile(),
			JSON.stringify({
				schemaVersion: CONTEXT_BUDGET_DISK_CACHE_SCHEMA_VERSION,
				representations: [["k1", entry({ text: `api_key = "${credential}"` })]],
				negatives: [],
			}),
			"utf8",
		);

		const provider = createDiskContextBudgetCacheProviderV2({ dir });
		expect(provider.size).toBe(0);
		expect(provider.lastLoadError).toBe("snapshot contains credential-shaped text");
		expect(fs.existsSync(snapshotFile())).toBe(false);
	});

	it("deletes malformed legacy snapshots containing credential-shaped strings", () => {
		const credential = `AKIA${"1234567890ABCDEF"}`;
		fs.writeFileSync(
			snapshotFile(),
			JSON.stringify({
				schemaVersion: CONTEXT_BUDGET_DISK_CACHE_SCHEMA_VERSION,
				representations: [[credential]],
				negatives: [],
			}),
			"utf8",
		);

		const provider = createDiskContextBudgetCacheProviderV2({ dir });
		expect(provider.size).toBe(0);
		expect(provider.lastLoadError).toBe("snapshot contains credential-shaped text");
		expect(fs.existsSync(snapshotFile())).toBe(false);
	});

	it("debounces writes into a single flush", async () => {
		const provider = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 5 });
		provider.writeRepresentation({ key: "a", entry: entry() });
		provider.writeRepresentation({ key: "b", entry: entry() });
		expect(fs.existsSync(snapshotFile())).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const raw = JSON.parse(fs.readFileSync(snapshotFile(), "utf8"));
		expect(raw.representations).toHaveLength(2);
	});

	it("survives an unwritable snapshot directory without throwing", () => {
		const blocked = path.join(dir, "blocked");
		fs.writeFileSync(blocked, "i am a file, not a directory", "utf8");
		const provider = createDiskContextBudgetCacheProviderV2({ dir: blocked, flushDebounceMs: 0 });
		expect(() => provider.writeRepresentation({ key: "k1", entry: entry() })).not.toThrow();
		expect(provider.flush()).toBe(false);
		expect(provider.readRepresentation("k1")).toBeDefined();
	});

	it("deleting an entry is persisted", () => {
		const first = createDiskContextBudgetCacheProviderV2({ dir, flushDebounceMs: 0 });
		first.writeRepresentation({ key: "k1", entry: entry() });
		first.deleteRepresentation("k1");
		first.close();
		expect(createDiskContextBudgetCacheProviderV2({ dir }).readRepresentation("k1")).toBeUndefined();
	});
});
