import * as fs from "node:fs";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
}

export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const { tempDir, tempHomeDir, originalHome } = getState();
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		if (tempHomeDir) {
			fs.rmSync(tempHomeDir, { recursive: true, force: true });
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
	};
}
