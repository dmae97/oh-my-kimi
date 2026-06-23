/**
 * Contract tests for language detection from file paths.
 *
 * `getLanguageFromPath` returns the highlight language id for a given file
 * path, or undefined if unknown. `detectLanguageId` returns the LSP language
 * identifier, falling back to "plaintext".
 */
import { describe, expect, it } from "bun:test";
import { detectLanguageId, getLanguageFromPath } from "../../src/utils/lang-from-path";

describe("getLanguageFromPath", () => {
	it("detects common languages by extension", () => {
		expect(getLanguageFromPath("src/main.ts")).toBe("typescript");
		expect(getLanguageFromPath("app.tsx")).toBe("tsx");
		expect(getLanguageFromPath("script.js")).toBe("javascript");
		expect(getLanguageFromPath("component.jsx")).toBe("javascript");
		expect(getLanguageFromPath("main.rs")).toBe("rust");
		expect(getLanguageFromPath("main.go")).toBe("go");
		expect(getLanguageFromPath("main.c")).toBe("c");
		expect(getLanguageFromPath("main.cpp")).toBe("cpp");
		expect(getLanguageFromPath("main.py")).toBe("python");
		expect(getLanguageFromPath("main.rb")).toBe("ruby");
	});

	it("detects TypeScript variants (.cts, .mts)", () => {
		expect(getLanguageFromPath("config.cts")).toBe("typescript");
		expect(getLanguageFromPath("config.mts")).toBe("typescript");
	});

	it("is case-insensitive on extensions", () => {
		expect(getLanguageFromPath("Main.TS")).toBe("typescript");
		expect(getLanguageFromPath("App.TSX")).toBe("tsx");
		expect(getLanguageFromPath("script.JS")).toBe("javascript");
	});

	it("returns undefined for unknown extensions", () => {
		expect(getLanguageFromPath("file.unknownext")).toBeUndefined();
		expect(getLanguageFromPath("file.xyz123")).toBeUndefined();
	});

	it("detects Dockerfile by basename (case-insensitive)", () => {
		expect(getLanguageFromPath("Dockerfile")).toBe("dockerfile");
		expect(getLanguageFromPath("dockerfile")).toBe("dockerfile");
		expect(getLanguageFromPath("Dockerfile.dev")).toBe("dockerfile");
		expect(getLanguageFromPath("DOCKERFILE")).toBe("dockerfile");
	});

	it("detects Containerfile", () => {
		expect(getLanguageFromPath("Containerfile")).toBe("dockerfile");
	});

	it("detects .env files by prefix", () => {
		expect(getLanguageFromPath(".env.local")).toBe("env");
		expect(getLanguageFromPath(".env.production")).toBe("env");
		// .env basename doesn't start with ".env." (no trailing dot), so the
		// prefix check doesn't fire. But themeExtensionKey(".env") returns "env"
		// which matches the extension table.
		expect(getLanguageFromPath(".env")).toBe("env");
	});

	it("detects .emacs", () => {
		expect(getLanguageFromPath(".emacs")).toBe("emacs-lisp");
	});

	it("detects justfile", () => {
		expect(getLanguageFromPath("justfile")).toBe("just");
	});

	it("detects CMakeLists.txt — but .txt extension wins over basename check", () => {
		// getLanguageFromPath checks themeExtensionKey first, which returns "txt"
		// for CMakeLists.txt, matching the extension table entry ["text", "plaintext"].
		// The CMakeLists.txt basename check at line 215 is only reached when the
		// extension lookup fails. This is a known limitation — detectLanguageId
		// handles it correctly by checking basename first.
		expect(getLanguageFromPath("CMakeLists.txt")).toBe("text");
	});

	it("handles full paths with directories", () => {
		expect(getLanguageFromPath("/home/user/project/src/index.ts")).toBe("typescript");
		expect(getLanguageFromPath("C:\\Users\\dev\\app\\main.rs")).toBe("rust");
		expect(getLanguageFromPath("../lib/utils.py")).toBe("python");
	});

	it("returns the last extension when multiple dots are present", () => {
		// themeExtensionKey takes everything after the LAST dot
		expect(getLanguageFromPath("config.test.ts")).toBe("typescript");
		expect(getLanguageFromPath("app.component.tsx")).toBe("tsx");
	});

	it("returns undefined for files with no extension", () => {
		// A bare filename like "README" has no dot — themeExtensionKey
		// returns the lowercased basename, which won't match any extension
		expect(getLanguageFromPath("README")).toBeUndefined();
	});
});

describe("detectLanguageId", () => {
	it("detects common languages by extension", () => {
		expect(detectLanguageId("main.ts")).toBe("typescript");
		expect(detectLanguageId("app.tsx")).toBe("typescriptreact");
		expect(detectLanguageId("script.js")).toBe("javascript");
		expect(detectLanguageId("main.rs")).toBe("rust");
		expect(detectLanguageId("main.go")).toBe("go");
	});

	it("detects Dockerfile as dockerfile", () => {
		expect(detectLanguageId("Dockerfile")).toBe("dockerfile");
		expect(detectLanguageId("dockerfile.dev")).toBe("dockerfile");
	});

	it("detects Containerfile as dockerfile", () => {
		expect(detectLanguageId("Containerfile")).toBe("dockerfile");
	});

	it("detects .emacs as emacs-lisp", () => {
		expect(detectLanguageId(".emacs")).toBe("emacs-lisp");
	});

	it("detects Makefile as makefile", () => {
		expect(detectLanguageId("Makefile")).toBe("makefile");
		expect(detectLanguageId("makefile")).toBe("makefile");
		expect(detectLanguageId("gnumakefile")).toBe("makefile");
	});

	it("detects justfile as just", () => {
		expect(detectLanguageId("justfile")).toBe("just");
	});

	it("detects CMakeLists.txt as cmake", () => {
		expect(detectLanguageId("CMakeLists.txt")).toBe("cmake");
	});

	it("detects .cmake extension as cmake", () => {
		expect(detectLanguageId("FindPackage.cmake")).toBe("cmake");
	});

	it("falls back to plaintext for unknown extensions", () => {
		expect(detectLanguageId("file.unknownext")).toBe("plaintext");
		expect(detectLanguageId("file.xyz123")).toBe("plaintext");
	});

	it("falls back to plaintext for files with no extension", () => {
		expect(detectLanguageId("README")).toBe("plaintext");
	});

	it("uses path.extname for LSP detection (not last-dot heuristic)", () => {
		// detectLanguageId uses path.extname which only takes the last segment
		// after the last dot that is also after the last path separator
		expect(detectLanguageId("config.test.ts")).toBe("typescript");
		expect(detectLanguageId("app.component.tsx")).toBe("typescriptreact");
	});
});
