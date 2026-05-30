import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { dataDir as configuredDataDir, dbPath as configuredDbPath, type Env } from "../config";
import { closeQuietly, openDatabase } from "../db";

type SerializableDatabase = Database & { serialize(): Uint8Array };
const SQLITE_HEADER = new Uint8Array([83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0]);

export interface RecoveryPaths {
	readonly dataDir: string;
	readonly backupDir: string;
	readonly dbPath: string;
}

export interface BackupMetadata {
	readonly timestamp: string;
	readonly original_size: number;
	readonly backup_size: number;
	readonly db_checksum: string;
	readonly backup_checksum: string;
	readonly compressed: true;
}

export interface BackupResult extends BackupMetadata {
	readonly backup_path: string;
	readonly metadata_path: string;
}

export interface RestoreResult {
	readonly restored: true;
	readonly backup_used: string;
	readonly database_path: string;
	readonly integrity_check: boolean;
}

export interface EmergencyRestoreResult {
	readonly restored: true;
	readonly backup_used: string;
	readonly attempts: number;
}

export interface BackupInfo {
	readonly file: string;
	readonly name: string;
	readonly size: number;
	readonly modified: string;
	readonly metadata?: BackupMetadata;
}

export interface RotateBackupsResult {
	readonly total_backups: number;
	readonly kept: number;
	readonly deleted: number;
	readonly deleted_files: string[];
}

export interface HealthCheckResult {
	readonly database: {
		readonly exists: boolean;
		readonly valid: boolean;
		readonly path: string;
		readonly message: string;
	};
	readonly backups: {
		readonly total: number;
		readonly latest: string | null;
		readonly directory: string;
	};
	readonly status: "healthy" | "unhealthy";
}

function timestampForBackup(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sha256Hex16(bytes: NodeJS.ArrayBufferView): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function defaultBackupDir(env: Env = process.env): string {
	const explicit = env.MNEMOSYNE_BACKUP_DIR;
	if (explicit !== undefined && explicit.length > 0) return explicit;
	const dir = configuredDataDir(env);
	return join(dirname(dir), "backups");
}

export function getDefaultPaths(env: Env = process.env): RecoveryPaths {
	return {
		dataDir: configuredDataDir(env),
		backupDir: defaultBackupDir(env),
		dbPath: configuredDbPath(env),
	};
}

export const get_default_paths = getDefaultPaths;

export function createBackup(dbPath?: string | null, backupDir?: string | null): BackupResult {
	const paths = getDefaultPaths();
	const sourcePath = dbPath ?? paths.dbPath;
	const destinationDir = backupDir ?? paths.backupDir;

	if (!existsSync(sourcePath)) throw new FileNotFoundError(`Database not found: ${sourcePath}`);

	mkdirSync(destinationDir, { recursive: true });
	const timestamp = timestampForBackup();
	const backupPath = join(destinationDir, `mnemosyne_backup_${timestamp}.db.gz`);

	let sourceDb: Database | null = null;
	try {
		sourceDb = openDatabase(sourcePath, { create: false, readwrite: false, pragmas: false });
		const snapshot = (sourceDb as SerializableDatabase).serialize();
		writeFileSync(backupPath, gzipSync(snapshot));
	} finally {
		closeQuietly(sourceDb);
	}

	const dbBytes = readFileSync(sourcePath);
	const backupBytes = readFileSync(backupPath);
	const metadata: BackupMetadata = {
		timestamp,
		original_size: statSync(sourcePath).size,
		backup_size: statSync(backupPath).size,
		db_checksum: sha256Hex16(dbBytes),
		backup_checksum: sha256Hex16(backupBytes),
		compressed: true,
	};
	const metadataPath = `${backupPath.slice(0, -3)}.gz.json`;
	writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

	return { backup_path: backupPath, metadata_path: metadataPath, ...metadata };
}

export const create_backup = createBackup;

function isSqliteFile(bytes: Uint8Array): boolean {
	if (bytes.length < SQLITE_HEADER.length) return false;
	for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
		if (bytes[i] !== SQLITE_HEADER[i]) return false;
	}
	return true;
}

function replaceWithGzippedSqlDump(sql: string, targetPath: string, tempPath: string): void {
	let db: Database | null = null;
	try {
		db = new Database(tempPath, { create: true, readwrite: true, strict: true });
		db.exec(sql);
	} finally {
		closeQuietly(db);
	}
	renameSync(tempPath, targetPath);
}

function removeSqliteSidecars(dbPath: string): void {
	rmSync(`${dbPath}-wal`, { force: true });
	rmSync(`${dbPath}-shm`, { force: true });
	rmSync(`${dbPath}-journal`, { force: true });
}

function emergencyBackupPath(targetPath: string): string {
	const ext = extname(targetPath);
	if (ext.length === 0) return `${targetPath}.emergency_backup.db`;
	return `${targetPath.slice(0, -ext.length)}.emergency_backup.db`;
}

