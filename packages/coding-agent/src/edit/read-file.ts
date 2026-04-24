/**
 * Shared file-read helper for edit-mode utilities.
 *
 * Reads a file via Bun and rethrows ENOENT as a user-facing "File not found"
 * error referencing the display path.
 */
import { isEnoent } from "@oh-my-pi/pi-utils";

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		return await Bun.file(absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}
