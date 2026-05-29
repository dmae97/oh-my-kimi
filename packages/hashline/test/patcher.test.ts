import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, MismatchError, Patch, Patcher } from "@oh-my-pi/hashline";

const PATH = "a.ts";

describe("Patcher snapshot tag integrity", () => {
	it("requires a snapshot store at construction", () => {
		const fs = new InMemoryFilesystem();
		const options = { fs } as unknown as { fs: InMemoryFilesystem; snapshots: InMemorySnapshotStore };

		expect(() => new Patcher(options)).toThrow(/requires a SnapshotStore/);
	});

	it("applies when the section tag resolves to a matching snapshot", async () => {
		const fs = new InMemoryFilesystem([[PATH, "before\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.recordContiguous(PATH, 1, ["before", ""], { fullText: "before\n" });
		const patcher = new Patcher({ fs, snapshots });

		const result = await patcher.apply(Patch.parse(`¶${PATH}#${tag}\n1 1\n+after`));

		expect(result.sections[0]?.op).toBe("update");
		expect(result.sections[0]?.fileHash).toMatch(/^[0-9A-F]{3}$/);
		expect(result.sections[0]?.fileHash).not.toBe(tag);
		expect(fs.get(PATH)).toBe("after\n");
	});

	it("normalizes lowercase section tags while parsing", () => {
		const section = Patch.parseSingle(`¶${PATH}#0a3\n1 1\n+after`);

		expect(section.fileHash).toBe("0A3");
	});

	it("rejects a wrapped tag whose slot now holds unrelated content", async () => {
		const fs = new InMemoryFilesystem([[PATH, "target\n"]]);
		const snapshots = new InMemorySnapshotStore();
		for (let index = 0; index < 10; index++) {
			snapshots.recordContiguous(PATH, 1, [`warmup ${index}`]);
		}
		const staleTag = snapshots.recordContiguous(PATH, 1, ["target", ""], { fullText: "target\n" });
		for (let index = 0; index < 4096; index++) {
			snapshots.recordContiguous(PATH, 1, [`unrelated ${index}`]);
		}
		const patcher = new Patcher({ fs, snapshots });
		const patch = Patch.parse(`¶${PATH}#${staleTag}\n1 1\n|changed`);

		await expect(patcher.apply(patch)).rejects.toBeInstanceOf(MismatchError);
		expect(fs.get(PATH)).toBe("target\n");
	});

	it("refuses with mismatch when the snapshot exists for the hash but content drifted", async () => {
		const fs = new InMemoryFilesystem([[PATH, "drifted\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.recordContiguous(PATH, 1, ["before", ""], { fullText: "before\n" });
		const patcher = new Patcher({ fs, snapshots });

		try {
			await patcher.apply(Patch.parse(`¶${PATH}#${tag}\n1 1\n+after`));
			throw new Error("expected MismatchError");
		} catch (error) {
			expect(error).toBeInstanceOf(MismatchError);
			const message = (error as MismatchError).displayMessage;
			// Hash WAS observed for this path, so we land on the "file changed" branch.
			expect(message).toMatch(/file changed between read and edit/);
			expect(message).toMatch(/Section is bound to #/);
		}
		// Disk untouched — refusal must never leave a partial write.
		expect(fs.get(PATH)).toBe("drifted\n");
	});

	it("refuses with a 'not from this session' diagnostic when the hash was never recorded for this path", async () => {
		const fs = new InMemoryFilesystem([[PATH, "current\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots });
		// `#FFF` parses cleanly as a 3-hex slot tag but no snapshot has ever
		// been minted into that slot for this path — equivalent to the model
		// either fabricating the hash or carrying it over from a prior session.

		try {
			await patcher.apply(Patch.parse(`¶${PATH}#FFF\n1 1\n+after`));
			throw new Error("expected MismatchError");
		} catch (error) {
			expect(error).toBeInstanceOf(MismatchError);
			const message = (error as MismatchError).displayMessage;
			expect(message).toMatch(/hash #FFF is not from this session/);
			expect(message).toMatch(/never invent the tag/);
			// Still surfaces the current hash so the model can pivot to a re-read.
			expect(message).toMatch(/current file hashes to #[0-9A-F]{3}/);
		}
		expect(fs.get(PATH)).toBe("current\n");
	});
});
