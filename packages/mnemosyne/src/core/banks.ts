import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir as configuredDataDir } from "../config";
import { closeQuietly, openDatabase } from "../db";

export const DEFAULT_DATA_DIR = join(homedir(), ".hermes", "mnemosyne", "data");
export const BANKS_DIR = join(DEFAULT_DATA_DIR, "banks");
const DB_FILENAME = "mnemosyne.db";

export class ValueError extends Error {
	override name = "ValueError";
}

export interface BankStats {
	readonly name: string;
	readonly exists: boolean;
	readonly db_path: string;
	readonly dbSizeBytes: number;
	readonly db_size_bytes: number;
}

export class BankManager {
	readonly dataDir: string;
	readonly data_dir: string;
	readonly banksDir: string;
	readonly banks_dir: string;

	constructor(dataDir?: string) {
		this.dataDir = dataDir ?? configuredDataDir();
		this.data_dir = this.dataDir;
		this.banksDir = join(this.dataDir, "banks");
		this.banks_dir = this.banksDir;
		mkdirSync(this.banksDir, { recursive: true });
	}

	createBank(name: string): string {
		this.validateName(name);
		const bankDir = join(this.banksDir, name);
		if (existsSync(bankDir)) throw new ValueError(`Bank '${name}' already exists`);
		mkdirSync(bankDir, { recursive: true });
		const dbPath = join(bankDir, DB_FILENAME);
		const db = openDatabase(dbPath);
		closeQuietly(db);
		return dbPath;
	}

	create_bank(name: string): string {
		return this.createBank(name);
	}

	deleteBank(name: string, force = false): boolean {
		if (name === "default" && !force) throw new ValueError("Cannot delete 'default' bank without force=True");
		const bankDir = join(this.banksDir, name);
		if (!existsSync(bankDir)) return false;
		rmSync(bankDir, { recursive: true, force: true });
		return true;
	}

	delete_bank(name: string, force = false): boolean {
		return this.deleteBank(name, force);
	}

	listBanks(): string[] {
		const banks: string[] = ["default"];
		if (existsSync(this.banksDir)) {
			for (const entry of readdirSync(this.banksDir, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name !== "default") banks.push(entry.name);
			}
		}
		return banks.sort();
	}

	list_banks(): string[] {
		return this.listBanks();
	}

	bankExists(name: string): boolean {
		if (name === "default") return true;
		return existsSync(join(this.banksDir, name));
	}

	bank_exists(name: string): boolean {
		return this.bankExists(name);
	}

	getBankDbPath(name: string): string {
		if (name.length === 0 || name === "default") return join(this.dataDir, DB_FILENAME);
		return join(this.banksDir, name, DB_FILENAME);
	}

	get_bank_db_path(name: string): string {
		return this.getBankDbPath(name);
	}

	renameBank(oldName: string, newName: string): string {
		if (oldName === "default") throw new ValueError("Cannot rename 'default' bank");
		this.validateName(newName);
		const oldDir = join(this.banksDir, oldName);
		const newDir = join(this.banksDir, newName);
		if (!existsSync(oldDir)) throw new ValueError(`Bank '${oldName}' does not exist`);
		if (existsSync(newDir)) throw new ValueError(`Bank '${newName}' already exists`);
		renameSync(oldDir, newDir);
		return join(newDir, DB_FILENAME);
	}

	rename_bank(oldName: string, newName: string): string {
		return this.renameBank(oldName, newName);
	}

	getBankStats(name: string): BankStats {
		const dbPath = this.getBankDbPath(name);
		const present = existsSync(dbPath);
		const size = present ? statSync(dbPath).size : 0;
		return { name, exists: present, db_path: dbPath, dbSizeBytes: size, db_size_bytes: size };
	}

	get_bank_stats(name: string): BankStats {
		return this.getBankStats(name);
	}

	private validateName(name: string): void {
		if (name.length === 0) throw new ValueError("Bank name cannot be empty");
		if (name === "default") return;
		if (name.length > 64) throw new ValueError(`Bank name '${name}' exceeds 64 characters`);
		for (let i = 0; i < name.length; i++) {
			const code = name.charCodeAt(i);
			const ok =
				(code >= 48 && code <= 57) ||
				(code >= 65 && code <= 90) ||
				(code >= 97 && code <= 122) ||
				code === 45 ||
				code === 95;
			if (!ok) throw new ValueError(`Invalid bank name '${name}'. Use alphanumeric, hyphens, underscores only.`);
		}
	}
}

let defaultBank = "default";

export function create_bank(name: string, dataDir?: string): string {
	const manager = new BankManager(dataDir);
	return manager.createBank(name);
}

export function createBank(name: string, dataDir?: string): string {
	return create_bank(name, dataDir);
}

export function delete_bank(name: string, dataDir?: string, force = false): boolean {
	const manager = new BankManager(dataDir);
	return manager.deleteBank(name, force);
}

export function deleteBank(name: string, dataDir?: string, force = false): boolean {
	return delete_bank(name, dataDir, force);
}

export function list_banks(dataDir?: string): string[] {
	const manager = new BankManager(dataDir);
	return manager.listBanks();
}

export function listBanks(dataDir?: string): string[] {
	return list_banks(dataDir);
}

export function bank_exists(name: string, dataDir?: string): boolean {
	const manager = new BankManager(dataDir);
	return manager.bankExists(name);
}

export function bankExists(name: string, dataDir?: string): boolean {
	return bank_exists(name, dataDir);
}

export function bankDbPath(name = defaultBank, dataDir?: string): string {
	const manager = new BankManager(dataDir);
	return manager.getBankDbPath(name);
}

export function set_bank(bank: string): void {
	defaultBank = bank;
}

export function setBank(bank: string): void {
	set_bank(bank);
}

export function get_bank(): string {
	return defaultBank;
}

export function getBank(): string {
	return get_bank();
}

export function resetBankForTests(): void {
	defaultBank = "default";
}
