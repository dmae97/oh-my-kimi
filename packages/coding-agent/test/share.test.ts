import { describe, expect, test } from "bun:test";
import type { SessionData } from "../src/export/html";
import { buildShareSnapshot, normalizeShareServerUrl, SERVER_MAX_SEALED_BYTES, sealToFit } from "../src/export/share";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import type { SessionEntry, SessionManager } from "../src/session/session-manager";

const IV_LENGTH = 12;

async function makeKey(): Promise<CryptoKey> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Mirror of share-loader.js: AES-GCM open + gunzip + parse. */
async function open(key: CryptoKey, sealed: Uint8Array<ArrayBuffer>): Promise<SessionData> {
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: sealed.subarray(0, IV_LENGTH) },
		key,
		sealed.subarray(IV_LENGTH),
	);
	return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(plain))));
}

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-06-12T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

function sessionData(entries: SessionEntry[], leafId: string): SessionData {
	return {
		header: { type: "session", version: 3, id: "t", timestamp: "2026-06-12T00:00:00.000Z", cwd: "/tmp" },
		entries,
		leafId,
	};
}

/** Incompressible filler so gzip cannot absorb the payload. */
function randomHex(words: number): string {
	return Array.from(crypto.getRandomValues(new Uint32Array(words)), v => v.toString(16)).join("");
}

describe("sealToFit", () => {
	test("round-trips losslessly when under budget", async () => {
		const key = await makeKey();
		const data = sessionData([messageEntry("e1", null, "hello"), messageEntry("e2", "e1", "world")], "e2");

		const { sealed, truncated } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(false);
		expect(await open(key, sealed)).toEqual(data);
	});

	test("trims oversized text into budget without dropping entries", async () => {
		const key = await makeKey();
		const data = sessionData(
			[messageEntry("e1", null, "keep me"), messageEntry("e2", "e1", randomHex(1_500_000))],
			"e2",
		);

		const { sealed, truncated } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		expect(sealed.byteLength).toBeLessThanOrEqual(SERVER_MAX_SEALED_BYTES);
		const opened = await open(key, sealed);
		expect(opened.entries).toHaveLength(2);
		expect(opened.leafId).toBe("e2");
		expect(JSON.stringify(opened)).toContain("keep me");
		expect(JSON.stringify(opened)).toContain("…[truncated for share]");
	});

	test("replaces large inline images with placeholders before trimming text", async () => {
		const key = await makeKey();
		const imageEntry = {
			type: "message",
			id: "img",
			parentId: null,
			timestamp: "2026-06-12T00:00:00.000Z",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "see screenshot" },
					{ type: "image", data: randomHex(800_000), mimeType: "image/png" },
				],
			},
		} as unknown as SessionEntry;
		const data = sessionData([imageEntry], "img");

		const { sealed, truncated } = await sealToFit(key, data, SERVER_MAX_SEALED_BYTES);

		expect(truncated).toBe(true);
		const flat = JSON.stringify(await open(key, sealed));
		expect(flat).toContain("[image omitted from share]");
		expect(flat).toContain("see screenshot");
	});
});

describe("buildShareSnapshot", () => {
	test("redacts secrets through the obfuscator and leaves the original untouched", () => {
		const entries = [messageEntry("e1", null, "the token is hunter2-XYZZY, keep safe")];
		const sm = {
			getHeader: () => sessionData([], "x").header,
			getEntries: () => entries,
			getLeafId: () => "e1",
		} as unknown as SessionManager;
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "hunter2-XYZZY" }]);

		const snapshot = buildShareSnapshot(sm, { obfuscator });

		expect(JSON.stringify(snapshot)).not.toContain("hunter2-XYZZY");
		expect(JSON.stringify(snapshot)).toContain("the token is");
		// Source entries must keep the real value; redaction is share-only.
		expect(JSON.stringify(entries)).toContain("hunter2-XYZZY");

		const plain = buildShareSnapshot(sm, {});
		expect(JSON.stringify(plain)).toContain("hunter2-XYZZY");
	});
});

describe("normalizeShareServerUrl", () => {
	test("strips trailing slashes and falls back to the default", () => {
		expect(normalizeShareServerUrl("https://my.omp.sh/s/")).toBe("https://my.omp.sh/s");
		expect(normalizeShareServerUrl("https://example.com/s///")).toBe("https://example.com/s");
		expect(normalizeShareServerUrl(undefined)).toBe("https://my.omp.sh/s");
		expect(normalizeShareServerUrl("   ")).toBe("https://my.omp.sh/s");
	});
});
