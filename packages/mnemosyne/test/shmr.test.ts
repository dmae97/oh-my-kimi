import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { initBeam } from "../src/core/beam";
import {
	_cluster_by_similarity,
	_cosine_similarity,
	_embed,
	get_resonance_log,
	harmonize,
	recall_beliefs,
} from "../src/core/shmr";

describe("SHMR deterministic helpers", () => {
	it("clusters related hashed embeddings by cosine similarity", () => {
		const a = _embed("dark mode preference");
		const b = _embed("dark mode preference");
		const c = _embed("unrelated database migration");
		expect(_cosine_similarity(a, b)).toBeGreaterThan(0.99);
		const clusters = _cluster_by_similarity(
			[
				{ object: "dark mode preference", embedding: a },
				{ object: "dark mode preference", embedding: b },
				{ object: "unrelated database migration", embedding: c },
			],
			0.9,
		);
		expect(clusters.map(cluster => cluster.length).sort()).toEqual([1, 2]);
	});

	it("harmonizes corroborated facts without an LLM", () => {
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f1", "s", "user", "prefers", "dark mode", 0.8, "2026-01-01T00:00:00"],
			);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["f2", "s", "user", "prefers", "dark mode", 0.9, "2026-01-02T00:00:00"],
			);
			const stats = harmonize({ db, session_id: "s" }, 10, 1, 0.8);
			expect(stats.status).toBe("harmonized");
			expect(stats.clusters_found).toBe(1);
			expect(stats.beliefs_generated).toBeGreaterThanOrEqual(1);
			const beliefs = recall_beliefs({ db }, "dark mode", 5);
			expect(beliefs.some(belief => belief.content === "dark mode" && belief.source === "harmonic_belief")).toBe(
				true,
			);
			expect(get_resonance_log({ db }, 1)[0]?.beliefs_generated).toBeGreaterThanOrEqual(1);
		} finally {
			db.close();
		}
	});

	it("reports insufficient candidates deterministically", () => {
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const stats = harmonize({ db }, 10, 1, 0.8);
			expect(stats.status).toBe("insufficient_candidates");
			expect(stats.beliefs_generated).toBe(0);
		} finally {
			db.close();
		}
	});
});
