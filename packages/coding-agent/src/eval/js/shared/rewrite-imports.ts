import { parse as babelParse } from "@babel/parser";

// Static ESM `import` declarations are not valid inside vm.runInContext (script-mode parsing).
// We rewrite top-level imports to dynamic-import expressions in the user-supplied source so
// pasted ESM runs verbatim. A real parser keeps imports embedded in string literals, template
// literals, or comments intact.

type BabelImportDeclaration = {
	type: "ImportDeclaration";
	start: number;
	end: number;
	source: { value: string };
	specifiers: ReadonlyArray<{
		type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" | "ImportSpecifier";
		local: { name: string };
		imported?: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
	}>;
	attributes?: ReadonlyArray<{
		key: { type: "Identifier"; name: string } | { type: "StringLiteral"; value: string };
		value: { value: string };
	}>;
};

type BabelLexicalDecl =
	| { type: "VariableDeclaration"; kind: "const" | "let" | "var"; start: number; end: number }
	| { type: "ClassDeclaration"; start: number; end: number; id: { start: number; end: number; name: string } | null };

function buildDynamicImportCall(sourceLiteral: string, withClause: string | undefined): string {
	// Route every static import through the worker-injected `__omp_import__` helper so the
	// specifier resolves against the session cwd (and `with`-attribute imports keep working).
	return withClause ? `__omp_import__(${sourceLiteral}, ${withClause})` : `__omp_import__(${sourceLiteral})`;
}

function buildWithClause(node: BabelImportDeclaration): string | undefined {
	const attrs = node.attributes;
	if (!attrs || attrs.length === 0) return undefined;
	const pairs = attrs.map(attr => {
		const key = attr.key.type === "Identifier" ? attr.key.name : JSON.stringify(attr.key.value);
		return `${key}: ${JSON.stringify(attr.value.value)}`;
	});
	return `{ ${pairs.join(", ")} }`;
}

function rewriteImportNode(node: BabelImportDeclaration): string {
	const sourceLiteral = JSON.stringify(node.source.value);
	const withClause = buildWithClause(node);
	const importCall = buildDynamicImportCall(sourceLiteral, withClause);

	let defaultName: string | undefined;
	let namespaceName: string | undefined;
	const namedPairs: Array<[string, string]> = [];
	for (const spec of node.specifiers) {
		if (spec.type === "ImportDefaultSpecifier") {
			defaultName = spec.local.name;
		} else if (spec.type === "ImportNamespaceSpecifier") {
			namespaceName = spec.local.name;
		} else if (spec.type === "ImportSpecifier" && spec.imported) {
			const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
			namedPairs.push([imported, spec.local.name]);
		}
	}

	if (namedPairs.length > 0) {
		const inner = namedPairs.map(([imp, loc]) => (imp === loc ? imp : `${imp}: ${loc}`)).join(", ");
		const props = defaultName ? `default: ${defaultName}, ${inner}` : inner;
		return `const { ${props} } = await ${importCall};`;
	}
	if (namespaceName && defaultName) {
		return `const ${namespaceName} = await ${importCall}; const ${defaultName} = ${namespaceName}.default;`;
	}
	if (namespaceName) return `const ${namespaceName} = await ${importCall};`;
	if (defaultName) return `const ${defaultName} = (await ${importCall}).default;`;
	return `await ${importCall};`;
}

export function rewriteStaticImports(code: string): string {
	if (!code.includes("import")) return code;

	let ast: { program: { body: ReadonlyArray<{ type: string }> } };
	try {
		ast = babelParse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
		}) as unknown as typeof ast;
	} catch {
		// Parser bailed entirely — let the VM surface the real syntax error.
		return code;
	}

	const imports: BabelImportDeclaration[] = [];
	for (const node of ast.program.body) {
		if (node.type === "ImportDeclaration") imports.push(node as unknown as BabelImportDeclaration);
	}
	if (imports.length === 0) return code;

	// Splice from the back so earlier offsets stay valid.
	imports.sort((a, b) => b.start - a.start);
	let result = code;
	for (const node of imports) {
		result = result.slice(0, node.start) + rewriteImportNode(node) + result.slice(node.end);
	}
	return result;
}

