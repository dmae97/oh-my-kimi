import ts from "typescript";

function specifierText(node) {
	return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function importDeclarationIsRuntime(node) {
	const clause = node.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name) return true;
	const bindings = clause.namedBindings;
	if (!bindings || ts.isNamespaceImport(bindings)) return true;
	return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationIsRuntime(node) {
	if (node.isTypeOnly) return false;
	const clause = node.exportClause;
	if (!clause || ts.isNamespaceExport(clause)) return true;
	return clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly);
}

/** Return relative module specifiers whose imports survive TypeScript erasure. */
export function runtimeImportSpecifiers(source, fileName) {
	const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
	const specifiers = [];

	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement) && importDeclarationIsRuntime(statement)) {
			const specifier = specifierText(statement.moduleSpecifier);
			if (specifier) specifiers.push(specifier);
		} else if (ts.isExportDeclaration(statement) && exportDeclarationIsRuntime(statement)) {
			const specifier = specifierText(statement.moduleSpecifier);
			if (specifier) specifiers.push(specifier);
		}
	}

	function visit(node) {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const specifier = specifierText(node.arguments[0]);
			if (specifier) specifiers.push(specifier);
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return specifiers;
}
