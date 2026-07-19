import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fsyncDirectory, writeAll } from "./replay-ledger-lock.ts";

export function quarantineReplayLedgerSuffix(ledgerPath: string, suffix: Buffer, beforeFsync?: () => void): string {
	const artifactPath = `${ledgerPath}.quarantine.${randomUUID()}`;
	const fd = openSync(artifactPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
	try {
		writeAll(fd, suffix);
		beforeFsync?.();
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(dirname(ledgerPath));
	return artifactPath;
}
