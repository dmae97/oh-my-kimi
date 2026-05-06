import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateClientBundleReactVersions } from "../scripts/client-bundle-validation";

let tempDir: string | null = null;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = null;
});

async function writePackageVersion(packageName: "react" | "react-dom", version: string): Promise<string> {
	if (!tempDir) tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-react-bundle-"));
	const packageRoot = path.join(tempDir, "node_modules", packageName);
	await fs.mkdir(packageRoot, { recursive: true });
	await Bun.write(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version }));
	await Bun.write(path.join(packageRoot, "index.js"), "export {};");
	return path.join(packageRoot, "index.js");
}

function metafileFor(inputs: string[]): Bun.BuildMetafile {
	return {
		inputs: Object.fromEntries(inputs.map(input => [input, { bytes: 1, imports: [] }])),
		outputs: {},
	};
}

describe("stats client React bundle validation", () => {
	it("accepts a bundle with matching react and react-dom versions", async () => {
		const reactInput = await writePackageVersion("react", "19.2.5");
		const reactDomInput = await writePackageVersion("react-dom", "19.2.5");

		await expect(validateClientBundleReactVersions(metafileFor([reactInput, reactDomInput]))).resolves.toEqual({
			react: "19.2.5",
			"react-dom": "19.2.5",
		});
	});

	it("rejects a bundle with mismatched react and react-dom versions", async () => {
		const reactInput = await writePackageVersion("react", "19.2.0");
		const reactDomInput = await writePackageVersion("react-dom", "19.2.5");

		await expect(validateClientBundleReactVersions(metafileFor([reactInput, reactDomInput]))).rejects.toThrow(
			"Stats client bundle has incompatible React versions: react 19.2.0, react-dom 19.2.5",
		);
	});
});
