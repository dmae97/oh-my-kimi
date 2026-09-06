import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

it("every public workspace ships a changelog with its current version", () => {
	const checked = [];
	for (const directory of readdirSync(join(root, "packages"))) {
		const base = join(root, "packages", directory);
		if (!existsSync(join(base, "package.json"))) continue;
		const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
		if (pkg.private) continue;
		assert.ok(pkg.files?.includes("CHANGELOG.md"), `${pkg.name}: CHANGELOG.md must ship in npm files`);
		const text = readFileSync(join(base, "CHANGELOG.md"), "utf8");
		const release = [...text.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)][0];
		assert.equal(release?.[1], pkg.version, `${pkg.name}: dated changelog must match package version`);
		checked.push(pkg.name);
	}
	assert.equal(checked.length, 7);
});
