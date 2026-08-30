import type { CompilerIdentity } from "./types.ts";

export const PACKAGE_VERSION = "0.98.1";

export const COMPILER_IDENTITY: CompilerIdentity = Object.freeze({
	package: "omk-book-to-skill",
	version: PACKAGE_VERSION,
	upstream: Object.freeze({
		repository: "https://github.com/virgiliojr94/book-to-skill",
		commit: "c4c5e948caaa912c9e2024b925a7cdee9237b0c0",
		declaredVersion: "1.4.0",
	}),
});
