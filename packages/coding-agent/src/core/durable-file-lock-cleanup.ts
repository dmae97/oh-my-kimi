import { randomUUID } from "node:crypto";
import { renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { fsyncDirectorySync } from "./durable-file-io.ts";

/** Mutable progress is retained by the owning lock so failed cleanup can be retried. */
export interface DurableFileLockRetirement {
	retiredPath: string | undefined;
	retirementSynced: boolean;
	ownerRemoved: boolean;
	directoryRemoved: boolean;
	cleanupSynced: boolean;
}

export function createDurableFileLockRetirement(): DurableFileLockRetirement {
	return {
		retiredPath: undefined,
		retirementSynced: false,
		ownerRemoved: false,
		directoryRemoved: false,
		cleanupSynced: false,
	};
}

/** Atomically retire an active lock and durably clean its private artifact. */
export function retireDurableFileLockSync(lockPath: string, retirement: DurableFileLockRetirement): void {
	if (retirement.retiredPath === undefined) {
		const retiredPath = `${lockPath}.release-${randomUUID()}`;
		renameSync(lockPath, retiredPath);
		retirement.retiredPath = retiredPath;
	}
	if (!retirement.retirementSynced) {
		fsyncDirectorySync(dirname(lockPath));
		retirement.retirementSynced = true;
	}
	const retiredPath = retirement.retiredPath;
	if (!retirement.ownerRemoved) {
		unlinkSync(`${retiredPath}/owner.json`);
		retirement.ownerRemoved = true;
	}
	if (!retirement.directoryRemoved) {
		rmdirSync(retiredPath);
		retirement.directoryRemoved = true;
	}
	if (!retirement.cleanupSynced) {
		fsyncDirectorySync(dirname(lockPath));
		retirement.cleanupSynced = true;
	}
}
