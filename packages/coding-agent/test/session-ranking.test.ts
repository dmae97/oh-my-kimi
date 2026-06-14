import { describe, expect, it } from "bun:test";
import {
	mergeSessionRanking,
	rankSessionSearchMatches,
} from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

function makeSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
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
		...overrides,
	};
}

const ids = (sessions: SessionInfo[]): string[] => sessions.map(s => s.id);

describe("rankSessionSearchMatches", () => {
	it("keeps literal query matches recency-first instead of overvaluing earlier word position", () => {
		const oldPrefix = makeSession("old-prefix", {
			title: "Resize Buffer Issue",
			firstMessage: "why doesnt resize properly clean the scrollback buffer",
			modified: new Date("2024-01-01T00:00:00Z"),
		});
		const oldControls = makeSession("old-controls", {
			title: "Resize Controls",
			firstMessage: "can you make width height resize always clean reset",
			modified: new Date("2024-01-01T01:00:00Z"),
		});
		const recentWindow = makeSession("recent-window", {
			title: "Window Resize Issues",
			firstMessage: "when i resize the window rapidly i end up with this",
			modified: new Date("2024-01-03T00:00:00Z"),
		});

		expect(ids(rankSessionSearchMatches([oldPrefix, oldControls, recentWindow], "resize"))).toEqual([
			"recent-window",
			"old-controls",
			"old-prefix",
		]);
	});

	it("keeps literal substring matches ahead of pure fuzzy matches", () => {
		const fuzzyRecent = makeSession("fuzzy-recent", {
			title: "Render Buffer",
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const literalOld = makeSession("literal-old", {
			title: "RB Notes",
			modified: new Date("2024-01-01T00:00:00Z"),
		});

		expect(ids(rankSessionSearchMatches([fuzzyRecent, literalOld], "rb"))).toEqual(["literal-old", "fuzzy-recent"]);
	});

	it("filters low-quality pure fuzzy matches while keeping exact matches", () => {
		const exact = makeSession("exact", {
			title: "MN Discussion",
		});
		const lowQuality = makeSession("low-quality", {
			title: "Random Notes",
		});

		expect(ids(rankSessionSearchMatches([exact, lowQuality], "mn"))).toEqual(["exact"]);
	});

	it("returns all sessions unchanged for an empty query", () => {
		const sessions = [makeSession("a"), makeSession("b")];

		expect(rankSessionSearchMatches(sessions, "   ")).toBe(sessions);
	});
});

describe("mergeSessionRanking", () => {
	it("orders prompt-history matches first by history rank, then metadata-only matches", () => {
		const all = ["a", "b", "c", "d", "e"].map(id => makeSession(id));
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = ["a", "b", "c"].map(id => byId.get(id)!); // metadata matches, already ranked
		const historyIds = ["c", "a", "e"]; // prompt matches, best→worst

		// c,a,e matched prompt history → lead in history order; b is metadata-only.
		expect(ids(mergeSessionRanking(all, fuzzy, historyIds))).toEqual(["c", "a", "e", "b"]);
	});

	it("never drops a metadata match and appends it after prompt-history matches", () => {
		const all = ["a", "b"].map(id => makeSession(id));
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = [byId.get("a")!];

		expect(ids(mergeSessionRanking(all, fuzzy, ["b"]))).toEqual(["b", "a"]);
	});

	it("surfaces purely history-matched sessions ordered by prompt-history rank", () => {
		const all = ["a", "b", "c"].map(id => makeSession(id));

		// No fuzzy match at all; c is the best prompt-history match, then a. b is excluded.
		expect(ids(mergeSessionRanking(all, [], ["c", "a"]))).toEqual(["c", "a"]);
	});

	it("ignores history matches for sessions absent from the list", () => {
		const all = [makeSession("a")];
		const byId = new Map(all.map(s => [s.id, s]));

		// "z" is matched in history but not resumable from this list → dropped.
		expect(ids(mergeSessionRanking(all, [byId.get("a")!], ["a", "z"]))).toEqual(["a"]);
	});

	it("returns the fuzzy result unchanged when there are no history matches", () => {
		const all = ["a", "b"].map(id => makeSession(id));
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = ["b", "a"].map(id => byId.get(id)!);

		expect(ids(mergeSessionRanking(all, fuzzy, []))).toEqual(["b", "a"]);
	});
});
