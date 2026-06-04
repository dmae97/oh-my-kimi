/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1832
 *
 * Before the fix:
 *   - `remember()`/`rememberBatch()` never invoked `embed()`, so the
 *     `memory_embeddings` table was always empty in production.
 *   - `recall()` never derived a query embedding from the query text,
 *     so the `dense_score` channel always read zero.
 *
 * This file pins both contracts using a deterministic in-process embedding
 * provider so the fix cannot silently regress in either direction.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import "./setup";
import { Mnemopi } from "../src/core/memory";
import { withMnemopiRuntimeOptions } from "../src/core/runtime-options";

interface EmbeddingRow {
	readonly memory_id: string;
	readonly embedding_json: string;
	readonly model: string | null;
}

/**
 * Deterministic fake provider: each text yields a 4-D vector based on the
 * presence of marker words. Different markers project onto orthogonal axes
 * so cosine similarity gives the expected nearest-neighbour ordering.
 */
function fakeProvider() {
	let callCount = 0;
	const provider = {
		// fastembed shape: async generator yielding batches of rows.
		async *embed(texts: readonly string[]) {
			callCount += 1;
			yield texts.map(text => {
				const lower = text.toLowerCase();
				if (lower.includes("alpha")) return [1, 0, 0, 0];
				if (lower.includes("beta")) return [0, 1, 0, 0];
				if (lower.includes("gamma")) return [0, 0, 1, 0];
				return [0, 0, 0, 1];
			});
		},
	};
	return { provider, calls: () => callCount };
}

function withFakeMemory<T>(fn: (memory: Mnemopi, calls: () => number) => Promise<T>): Promise<T> {
	const { provider, calls } = fakeProvider();
	const memory = new Mnemopi({
		db: new Database(":memory:"),
		embeddings: { provider: provider.embed.bind(provider) },
	});
	return fn(memory, calls).finally(() => memory.close());
}

/**
 * Re-enter the per-Mnemopi runtime-options scope when reaching into `memory.beam`
 * directly (only `Mnemopi.remember`/`recall`/etc. enter it automatically).
 */
function inScope<T>(memory: Mnemopi, fn: () => T): T {
	return withMnemopiRuntimeOptions(memory.runtimeOptions, fn);
}

function readEmbeddings(memory: Mnemopi): EmbeddingRow[] {
	return memory.conn
		.query("SELECT memory_id, embedding_json, model FROM memory_embeddings ORDER BY memory_id")
		.all() as EmbeddingRow[];
}

describe("issue #1832 — embedding write/read coverage", () => {
	it("remember() writes a row to memory_embeddings after flushExtractions()", async () => {
		await withFakeMemory(async (memory, calls) => {
			const memId = memory.remember("alpha facts about migration", { source: "test", importance: 0.5 });
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.memory_id).toBe(memId);
			// Body matches the alpha-bucket projection from the fake provider.
			expect(JSON.parse(rows[0]?.embedding_json ?? "[]")).toEqual([1, 0, 0, 0]);
			// Provider was actually invoked — not the silent no-op of the pre-fix world.
			expect(calls()).toBeGreaterThanOrEqual(1);
		});
	});

	it("rememberBatch() writes one embedding row per item in a single provider call", async () => {
		await withFakeMemory(async (memory, calls) => {
			const ids = inScope(memory, () =>
				memory.beam.rememberBatch([
					{ content: "alpha launch checklist" },
					{ content: "beta migration plan" },
					{ content: "gamma postmortem" },
				]),
			);
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			expect(rows.map(row => row.memory_id).sort()).toEqual([...ids].sort());
			expect(calls()).toBe(1);
			const byId = new Map(rows.map(row => [row.memory_id, JSON.parse(row.embedding_json) as number[]]));
			expect(byId.get(ids[0] ?? "")).toEqual([1, 0, 0, 0]);
			expect(byId.get(ids[1] ?? "")).toEqual([0, 1, 0, 0]);
			expect(byId.get(ids[2] ?? "")).toEqual([0, 0, 1, 0]);
		});
	});

	it("recall() auto-derives queryEmbedding and surfaces a non-zero dense_score", async () => {
		await withFakeMemory(async (memory, calls) => {
			memory.remember("alpha launch checklist", { source: "test" });
			memory.remember("beta migration plan", { source: "test" });
			memory.remember("gamma postmortem", { source: "test" });
			await memory.flushExtractions();
			const callsAfterEmbedding = calls();

			const results = await memory.recall("alpha", 3);
			const alphaHit = results.find(row => row.content === "alpha launch checklist");

			expect(alphaHit).toBeDefined();
			expect(typeof alphaHit?.dense_score).toBe("number");
			expect(alphaHit?.dense_score ?? 0).toBeGreaterThan(0);
			// recall() must have invoked the provider for the query text (a single
			// embedQuery for "alpha") — proving auto-derive ran.
			expect(calls()).toBeGreaterThan(callsAfterEmbedding);
		});
	});

	it("recall() honours an explicit queryEmbedding: null (FTS-only) without auto-derive", async () => {
		await withFakeMemory(async (memory, calls) => {
			memory.remember("alpha launch checklist", { source: "test" });
			await memory.flushExtractions();
			const callsAfterEmbedding = calls();

			const results = await memory.recall("alpha", 3, { queryEmbedding: null });
			expect(results.length).toBeGreaterThan(0);
			// dense_score collapses to 0 when no query vector is computed.
			expect(results[0]?.dense_score ?? 0).toBe(0);
			// And the provider is never invoked for the query side.
			expect(calls()).toBe(callsAfterEmbedding);
		});
	});

	it("updateWorking() re-embeds when content changes", async () => {
		await withFakeMemory(async memory => {
			const id = memory.remember("alpha facts about migration", { source: "test" });
			await memory.flushExtractions();

			expect(memory.update(id, "gamma postmortem")).toBe(true);
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			expect(rows).toHaveLength(1);
			// New content lands in the gamma bucket, replacing the alpha projection.
			expect(JSON.parse(rows[0]?.embedding_json ?? "[]")).toEqual([0, 0, 1, 0]);
		});
	});

	it("consolidateToEpisodic() writes an embedding for the new episodic id", async () => {
		await withFakeMemory(async memory => {
			const wmId = memory.remember("alpha launch checklist", { source: "test" });
			await memory.flushExtractions();

			const episodicId = inScope(memory, () =>
				memory.beam.consolidateToEpisodic("gamma postmortem summary", [wmId]),
			);
			await memory.flushExtractions();

			const rows = readEmbeddings(memory);
			const episodicRow = rows.find(row => row.memory_id === episodicId);
			expect(episodicRow).toBeDefined();
			expect(JSON.parse(episodicRow?.embedding_json ?? "[]")).toEqual([0, 0, 1, 0]);
		});
	});
});
