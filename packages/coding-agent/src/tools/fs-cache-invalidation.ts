import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";

/**
 * Invalidate shared filesystem scan caches after a content write/update.
 */
export function invalidateFsScanAfterWrite(path: string): void {
	invalidateFsScanCache(path);
}

/**
 * Invalidate shared filesystem scan caches after deleting a file.
 */
export function invalidateFsScanAfterDelete(path: string): void {
	invalidateFsScanCache(path);
}

/**
 * Invalidate shared filesystem scan caches after a rename/move.
 *
 * Both source and destination paths must be invalidated because cached roots can
 * include either side of the move.
 */
export function invalidateFsScanAfterRename(oldPath: string, newPath: string): void {
	invalidateFsScanCache(oldPath);
	if (newPath !== oldPath) {
		invalidateFsScanCache(newPath);
	}
}
