import { describe, expect, it } from "bun:test";
import { rewriteCopilotError } from "../src/utils/http-inspector";

function errorWithStatus(status: number): Error {
	const err = new Error(`${status} Unauthorized`);
	(err as any).status = status;
	return err;
}

describe("rewriteCopilotError", () => {
	it("returns original message for non-copilot providers", () => {
		const err = errorWithStatus(401);
		expect(rewriteCopilotError("some error", err, "openai")).toBe("some error");
	});

	it("returns original message for non-401/403 errors", () => {
		const err = errorWithStatus(500);
		expect(rewriteCopilotError("server error", err, "github-copilot")).toBe("server error");
	});

	it("rewrites message for 401 with github-copilot provider", () => {
		const err = errorWithStatus(401);
		const result = rewriteCopilotError("401 Unauthorized: ...", err, "github-copilot");
		expect(result).toContain("GitHub Copilot authentication failed (HTTP 401)");
		expect(result).toContain("/login github-copilot");
	});

	it("rewrites 403 with access-denied message (not auth-failed, to avoid credential removal)", () => {
		const err = errorWithStatus(403);
		const result = rewriteCopilotError("403 Forbidden", err, "github-copilot");
		expect(result).toContain("GitHub Copilot access denied (HTTP 403)");
		expect(result).not.toContain("GitHub Copilot authentication failed");
		expect(result).not.toContain("/login github-copilot");
	});

	it("rewrites 400 model_not_supported with rollout-gap guidance", () => {
		const err = new Error("400 The requested model is not supported.");
		(err as unknown as { status: number; code: string }).status = 400;
		(err as unknown as { status: number; code: string }).code = "model_not_supported";
		const result = rewriteCopilotError("original", err, "github-copilot");
		expect(result).toContain("HTTP 400 model_not_supported");
		expect(result).toContain("rollout gap");
		expect(result).not.toContain("authentication failed");
	});

	it("leaves non-copilot 400 model_not_supported untouched", () => {
		const err = new Error("400 model_not_supported");
		(err as unknown as { status: number; code: string }).status = 400;
		(err as unknown as { status: number; code: string }).code = "model_not_supported";
		expect(rewriteCopilotError("orig", err, "openai")).toBe("orig");
	});

	it("leaves 400 without model_not_supported code untouched", () => {
		const err = new Error("400 invalid request");
		(err as unknown as { status: number; code: string }).status = 400;
		(err as unknown as { status: number; code: string }).code = "invalid_request_body";
		expect(rewriteCopilotError("orig", err, "github-copilot")).toBe("orig");
	});
});
