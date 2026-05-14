import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveLocalUrlToPath } from "../internal-urls";
import { normalizeLocalScheme } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";

/** Shape forwarded from the plan-mode resolve handler to InteractiveMode's
 *  approval popup. Populated by the standing handler that the resolve tool
 *  dispatches to when the agent submits `resolve { action: "apply" }`. */
export interface PlanApprovalDetails {
	planFilePath: string;
	finalPlanFilePath: string;
	title: string;
	planExists: boolean;
}

/** Validate the agent-supplied plan title and derive the destination filename.
 *  Filename uses the title with a `.md` suffix; characters are restricted to
 *  letters, numbers, underscores, and hyphens so the value is safe to splice
 *  into a `local://` URL without escaping. */
export function normalizePlanTitle(title: string): { title: string; fileName: string } {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new ToolError("Plan title is required and must not be empty.");
	}

	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
		throw new ToolError("Plan title must not contain path separators or '..'.");
	}

	const withExtension = trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
	if (!/^[A-Za-z0-9_-]+\.md$/.test(withExtension)) {
		throw new ToolError("Plan title may only contain letters, numbers, underscores, or hyphens.");
	}

	const normalizedTitle = withExtension.slice(0, -3);
	return { title: normalizedTitle, fileName: withExtension };
}

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
				`Plan destination already exists at ${finalPlanFilePath}. Choose a different title and submit the plan for approval again.`,
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
