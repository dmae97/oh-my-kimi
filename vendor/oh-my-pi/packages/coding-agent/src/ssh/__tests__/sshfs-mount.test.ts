import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isMounted } from "../sshfs-mount";

describe("isMounted", () => {
	it("detects a macOS mount point when mountpoint is unavailable", async () => {
		const parentPath = import.meta.dir;
		const mountPath = path.join(parentPath, "mounted");
		const stat = async (filePath: string) => ({ dev: filePath === mountPath ? 2 : 1 });

		await expect(isMounted(mountPath, { platform: "darwin", stat, which: () => null })).resolves.toBe(true);
	});
});
