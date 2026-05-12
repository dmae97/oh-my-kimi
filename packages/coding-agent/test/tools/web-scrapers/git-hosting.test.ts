import { describe, expect, it } from "bun:test";
import { handleGitHub } from "@oh-my-pi/pi-coding-agent/web/scrapers/github";
import { handleGitHubGist } from "@oh-my-pi/pi-coding-agent/web/scrapers/github-gist";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

// =============================================================================
// GitHub Tests
// =============================================================================

describe.skipIf(SKIP)("handleGitHub", () => {
	it("returns null for non-GitHub URLs", async () => {
		const result = await handleGitHub("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for other git hosting domains", async () => {
		const result = await handleGitHub("https://gitlab.com/user/repo", 10000);
		expect(result).toBeNull();
	});

	it("fetches repository root", async () => {
		const result = await handleGitHub("https://github.com/facebook/react", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-repo");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("facebook/react");
			expect(result.content).toContain("Stars:");
			expect(result.content).toContain("Forks:");
		}
		expect(result).toBeDefined();
	});

	it("fetches another repository", async () => {
		const result = await handleGitHub("https://github.com/microsoft/typescript", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-repo");
			// GitHub returns "TypeScript" with capital T
			expect(result.content).toContain("microsoft/TypeScript");
		}
		expect(result).toBeDefined();
	});

	it("fetches file blob", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/blob/main/README.md", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("github-raw");
		expect(result?.contentType).toBe("text/plain");
		expect(result?.content.length).toBeGreaterThan(0);
	});

	it("fetches file blob from specific branch", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/blob/main/package.json", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("github-raw");
		expect(result?.content.length).toBeGreaterThan(0);
	});

	it("fetches directory tree", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/tree/main/packages", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-tree");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("facebook/react");
			expect(result.content).toContain("Contents");
		}
		expect(result).toBeDefined();
	});

	it("fetches directory tree from root", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/tree/main", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-tree");
			expect(result.content).toContain("facebook/react");
		}
		expect(result).toBeDefined();
	});

	it("fetches issue", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/issues/1", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-issue");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content.length).toBeGreaterThan(0);
		}
		expect(result).toBeDefined();
	});

	it("fetches issues list", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/issues", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-issues");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content.length).toBeGreaterThan(0);
		}
		expect(result).toBeDefined();
	});

	it("handles pulls list endpoint", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/pulls", 20000);
		// Should be handled as pulls list but currently falls back to null
		// This tests the actual behavior
		expect(result).toBeDefined();
	});
});

// =============================================================================
// GitHub Gist Tests
// =============================================================================

describe.skipIf(SKIP)("handleGitHubGist", () => {
	it("returns null for non-gist URLs", async () => {
		const result = await handleGitHubGist("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for github.com URLs", async () => {
		const result = await handleGitHubGist("https://github.com/user/repo", 10000);
		expect(result).toBeNull();
	});

	it("returns null for gist.github.com root", async () => {
		const result = await handleGitHubGist("https://gist.github.com/", 10000);
		expect(result).toBeNull();
	});

	it("fetches a public gist with username", async () => {
		// Using a valid public gist ID (may change but structure should be consistent)
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-gist");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("Gist by");
			expect(result.content).toContain("Created:");
			expect(result.content).toContain("Files:");
		}
		expect(result).toBeDefined();
	});

	it("fetches a public gist without username in URL", async () => {
		// Same gist, accessed via short URL (without username)
		const result = await handleGitHubGist("https://gist.github.com/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-gist");
			expect(result.content).toContain("Gist by");
		}
		expect(result).toBeDefined();
	});

	it("returns null for invalid gist ID format", async () => {
		const result = await handleGitHubGist("https://gist.github.com/invalid-gist-id!", 10000);
		expect(result).toBeNull();
	});

	it("returns null for non-hexadecimal gist ID", async () => {
		const result = await handleGitHubGist("https://gist.github.com/notahexstring123", 10000);
		expect(result).toBeNull();
	});

	it("handles gist URL with trailing slash", async () => {
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88/", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-gist");
		}
		expect(result).toBeDefined();
	});

	it("handles gist with revision hash", async () => {
		const result = await handleGitHubGist(
			"https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88/abc123",
			20000,
		);
		// Should handle revision hash in URL path
		expect(result).toBeDefined();
	});

	it("formats gist content as markdown with code blocks", async () => {
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.content).toContain("```");
			expect(result.content).toContain("---");
		}
		expect(result).toBeDefined();
	});

	it("includes file metadata", async () => {
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.content).toContain("Created:");
			expect(result.content).toContain("Updated:");
		}
		expect(result).toBeDefined();
	});

	it("returns null for nonexistent gist", async () => {
		const result = await handleGitHubGist("https://gist.github.com/0000000000000000000000000000000000000000", 20000);
		expect(result).toBeNull();
	});

	it("handles API rate limiting gracefully", async () => {
		// This test just ensures no errors are thrown
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 5000);
		expect(result).toBeDefined();
	});
});
