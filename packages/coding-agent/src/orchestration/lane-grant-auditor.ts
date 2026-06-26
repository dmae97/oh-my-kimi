import { minimatch } from "minimatch";
import type { LaneGrant, LaneGrantAuditReport, PathConflict } from "../types/lane-grant.ts";

function pathsOverlap(a: string, b: string): boolean {
	const normalizedA = a.replace(/\\/g, "/").replace(/\/$/, "");
	const normalizedB = b.replace(/\\/g, "/").replace(/\/$/, "");
	if (normalizedA === normalizedB) return true;
	if (minimatch(normalizedA, normalizedB) || minimatch(normalizedB, normalizedA)) return true;
	if (normalizedA.startsWith(`${normalizedB}/`) || normalizedB.startsWith(`${normalizedA}/`)) return true;
	return false;
}

function hasOverlap(scopesA: string[], scopesB: string[]): { overlaps: boolean; path: string } {
	for (const a of scopesA) {
		for (const b of scopesB) {
			if (pathsOverlap(a, b)) {
				return { overlaps: true, path: a };
			}
		}
	}
	return { overlaps: false, path: "" };
}

export function auditLaneGrants(grants: LaneGrant[], evidencePath: string): LaneGrantAuditReport {
	const conflicts: PathConflict[] = [];

	for (let i = 0; i < grants.length; i++) {
		for (let j = i + 1; j < grants.length; j++) {
			const a = grants[i];
			const b = grants[j];

			// Only writers can conflict with each other.
			if (a.authority !== "write-scoped" || b.authority !== "write-scoped") continue;

			const writeA = a.allowedPaths;
			const writeB = b.allowedPaths;
			const overlap = hasOverlap(writeA, writeB);

			if (overlap.overlaps) {
				conflicts.push({
					lanes: [a.laneId, b.laneId],
					overlappingPath: overlap.path,
					severity: "merge-blocked",
					suggestion: `Serialize lanes ${a.laneId} and ${b.laneId}, or split write scopes so they do not overlap at ${overlap.path}.`,
				});
			}
		}

		// Any grant writing to a blocked path is a merge-blocker.
		const grant = grants[i];
		for (const allowed of grant.allowedPaths) {
			for (const blocked of grant.blockedPaths) {
				if (pathsOverlap(allowed, blocked)) {
					conflicts.push({
						lanes: [grant.laneId, grant.laneId],
						overlappingPath: blocked,
						severity: "merge-blocked",
						suggestion: `Remove ${blocked} from allowedPaths or add an exception; it overlaps blockedPaths in ${grant.laneId}.`,
					});
				}
			}
		}
	}

	return {
		grants,
		conflicts,
		mergeBlocked: conflicts.some((c) => c.severity === "merge-blocked"),
		evidencePath,
	};
}

export function formatAuditReport(report: LaneGrantAuditReport): string {
	const lines: string[] = [
		`# Lane Grant Audit Report`,
		"",
		`- Lanes audited: ${report.grants.length}`,
		`- Conflicts detected: ${report.conflicts.length}`,
		`- Merge blocked: ${report.mergeBlocked ? "YES" : "NO"}`,
		"",
	];

	if (report.conflicts.length === 0) {
		lines.push("No path conflicts detected.");
	} else {
		lines.push("## Conflicts");
		for (const conflict of report.conflicts) {
			lines.push(
				`- **${conflict.severity.toUpperCase()}** \`${conflict.lanes.join(" ↔ ")}\` at \`${conflict.overlappingPath}\``,
			);
			lines.push(`  - Suggestion: ${conflict.suggestion}`);
		}
	}

	return lines.join("\n");
}