/**
 * Demote top-level `const`/`let`/`class` declarations to `var` so they persist on the
 * worker's globalThis across indirect `eval` calls. Indirect eval gives each call its own
 * lexical environment, so `const x = 1` in one cell would be invisible to the next.
 * `var` and function declarations are stored on the global object and survive across cells.
 *
 *   const x = 1;             -> var x = 1;
 *   let { a, b } = obj;      -> var { a, b } = obj;
 *   class Foo extends Bar {} -> var Foo = class extends Bar {};
 *
 * Nested declarations (inside functions, blocks, classes) are left alone \u2014 they're
 * scoped to their enclosing function/block regardless of `var` vs `let`/`const`.
 */
export function demoteTopLevelLexicals(code: string): string {
	if (!/\b(?:const|let|class)\b/.test(code)) return code;

	let ast: { program: { body: ReadonlyArray<{ type: string }> } };
	try {
		ast = babelParse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
		}) as unknown as typeof ast;
	} catch {
		return code;
	}

	const targets: BabelLexicalDecl[] = [];
	for (const node of ast.program.body) {
		if (node.type === "VariableDeclaration") {
			const decl = node as unknown as BabelLexicalDecl & { kind: string };
			if (decl.kind === "const" || decl.kind === "let") targets.push(decl as BabelLexicalDecl);
		} else if (node.type === "ClassDeclaration") {
			const decl = node as unknown as Extract<BabelLexicalDecl, { type: "ClassDeclaration" }>;
			if (decl.id) targets.push(decl);
		}
	}
	if (targets.length === 0) return code;

	targets.sort((a, b) => b.start - a.start);
	let result = code;
	for (const node of targets) {
		const segment = result.slice(node.start, node.end);
		let replacement: string;
		if (node.type === "VariableDeclaration") {
			replacement = `var${segment.slice(node.kind.length)}`;
		} else {
			const id = node.id;
			if (!id) continue;
			const idEndInSegment = id.end - node.start;
			const tail = segment.slice(idEndInSegment);
			const hasTrailingSemi = segment.endsWith(";");
			replacement = `var ${id.name} = class${tail}${hasTrailingSemi ? "" : ";"}`;
		}
		result = result.slice(0, node.start) + replacement + result.slice(node.end);
	}
	return result;
}


/**
 * Strip TypeScript syntax (type annotations, `interface`, `as`, `satisfies`, generics in
 * call expressions, etc.) before the import/lexical rewriters parse the code. We use Bun's
 * native transpiler in `ts` loader mode — fast, no JSX transforms, preserves `import`/
 * `export` declarations so the downstream Babel rewrites keep working.
 *
 * Skipped when the code parses as plain JavaScript already (Babel can accept it), so the
 * common case avoids an extra transpile pass. We detect "looks like TS" with a cheap regex
 * before invoking the transpiler.
 */
export function stripTypeScript(code: string): string {
	if (!LOOKS_LIKE_TS.test(code)) return code;
	try {
		return new Bun.Transpiler({ loader: "ts" }).transformSync(code);
	} catch {
		// Transpiler failed (e.g. unrecoverable syntax). Hand the original source back so the
		// downstream rewriter / VM surfaces the real error to the user.
		return code;
	}
}

// Heuristic: any of the obvious TS-only tokens. Plain JS using `as` only inside strings
// won't match because we require a leading word boundary plus a colon/keyword neighbor.
const LOOKS_LIKE_TS =
	/(?:\binterface\s+\w|\btype\s+\w+\s*=|\b(?:as|satisfies)\s+(?:[A-Z]|\bconst\b)|:\s*(?:string|number|boolean|any|unknown|void|never|object|[A-Z]\w*)\b|<\s*[A-Z]\w*\s*[,>])/;

export function wrapCode(code: string): { source: string; asyncWrapped: boolean } {
	const rewritten = demoteTopLevelLexicals(rewriteStaticImports(stripTypeScript(code)));
	const needsAsyncWrapper = /\bawait\b|\breturn\b/.test(rewritten);
	if (!needsAsyncWrapper) {
		return { source: rewritten, asyncWrapped: false };
	}
	return {
		source: `(async () => {\n${rewritten}\n})()`,
		asyncWrapped: true,
	};
}
