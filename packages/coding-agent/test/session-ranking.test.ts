import { describe, expect, it } from "bun:test";
import { mergeSessionRanking } from "../src/modes/components/session-selector";
import type { SessionInfo } from "../src/session/session-manager";

function makeSession(id: string): SessionInfo {
	return {
		path: `${id}.jsonl`,
		id,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		size: 100,
		firstMessage: "",
		allMessagesText: "",
	};
}

const ids = (sessions: SessionInfo[]): string[] => sessions.map(s => s.id);

describe("mergeSessionRanking", () => {
	it("orders dual matches first (in fuzzy order), then fuzzy-only, then history-only", () => {
		const all = ["a", "b", "c", "d", "e"].map(makeSession);
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = ["a", "b", "c"].map(id => byId.get(id)!); // metadata matches, best→worst
		const historyIds = ["c", "a", "e"]; // prompt matches, best→worst

		// a,c matched both → lead in their fuzzy order [a, c]; b fuzzy-only; e history-only.
		expect(ids(mergeSessionRanking(all, fuzzy, historyIds))).toEqual(["a", "c", "b", "e"]);
	});

	it("never drops a fuzzy match and appends history-only matches after it", () => {
		const all = ["a", "b"].map(makeSession);
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = [byId.get("a")!];

		expect(ids(mergeSessionRanking(all, fuzzy, ["b"]))).toEqual(["a", "b"]);
	});

	it("surfaces purely history-matched sessions ordered by history relevance", () => {
		const all = ["a", "b", "c"].map(makeSession);

		// No fuzzy match at all; c is the most relevant prompt match, then a. b is excluded.
		expect(ids(mergeSessionRanking(all, [], ["c", "a"]))).toEqual(["c", "a"]);
	});

	it("ignores history matches for sessions absent from the list", () => {
		const all = [makeSession("a")];
		const byId = new Map(all.map(s => [s.id, s]));

		// "z" is matched in history but not resumable from this list → dropped.
		expect(ids(mergeSessionRanking(all, [byId.get("a")!], ["a", "z"]))).toEqual(["a"]);
	});

	it("returns the fuzzy result unchanged when there are no history matches", () => {
		const all = ["a", "b"].map(makeSession);
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = ["b", "a"].map(id => byId.get(id)!);

		expect(ids(mergeSessionRanking(all, fuzzy, []))).toEqual(["b", "a"]);
	});
});
