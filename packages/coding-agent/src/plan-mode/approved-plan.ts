import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../internal-urls";
import { normalizeLocalScheme } from "../tools/path-utils";

interface RenameApprovedPlanFileOptions {
	planFilePath: string;
	finalPlanFilePath: string;
	getArtifactsDir: () => string | null;
	getSessionId: () => string | null;
}

function assertLocalUrl(path: string, label: "source" | "destination"): void {
	if (!path.startsWith("local:/") && !path.startsWith("local://")) {
		throw new Error(`Approved plan ${label} path must use local: scheme with / or // (received ${path}).`);
	}
}

export async function renameApprovedPlanFile(options: RenameApprovedPlanFileOptions): Promise<void> {
	const { planFilePath, finalPlanFilePath, getArtifactsDir, getSessionId } = options;
	assertLocalUrl(planFilePath, "source");
	assertLocalUrl(finalPlanFilePath, "destination");

	const resolveOptions = {
		getArtifactsDir: () => getArtifactsDir(),
		getSessionId: () => getSessionId(),
	};
	const resolvedSource = resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), resolveOptions);
	const resolvedDestination = resolveLocalUrlToPath(normalizeLocalScheme(finalPlanFilePath), resolveOptions);

	if (resolvedSource === resolvedDestination) {
		return;
	}

	try {
		const destinationStat = await fs.stat(resolvedDestination);
		if (destinationStat.isFile()) {
			throw new Error(
				`Plan destination already exists at ${finalPlanFilePath}. Choose a different title and call exit_plan_mode again.`,
			);
		}
		throw new Error(`Plan destination exists but is not a file: ${finalPlanFilePath}`);
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}

	try {
		await fs.rename(resolvedSource, resolvedDestination);
	} catch (error) {
		throw new Error(
			`Failed to rename approved plan from ${planFilePath} to ${finalPlanFilePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
