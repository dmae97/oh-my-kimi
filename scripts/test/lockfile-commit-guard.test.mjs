import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hasOnlyWorkspacePackageChanges } from "../check-lockfile-commit.mjs";

/**
 * The guard forces review of dependency changes, and exempts changes that only
 * touch workspace package metadata. That exemption missed the workspace root:
 * its lockfile entry is keyed `""`, which does not start with `packages/`, so a
 * version bump to the monorepo itself failed the check. Since every release
 * bumps the root, the guard blocked every release commit and the exemption it
 * shipped with never applied.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
void root;

describe("hasOnlyWorkspacePackageChanges", () => {
	it("exempts a release: root version bump plus workspace bumps", () => {
		assert.equal(
			hasOnlyWorkspacePackageChanges([
				{ lockPath: "", oldEntry: { name: "omk-monorepo", version: "0.97.0" }, newEntry: { name: "omk-monorepo", version: "0.98.0" } },
				{ lockPath: "packages/ai", oldEntry: { version: "0.97.0" }, newEntry: { version: "0.98.0" } },
			]),
			true,
		);
	});

	it("still refuses a root dependency change riding along with the bump", () => {
		assert.equal(
			hasOnlyWorkspacePackageChanges([
				{
					lockPath: "",
					oldEntry: { name: "omk-monorepo", version: "0.97.0", dependencies: {} },
					newEntry: { name: "omk-monorepo", version: "0.98.0", dependencies: { evil: "1.0.0" } },
				},
			]),
			false,
		);
	});

	it("still refuses a third-party package added under the root node_modules", () => {
		assert.equal(
			hasOnlyWorkspacePackageChanges([
				{ lockPath: "node_modules/left-pad", oldEntry: undefined, newEntry: { version: "1.3.0" } },
			]),
			false,
		);
	});

	it("keeps exempting pure workspace changes", () => {
		assert.equal(
			hasOnlyWorkspacePackageChanges([
				{ lockPath: "packages/agent/node_modules/omk-ai", oldEntry: { version: "0.96.2" }, newEntry: undefined },
			]),
			true,
		);
	});

	it("treats an empty change set as nothing to exempt", () => {
		assert.equal(hasOnlyWorkspacePackageChanges([]), false);
	});
});