export function restoreBackup(backupPath: string, dbPath?: string | null): RestoreResult {
	const targetPath = dbPath ?? getDefaultPaths().dbPath;
	if (!existsSync(backupPath)) throw new FileNotFoundError(`Backup not found: ${backupPath}`);

	mkdirSync(dirname(targetPath), { recursive: true });
	if (existsSync(targetPath)) copyFileSync(targetPath, emergencyBackupPath(targetPath));

	const uncompressed = gunzipSync(readFileSync(backupPath));
	const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.restore.tmp`);
	try {
		removeSqliteSidecars(targetPath);
		if (isSqliteFile(uncompressed)) {
			writeFileSync(tempPath, uncompressed);
			renameSync(tempPath, targetPath);
		} else {
			replaceWithGzippedSqlDump(uncompressed.toString("utf8"), targetPath, tempPath);
		}
		removeSqliteSidecars(targetPath);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Preserve the restore failure.
		}
		throw error;
	}

	return {
		restored: true,
		backup_used: backupPath,
		database_path: targetPath,
		integrity_check: verifyIntegrity(targetPath),
	};
}

export const restore_backup = restoreBackup;

export function emergencyRestore(backupDir?: string | null, dbPath?: string | null): EmergencyRestoreResult {
	const paths = getDefaultPaths();
	const dir = backupDir ?? paths.backupDir;
	const targetPath = dbPath ?? paths.dbPath;
	const backups = existsSync(dir)
		? readdirSync(dir)
				.filter(name => /^mnemosyne_backup_.*\.db\.gz$/.test(name))
				.sort()
				.reverse()
				.map(name => join(dir, name))
		: [];

	if (backups.length === 0) throw new FileNotFoundError(`No backups found in ${dir}`);

	let attempts = 0;
	for (const backup of backups) {
		attempts += 1;
		try {
			const result = restoreBackup(backup, targetPath);
			if (result.integrity_check) return { restored: true, backup_used: backup, attempts };
		} catch {
			// Try the next backup, matching the Python recovery behavior.
		}
	}
	throw new Error("All backups failed integrity check");
}

export const emergency_restore = emergencyRestore;

export function verifyIntegrity(dbPath?: string | null): boolean {
	const targetPath = dbPath ?? getDefaultPaths().dbPath;
	if (!existsSync(targetPath)) return false;

	let db: Database | null = null;
	try {
		db = openDatabase(targetPath, { create: false, readwrite: false, pragmas: false });
		const row = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
		return row?.integrity_check === "ok";
	} catch {
		return false;
	} finally {
		closeQuietly(db);
	}
}

export const verify_integrity = verifyIntegrity;

export function listBackups(backupDir?: string | null): BackupInfo[] {
	const dir = backupDir ?? getDefaultPaths().backupDir;
	if (!existsSync(dir)) return [];

	return readdirSync(dir)
		.filter(name => /^mnemosyne_backup_.*\.db\.gz$/.test(name))
		.sort()
		.reverse()
		.map(name => {
			const file = join(dir, name);
			const stat = statSync(file);
			const metaFile = `${file.slice(0, -3)}.gz.json`;
			const info: BackupInfo = {
				file,
				name,
				size: stat.size,
				modified: stat.mtime.toISOString(),
			};
			if (!existsSync(metaFile)) return info;
			return { ...info, metadata: JSON.parse(readFileSync(metaFile, "utf8")) as BackupMetadata };
		});
}

export const list_backups = listBackups;

export function rotateBackups(backupDir?: string | null, keep = 10): RotateBackupsResult {
	const dir = backupDir ?? getDefaultPaths().backupDir;
	const backups = existsSync(dir)
		? readdirSync(dir)
				.filter(name => /^mnemosyne_backup_.*\.db\.gz$/.test(name))
				.sort()
				.map(name => join(dir, name))
		: [];
	const toDelete = backups.length > keep ? backups.slice(0, backups.length - keep) : [];
	const deletedFiles: string[] = [];
	for (const backup of toDelete) {
		unlinkSync(backup);
		const meta = `${backup.slice(0, -3)}.gz.json`;
		if (existsSync(meta)) unlinkSync(meta);
		deletedFiles.push(basename(backup));
	}
	return {
		total_backups: backups.length,
		kept: keep,
		deleted: deletedFiles.length,
		deleted_files: deletedFiles,
	};
}

export const rotate_backups = rotateBackups;

export function healthCheck(): HealthCheckResult {
	const paths = getDefaultPaths();
	const dbExists = existsSync(paths.dbPath);
	const dbValid = dbExists ? verifyIntegrity(paths.dbPath) : false;
	const backups = listBackups(paths.backupDir)
		.map(backup => backup.file)
		.sort();
	return {
		database: {
			exists: dbExists,
			valid: dbValid,
			path: paths.dbPath,
			message: dbValid ? "Database integrity verified" : "Database missing or corrupt",
		},
		backups: {
			total: backups.length,
			latest: backups.at(-1) ?? null,
			directory: paths.backupDir,
		},
		status: dbValid ? "healthy" : "unhealthy",
	};
}

export const health_check = healthCheck;

export class FileNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileNotFoundError";
	}
}

export function resetRecoveryForTests(): void {
	// Recovery has no module state; exported for test harness symmetry.
}
