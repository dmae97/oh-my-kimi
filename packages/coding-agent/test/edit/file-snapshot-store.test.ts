import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";

interface SessionOwner {
	fileSnapshotStore?: InMemorySnapshotStore;
}

describe("canonicalSnapshotKey", () => {
	it("collapses symlink-equivalent forms (macOS /tmp ↔ /private/tmp) onto one key", async () => {
		// `os.tmpdir()` returns the realpath on macOS; mkdtemp under it gives us a
		// real directory that we can address via both /tmp/... and /private/tmp/...
		// when the platform has that symlink. Skip the assertion when it doesn't.
		const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-key-"));
		const filePath = path.join(realDir, "a.txt");
		await Bun.write(filePath, "x\n");

		const k1 = canonicalSnapshotKey(filePath);
		// If realDir already starts at the symlink target form, k1 === filePath
		// — that's also valid behavior. Either way both spellings MUST round-trip
		// to the same canonical key.
		expect(canonicalSnapshotKey(k1)).toBe(k1);

		// Construct the alternate spelling for tmpdir if /tmp -> /private/tmp.
		if (filePath.startsWith("/private/")) {
			const alt = filePath.slice("/private".length);
			expect(canonicalSnapshotKey(alt)).toBe(k1);
		}
	});

	it("falls back to parent realpath + basename for non-existent paths", async () => {
		const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-key-"));
		const missing = path.join(realDir, "does-not-exist.txt");
		// Snapshot key is still computable (used for write-then-snapshot flow).
		const key = canonicalSnapshotKey(missing);
		expect(key).toBe(path.join(canonicalSnapshotKey(realDir), "does-not-exist.txt"));
	});

	it("returns the input unchanged when nothing in the chain exists", () => {
		const key = canonicalSnapshotKey("/__definitely-not-a-real-path__/x/y/z.txt");
		expect(key).toBe("/__definitely-not-a-real-path__/x/y/z.txt");
	});
});

describe("snapshot store fusion via canonical keys", () => {
	it("records and looks up the same snapshot regardless of /tmp vs /private/tmp spelling", async () => {
		const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-fuse-"));
		const filePath = path.join(realDir, "a.txt");
		await Bun.write(filePath, "x\n");

		const session: SessionOwner = {};
		const store = getFileSnapshotStore(session);
		const hash = store.record(canonicalSnapshotKey(filePath), "x\n");

		// The hash MUST be retrievable via every path spelling that points at
		// the same file content (covers the patcher looking up a tag the read
		// tool minted under a different spelling).
		expect(store.byHash(canonicalSnapshotKey(filePath), hash)?.text).toBe("x\n");
		if (filePath.startsWith("/private/")) {
			const alt = filePath.slice("/private".length);
			expect(store.byHash(canonicalSnapshotKey(alt), hash)?.text).toBe("x\n");
		}
	});
});
