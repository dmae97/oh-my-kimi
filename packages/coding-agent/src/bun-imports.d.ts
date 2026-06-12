/**
 * Type declarations for Bun's import attributes.
 * These allow importing non-JS files as text at build time.
 */

// Markdown files imported as text
declare module "*.md" {
	const content: string;
	export default content;
}

// Text files imported as text
declare module "*.txt" {
	const content: string;
	export default content;
}

// Python files imported as text
declare module "*.py" {
	const content: string;
	export default content;
}

// Lark grammar files imported as text
declare module "*.lark" {
	const content: string;
	export default content;
}

// Session-export template assets imported as text.
// No `*.html` declaration: bun-types claims that pattern as HTMLBundle, so the
// text import in src/export/html/index.ts casts at the use site instead.
declare module "*.css" {
	const content: string;
	export default content;
}
declare module "*/template.js" {
	const content: string;
	export default content;
}

declare module "*.generated.js" {
	const content: string;
	export default content;
}
