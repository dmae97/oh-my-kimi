import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	domTextEvidence,
	hashFileWithinRoot,
	redactSecrets,
	redactSecretsWithCount,
	screenshotEvidence,
} from "../examples/extensions/aside-computer-use/evidence.ts";

describe("redactSecrets", () => {
	it("redacts embedded bearer, token, password, api_key, card, and cvv strings", () => {
		const out = redactSecrets(
			[
				"Authorization: Bearer SYNTHETIC_BEARER_TOKEN_123456",
				"redirect=https://example.test/callback?token=SYNTHETIC_TOKEN_123456&ok=1",
				"access_token=SYNTHETIC_ACCESS_TOKEN_123456",
				"api_key=SYNTHETIC_API_KEY_123456", // gitleaks:allow -- intentional fake credential fixture
				"password=synthetic-password-value",
				"card=4242 4242 4242 4242",
				"cvv=123",
			].join("\n"),
		);

		expect(out).toContain("Authorization: Bearer [REDACTED]");
		expect(out).toContain("token=[REDACTED]");
		expect(out).toContain("access_token=[REDACTED]");
		expect(out).toContain("api_key=[REDACTED]");
		expect(out).toContain("password=[REDACTED]");
		expect(out).toContain("card=[REDACTED]");
		expect(out).toContain("cvv=[REDACTED]");
	});

	it("reports redaction counts without changing redactSecrets compatibility", () => {
		const out = redactSecretsWithCount({ message: "token=SYNTHETIC_TOKEN_123456 password=synthetic" });
		expect(out).toEqual({
			value: { message: "token=[REDACTED] password=[REDACTED]" },
			redactionCount: 2,
		});
	});

	it("redacts values under secret-named keys", () => {
		const out = redactSecrets({ user: "alice", password: "hunter2", token: "abc" });
		expect(out).toEqual({ user: "alice", password: "[REDACTED]", token: "[REDACTED]" });
	});

	it("redacts token-like standalone values even without secret key", () => {
		const out = redactSecrets({ query: "FAKE_STRIPE_KEY_FOR_TESTING" });
		expect((out as { query: string }).query).toBe("[REDACTED]");
	});

	it("leaves ordinary short strings untouched", () => {
		const out = redactSecrets({ title: "PR #123 CI failed", step: "build" });
		expect(out).toEqual({ title: "PR #123 CI failed", step: "build" });
	});

	it("walks nested objects and arrays", () => {
		const out = redactSecrets({
			meta: { api_key: "xxx", count: 3 },
			items: [{ name: "ok", secret: "shh" }],
		});
		expect(out).toEqual({
			meta: { api_key: "[REDACTED]", count: 3 },
			items: [{ name: "ok", secret: "[REDACTED]" }],
		});
	});

	it("does not mutate the input", () => {
		const input = { message: "password=synthetic-password-value", password: "hunter2" };
		const out = redactSecrets(input);
		expect(input).toEqual({ message: "password=synthetic-password-value", password: "hunter2" });
		expect(out).toEqual({ message: "password=[REDACTED]", password: "[REDACTED]" });
	});

	it("redacts common credential key variants", () => {
		const out = redactSecrets({
			Authorization: "Bearer x",
			clientSecret: "s",
			access_token: "t",
			cardNumber: "4111",
			cvv: "123",
		});
		expect(Object.values(out).every((v) => v === "[REDACTED]")).toBe(true);
	});
});

describe("evidence builders", () => {
	it("domTextEvidence carries value and source", () => {
		const e = domTextEvidence("Run npm run check", "github-actions");
		expect(e).toEqual({ type: "dom_text", value: "Run npm run check", source: "github-actions" });
	});

	it("domTextEvidence redacts DOM text automatically", () => {
		const e = domTextEvidence(
			"Authorization: Bearer SYNTHETIC_BEARER_TOKEN_123456 token=SYNTHETIC_TOKEN_123456",
			"page",
		);
		expect(e).toEqual({
			type: "dom_text",
			value: "Authorization: Bearer [REDACTED] token=[REDACTED]",
			source: "page",
			redactionCount: 2,
		});
	});
	it("screenshotEvidence carries path and optional hash", () => {
		expect(screenshotEvidence("/artifacts/a.png", "deadbeef")).toEqual({
			type: "screenshot",
			path: "/artifacts/a.png",
			sha256: "deadbeef",
		});
	});
});

describe("hashFileWithinRoot", () => {
	it("hashes an in-root file", async () => {
		const root = await mkdtemp(join(tmpdir(), "aside-redaction-root-"));
		try {
			await writeFile(join(root, "README.md"), "synthetic evidence fixture\n");
			const hash = await hashFileWithinRoot("README.md", root);
			expect(hash).toBe(createHash("sha256").update("synthetic evidence fixture\n").digest("hex"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a file outside the root", async () => {
		const parent = await mkdtemp(join(tmpdir(), "aside-redaction-parent-"));
		const root = join(parent, "root");
		const outside = join(parent, "outside.txt");
		try {
			await mkdir(root);
			await writeFile(outside, "outside\n");
			await expect(hashFileWithinRoot(outside, root)).rejects.toThrow(/outside root/);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("rejects a symlink escape when symlinks are supported", async () => {
		const parent = await mkdtemp(join(tmpdir(), "aside-redaction-symlink-"));
		const root = join(parent, "root");
		const outside = join(parent, "outside.txt");
		const link = join(root, "linked-outside.txt");
		try {
			await mkdir(root);
			await writeFile(outside, "outside\n");
			try {
				await symlink(outside, link);
			} catch (error) {
				const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (["EPERM", "EACCES", "ENOSYS"].includes(code)) return;
				throw error;
			}
			await expect(hashFileWithinRoot(link, root)).rejects.toThrow(/outside root/);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
});
