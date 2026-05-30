import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BankManager,
	bank_exists,
	create_bank,
	delete_bank,
	get_bank,
	list_banks,
	resetBankForTests,
	set_bank,
} from "../src/core/banks";

describe("BankManager", () => {
	it("creates, lists, renames, stats, and deletes isolated bank directories", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemosyne-banks-"));
		try {
			const manager = new BankManager(root);
			const dbPath = manager.create_bank("work");
			expect(existsSync(dbPath)).toBe(true);
			expect(manager.list_banks()).toEqual(["default", "work"]);
			expect(manager.bank_exists("work")).toBe(true);
			expect(manager.get_bank_db_path("default")).toBe(join(root, "mnemosyne.db"));
			expect(manager.get_bank_db_path("work")).toBe(join(root, "banks", "work", "mnemosyne.db"));
			expect(manager.get_bank_stats("work").db_size_bytes).toBeGreaterThanOrEqual(0);
			const renamed = manager.rename_bank("work", "project_a");
			expect(renamed).toBe(join(root, "banks", "project_a", "mnemosyne.db"));
			expect(manager.bank_exists("work")).toBe(false);
			expect(manager.bank_exists("project_a")).toBe(true);
			expect(manager.delete_bank("project_a")).toBe(true);
			expect(manager.delete_bank("missing")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates names and protects default deletion", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemosyne-banks-"));
		try {
			const manager = new BankManager(root);
			expect(() => manager.create_bank("bank with spaces")).toThrow();
			expect(() => manager.create_bank("bank/with/slashes")).toThrow();
			expect(() => manager.create_bank("bank.with.dots")).toThrow();
			expect(() => manager.delete_bank("default")).toThrow();
			expect(manager.delete_bank("default", true)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("module-level helpers operate on the requested data dir", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemosyne-banks-"));
		try {
			const dbPath = create_bank("mod_test", root);
			expect(existsSync(dbPath)).toBe(true);
			expect(bank_exists("mod_test", root)).toBe(true);
			expect(list_banks(root)).toContain("mod_test");
			expect(delete_bank("mod_test", root)).toBe(true);
			expect(bank_exists("mod_test", root)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("switches the process default bank", () => {
		resetBankForTests();
		expect(get_bank()).toBe("default");
		set_bank("work");
		expect(get_bank()).toBe("work");
		resetBankForTests();
	});
});
