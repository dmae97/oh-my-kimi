import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("issue #5879: legacy provider compatibility", () => {
	it("loads an extension that calls historical stream and auth exports", async () => {
		const projectDir = TempDir.createSync("@issue-5879-");
		const extensionPath = path.join(projectDir.path(), "pi-provider-like-plugin", "index.ts");
		await Bun.write(
			extensionPath,
			[
				'import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";',
				'import { AuthStorage } from "@earendil-works/pi-coding-agent";',
				"",
				"export default function() {",
				"\tconst stream = createAssistantMessageEventStream();",
				'\tconst credential = AuthStorage.create().get("issue-5879-missing-provider");',
				'\tif (credential !== undefined) throw new Error("Unexpected test credential");',
				'\tif (typeof stream.push !== "function") throw new Error("Invalid assistant message event stream");',
				"}",
			].join("\n"),
		);

		try {
			const result = await loadExtensions([extensionPath], projectDir.path());

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		} finally {
			projectDir.removeSync();
		}
	});
});
