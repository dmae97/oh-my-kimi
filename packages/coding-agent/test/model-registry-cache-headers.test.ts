import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("startup model cache header restoration (#5780)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-cache-headers-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	test("cached standard-provider models regain bundled static headers on registry startup", () => {
		const dbPath = path.join(tempDir, "models.db");
		const bundled = getBundledModels("github-copilot");
		const withHeaders = bundled.filter(model => model.headers && Object.keys(model.headers).length > 0);
		expect(withHeaders.length).toBeGreaterThan(0);

		// Prior process: cache the live copilot catalog. v10 never persists headers.
		writeModelCache("github-copilot", Date.now(), bundled, true, "fp-test", dbPath, bundled);
		const raw = fs.readFileSync(dbPath).toString("latin1");
		for (const model of withHeaders) {
			for (const value of Object.values(model.headers ?? {})) {
				expect(raw.includes(value)).toBe(false);
			}
		}

		// Next process start: the registry's startup cache loader must restore the
		// bundled static headers instead of serving header-less cached models.
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), {
			fetch: () => Promise.reject(new Error("offline")),
		});
		for (const model of withHeaders) {
			const live = registry.find("github-copilot", model.id);
			if (!live) continue;
			expect(live.headers).toEqual(model.headers);
		}
	});
});
