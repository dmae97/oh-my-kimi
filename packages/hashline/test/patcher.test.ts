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
});
