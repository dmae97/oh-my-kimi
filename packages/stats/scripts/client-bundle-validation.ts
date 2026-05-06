import * as path from "node:path";

type BundlePackage = "react" | "react-dom";

export interface ClientBundleReactVersions {
	react: string | null;
	"react-dom": string | null;
}

interface PackageResolution {
	name: BundlePackage;
	root: string;
}

function resolveBundledPackage(inputPath: string, cwd: string): PackageResolution | null {
	const absolutePath = path.resolve(cwd, inputPath);
	const parts = absolutePath.split(path.sep);
	const nodeModulesIndex = parts.lastIndexOf("node_modules");
	if (nodeModulesIndex === -1) return null;

	const packageName = parts[nodeModulesIndex + 1];
	if (packageName !== "react" && packageName !== "react-dom") return null;

	return {
		name: packageName,
		root: parts.slice(0, nodeModulesIndex + 2).join(path.sep) || path.sep,
	};
}

async function readPackageVersion(packageRoot: string): Promise<string> {
	const packageJson = (await Bun.file(path.join(packageRoot, "package.json")).json()) as { version?: unknown };
	if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
		throw new Error(`Missing version in ${path.join(packageRoot, "package.json")}`);
	}
	return packageJson.version;
}

export async function validateClientBundleReactVersions(
	metafile: Bun.BuildMetafile | undefined,
	cwd = process.cwd(),
): Promise<ClientBundleReactVersions> {
	if (!metafile) {
		throw new Error("Stats client build did not emit a metafile; cannot verify bundled React versions");
	}

	const packageRoots: Record<BundlePackage, Set<string>> = {
		react: new Set(),
		"react-dom": new Set(),
	};

	for (const inputPath of Object.keys(metafile.inputs)) {
		const resolution = resolveBundledPackage(inputPath, cwd);
		if (resolution) packageRoots[resolution.name].add(resolution.root);
	}

	const versions: Record<BundlePackage, Set<string>> = {
		react: new Set(),
		"react-dom": new Set(),
	};

	for (const packageName of ["react", "react-dom"] as const) {
		for (const packageRoot of packageRoots[packageName]) {
			versions[packageName].add(await readPackageVersion(packageRoot));
		}
	}

	const reactVersions = [...versions.react].sort();
	const reactDomVersions = [...versions["react-dom"]].sort();
	const resolved: ClientBundleReactVersions = {
		react: reactVersions.length === 1 ? reactVersions[0] : null,
		"react-dom": reactDomVersions.length === 1 ? reactDomVersions[0] : null,
	};

	if (reactVersions.length !== 1 || reactDomVersions.length !== 1) {
		throw new Error(
			`Stats client bundle must include exactly one react and one react-dom version; got react: ${reactVersions.join(", ") || "none"}, react-dom: ${reactDomVersions.join(", ") || "none"}`,
		);
	}

	if (resolved.react !== resolved["react-dom"]) {
		throw new Error(
			`Stats client bundle has incompatible React versions: react ${resolved.react}, react-dom ${resolved["react-dom"]}`,
		);
	}

	return resolved;
}
