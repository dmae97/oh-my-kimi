import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const ignoredDirectoryPaths = new Set([join("vendor", "oh-my-pi")]);
// The pre-existing third-party scratch tree is only the exact `~` child of the scan root.
const rootScratchDirectory = "~";
const files = [];
const scanRoot = process.argv[2] ?? ".";

function collectTypescriptFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const childDirectory = join(directory, entry.name);
			if (!isIgnoredDirectory(directory, entry.name, childDirectory)) {
				collectTypescriptFiles(childDirectory);
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}
function isIgnoredDirectory(directory, name, childDirectory) {
	return (
		ignoredDirectories.has(name) ||
		ignoredDirectoryPaths.has(relative(scanRoot, childDirectory)) ||
		(directory === scanRoot && name === rootScratchDirectory)
	);
}


function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

function getImportTypeSpecifier(node) {
	if (!ts.isLiteralTypeNode(node.argument)) return undefined;
	if (!ts.isStringLiteralLike(node.argument.literal)) return undefined;
	return node.argument.literal;
}

const failures = [];

collectTypescriptFiles(scanRoot);

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

	function checkSpecifier(node) {
		if (!isRelativeJavaScriptSpecifier(node.text)) return;
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		failures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			checkSpecifier(node.arguments[0]);
		} else if (ts.isImportTypeNode(node)) {
			const specifier = getImportTypeSpecifier(node);
			if (specifier) checkSpecifier(specifier);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
