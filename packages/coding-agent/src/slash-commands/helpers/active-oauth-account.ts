import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity } from "../../session/auth-storage";

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * True when a single usage-limit column belongs to the given OAuth identity.
 *
 * Single definition of the matching rules for both `/usage` renderers:
 * - `accountId` ↔ report metadata `accountId`/`account_id` or `limit.scope.accountId`
 * - `email`     ↔ report metadata `email`
 * - `projectId` ↔ report metadata `projectId` or `limit.scope.projectId`
 *   (Google-style providers key usage on the GCP project, not an account id)
 */
export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const activeAccountId = normalizeIdentityValue(identity.accountId);
	if (activeAccountId) {
		const reportAccountId = normalizeIdentityValue(metadata.accountId) ?? normalizeIdentityValue(metadata.account_id);
		if (reportAccountId === activeAccountId) return true;
		if (normalizeIdentityValue(limit.scope.accountId) === activeAccountId) return true;
	}
	const activeEmail = normalizeIdentityValue(identity.email);
	if (activeEmail && normalizeIdentityValue(metadata.email) === activeEmail) return true;
	const activeProjectId = normalizeIdentityValue(identity.projectId);
	if (activeProjectId) {
		if (normalizeIdentityValue(metadata.projectId) === activeProjectId) return true;
		if (normalizeIdentityValue(limit.scope.projectId) === activeProjectId) return true;
	}
	return false;
}

/** True when any limit column in `report` belongs to the given OAuth identity. */
export function reportMatchesActiveAccount(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.some(limit => limitMatchesActiveAccount(report, limit, identity));
}
