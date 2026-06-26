import type {
	LoopDefinition,
	LoopRunOutcome,
	LoopState,
	LoopValidationDiagnostic,
	LoopWorkItem,
} from "./loop-types.ts";

export type LoopGateAction = "allow" | "block" | "human-gate" | "escalate";

export type LoopVerifierStatus = "pass" | "fail" | "blocked";

export interface LoopVerifierEvidence {
	readonly independent: boolean;
	readonly status?: LoopVerifierStatus;
	readonly evidenceRefs?: readonly string[];
	readonly verifierId?: string;
	readonly implementerId?: string;
}

export interface LoopHumanGateEvidence {
	readonly approved: boolean;
	readonly approvalRef?: string;
}

export interface LoopWorktreeEvidence {
	readonly isolated: boolean;
	readonly worktreeId?: string;
	readonly branch?: string;
	readonly cleanCheckout?: boolean;
}

export interface LoopDurableStateEvidence {
	readonly stateRevision?: string;
	readonly runLogRef?: string;
	readonly budgetReservationId?: string;
}

export interface LoopGateEvidence {
	readonly writeScope?: readonly string[];
	readonly changedFiles?: readonly string[];
	readonly evidenceRefs?: readonly string[];
	readonly verifier?: LoopVerifierEvidence;
	readonly humanGate?: LoopHumanGateEvidence;
	readonly worktree?: LoopWorktreeEvidence;
	readonly durableState?: LoopDurableStateEvidence;
}

export interface LoopSafetyGateResult {
	readonly passed: boolean;
	readonly action: LoopGateAction;
	readonly outcome?: LoopRunOutcome;
	readonly diagnostics: readonly LoopValidationDiagnostic[];
}

export interface LoopWriteScopeValidationResult {
	readonly passed: boolean;
	readonly diagnostics: readonly LoopValidationDiagnostic[];
}

const TOKEN_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"for",
	"in",
	"inside",
	"is",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
]);

export function evaluateLoopSafetyGates(
	definition: LoopDefinition,
	state: LoopState,
	item: LoopWorkItem,
	evidence: LoopGateEvidence,
): LoopSafetyGateResult {
	const diagnostics: LoopValidationDiagnostic[] = [];

	if (state.killSwitch) {
		diagnostics.push({ code: "loop-kill-switch", message: "Loop kill switch is active." });
	}
	if (state.status === "paused" || state.status === "retired") {
		diagnostics.push({ code: "loop-not-active", message: `Loop status ${state.status} cannot take action.` });
	}

	if (item.attemptCount >= definition.budget.maxAttemptsPerItem) {
		diagnostics.push({
			code: "max-attempts-exceeded",
			message: `Item ${item.id} reached maxAttemptsPerItem=${definition.budget.maxAttemptsPerItem}.`,
		});
	}

	if (!evidence.writeScope) {
		diagnostics.push({ code: "write-scope-missing", message: "Exact writeScope evidence is required." });
	} else {
		diagnostics.push(...validateLoopWriteScope(definition, evidence.writeScope).diagnostics);
		diagnostics.push(...validateRequestedWriteScopeDoesNotOverlapDenied(definition, evidence.writeScope));
	}

	if (evidence.writeScope && evidence.changedFiles) {
		diagnostics.push(...validateChangedFilesWithinRequestedScope(evidence.writeScope, evidence.changedFiles));
	}

	if (requiresWorktreeIsolation(definition)) {
		diagnostics.push(...validateWorktreeEvidence(definition, evidence.worktree));
	}

	if (definition.durableState?.requireReplayableEvidence === true) {
		diagnostics.push(...validateDurableStateEvidence(evidence.durableState));
	}

	if (requiresHumanApproval(definition, item)) {
		const approvalRef = evidence.humanGate?.approvalRef?.trim();
		const approvalRefSatisfied = definition.humanGates?.approvalRefsRequired === false || Boolean(approvalRef);
		if (evidence.humanGate?.approved !== true || !approvalRefSatisfied) {
			diagnostics.push({
				code: "human-gate-required",
				message: "High-risk work item requires human approval evidence.",
			});
		}
	}

	if (!hasEvidenceRefs(evidence.evidenceRefs)) {
		diagnostics.push({ code: "evidence-refs-missing", message: "Completion evidenceRefs are required." });
	}

	if (requiresIndependentVerifier(definition)) {
		diagnostics.push(...validateIndependentVerifier(evidence.verifier));
	}

	return safetyGateResult(diagnostics);
}

export function calculateLoopDriftScore(definition: LoopDefinition, item: LoopWorkItem): number {
	const itemTokens = tokenize([item.title, item.sourceRef, item.actingOn].join(" "));
	const objectiveTokens = tokenize(definition.objective);
	const objectiveOverlap = overlapRatio(itemTokens, objectiveTokens);
	const nonGoalOverlap = Math.max(
		0,
		...definition.nonGoals.map((nonGoal) => overlapRatio(itemTokens, tokenize(nonGoal))),
	);
	const scopeMatched = matchesWatchedScope(definition, item);

	let score = 0.45;
	score -= objectiveOverlap * 0.25;
	score += objectiveOverlap === 0 ? 0.2 : 0;
	score += scopeMatched ? -0.2 : 0.2;
	score += nonGoalOverlap * 0.7;

	return clamp01(score);
}

export function validateLoopWriteScope(
	definition: LoopDefinition,
	paths: readonly string[],
): LoopWriteScopeValidationResult {
	const diagnostics: LoopValidationDiagnostic[] = [];

	if (paths.length === 0 && (definition.level === "L2" || definition.level === "L3")) {
		diagnostics.push({
			code: "write-scope-empty",
			message: `${definition.level} loops require explicit write paths.`,
		});
	}

	if (definition.safety.maxWriteScopeCount !== undefined && paths.length > definition.safety.maxWriteScopeCount) {
		diagnostics.push({
			code: "write-scope-count-exceeded",
			message: `Write scope count ${paths.length} exceeds maxWriteScopeCount=${definition.safety.maxWriteScopeCount}.`,
		});
	}

	for (const path of paths) {
		const normalizedPath = normalizePath(path);
		if (!normalizedPath) {
			diagnostics.push({ code: "write-scope-empty-path", message: "Write scope contains an empty path." });
			continue;
		}
		if (!matchesAnyScope(normalizedPath, definition.safety.allowedWriteScopes)) {
			diagnostics.push({
				code: "write-scope-outside-allowed",
				message: `Path ${normalizedPath} is outside allowedWriteScopes.`,
				path: normalizedPath,
			});
		}
		if (matchesAnyScope(normalizedPath, definition.safety.deniedWriteScopes ?? [])) {
			diagnostics.push({
				code: "write-scope-denied",
				message: `Path ${normalizedPath} is inside deniedWriteScopes.`,
				path: normalizedPath,
			});
		}
	}

	return { passed: diagnostics.length === 0, diagnostics };
}

function safetyGateResult(diagnostics: readonly LoopValidationDiagnostic[]): LoopSafetyGateResult {
	if (diagnostics.length === 0) {
		return { passed: true, action: "allow", diagnostics: [] };
	}

	if (hasDiagnostic(diagnostics, "loop-kill-switch")) {
		return { passed: false, action: "block", outcome: "killed", diagnostics };
	}
	if (hasDiagnostic(diagnostics, "max-attempts-exceeded")) {
		return { passed: false, action: "escalate", outcome: "escalated", diagnostics };
	}
	if (hasDiagnostic(diagnostics, "human-gate-required")) {
		return { passed: false, action: "human-gate", outcome: "escalated", diagnostics };
	}
	return { passed: false, action: "block", outcome: "verifier-failed", diagnostics };
}

function hasDiagnostic(diagnostics: readonly LoopValidationDiagnostic[], code: string): boolean {
	return diagnostics.some((diagnostic) => diagnostic.code === code);
}

function requiresIndependentVerifier(definition: LoopDefinition): boolean {
	return definition.level === "L2" || definition.level === "L3" || definition.safety.requireIndependentVerifier;
}

function validateIndependentVerifier(verifier: LoopVerifierEvidence | undefined): LoopValidationDiagnostic[] {
	if (!verifier) {
		return [{ code: "independent-verifier-required", message: "L2/L3 actions require an independent verifier." }];
	}

	const diagnostics: LoopValidationDiagnostic[] = [];
	const sameActor = Boolean(
		verifier.verifierId && verifier.implementerId && verifier.verifierId.trim() === verifier.implementerId.trim(),
	);
	if (!verifier.independent || sameActor) {
		diagnostics.push({ code: "independent-verifier-required", message: "Verifier must be independent." });
	}
	if (verifier.status && verifier.status !== "pass") {
		diagnostics.push({ code: "verifier-failed", message: `Verifier status is ${verifier.status}.` });
	}
	if (!hasEvidenceRefs(verifier.evidenceRefs)) {
		diagnostics.push({ code: "verifier-evidence-missing", message: "Verifier evidenceRefs are required." });
	}
	return diagnostics;
}

function requiresWorktreeIsolation(definition: LoopDefinition): boolean {
	return definition.worktree?.mode === "per-run" || definition.worktree?.mode === "per-item";
}

function validateWorktreeEvidence(
	definition: LoopDefinition,
	worktree: LoopWorktreeEvidence | undefined,
): LoopValidationDiagnostic[] {
	if (!worktree) {
		return [
			{
				code: "worktree-isolation-required",
				message: "Isolated loop actions require worktree evidence.",
			},
		];
	}

	const diagnostics: LoopValidationDiagnostic[] = [];
	if (worktree.isolated !== true) {
		diagnostics.push({
			code: "worktree-isolation-required",
			message: "Loop worktree evidence must confirm isolation.",
		});
	}
	if (!worktree.worktreeId?.trim()) {
		diagnostics.push({
			code: "worktree-id-required",
			message: "Loop worktree evidence must include a worktreeId.",
		});
	}
	if (definition.worktree?.requireCleanCheckout === true && worktree.cleanCheckout !== true) {
		diagnostics.push({
			code: "worktree-clean-checkout-required",
			message: "Loop worktree must start from a clean checkout.",
		});
	}
	const branchPrefix = definition.worktree?.branchPrefix;
	if (
		branchPrefix &&
		worktree.branch &&
		!pathHasScopePrefix(normalizePath(worktree.branch), normalizePath(branchPrefix))
	) {
		diagnostics.push({
			code: "worktree-branch-prefix-mismatch",
			message: `Loop worktree branch must use prefix ${branchPrefix}.`,
			path: worktree.branch,
		});
	}
	return diagnostics;
}

function validateDurableStateEvidence(durableState: LoopDurableStateEvidence | undefined): LoopValidationDiagnostic[] {
	const diagnostics: LoopValidationDiagnostic[] = [];
	if (!durableState?.stateRevision?.trim()) {
		diagnostics.push({
			code: "state-revision-missing",
			message: "Replayable loop actions require a stateRevision.",
		});
	}
	if (!durableState?.runLogRef?.trim()) {
		diagnostics.push({
			code: "run-log-ref-missing",
			message: "Replayable loop actions require a runLogRef.",
		});
	}
	if (!durableState?.budgetReservationId?.trim()) {
		diagnostics.push({
			code: "budget-reservation-missing",
			message: "Replayable loop actions require a budgetReservationId.",
		});
	}
	return diagnostics;
}

function requiresHumanApproval(definition: LoopDefinition, item: LoopWorkItem): boolean {
	const gatedRisks = definition.humanGates?.requiredForRisks;
	if (gatedRisks !== undefined) {
		return gatedRisks.includes(item.risk);
	}
	return definition.safety.requireHumanGateForHighRisk && item.risk === "high";
}

function validateRequestedWriteScopeDoesNotOverlapDenied(
	definition: LoopDefinition,
	requestedScopes: readonly string[],
): LoopValidationDiagnostic[] {
	const deniedScopes = definition.safety.deniedWriteScopes ?? [];
	const diagnostics: LoopValidationDiagnostic[] = [];
	for (const requestedScope of requestedScopes) {
		const normalizedRequested = normalizePath(requestedScope);
		if (!normalizedRequested) {
			continue;
		}
		for (const deniedScope of deniedScopes) {
			const normalizedDenied = normalizePath(deniedScope);
			if (normalizedDenied && scopesOverlap(normalizedRequested, normalizedDenied)) {
				diagnostics.push({
					code: "write-scope-denied-overlap",
					message: `Requested writeScope ${normalizedRequested} overlaps deniedWriteScope ${normalizedDenied}.`,
					path: normalizedRequested,
				});
			}
		}
	}
	return diagnostics;
}

function validateChangedFilesWithinRequestedScope(
	writeScope: readonly string[],
	changedFiles: readonly string[],
): LoopValidationDiagnostic[] {
	const diagnostics: LoopValidationDiagnostic[] = [];
	for (const changedFile of changedFiles) {
		const normalizedFile = normalizePath(changedFile);
		if (!normalizedFile) {
			continue;
		}
		if (!matchesAnyScope(normalizedFile, writeScope)) {
			diagnostics.push({
				code: "changed-file-outside-write-scope",
				message: `Changed file ${normalizedFile} is outside the requested writeScope.`,
				path: normalizedFile,
			});
		}
	}
	return diagnostics;
}

function hasEvidenceRefs(refs: readonly string[] | undefined): boolean {
	return Boolean(refs?.some((ref) => ref.trim().length > 0));
}

function matchesWatchedScope(definition: LoopDefinition, item: LoopWorkItem): boolean {
	const haystack = normalizePath([item.actingOn, item.sourceRef, item.title].join(" "));
	const watchedPaths = definition.watchedScope.paths ?? [];
	if (watchedPaths.some((scope) => pathHasScopePrefix(normalizePath(item.actingOn), normalizePath(scope)))) {
		return true;
	}
	const watchedTickets = definition.watchedScope.tickets ?? [];
	if (watchedTickets.some((ticket) => haystack.includes(normalizePath(ticket)))) {
		return true;
	}
	const watchedBranches = definition.watchedScope.branches ?? [];
	if (watchedBranches.some((branch) => haystack.includes(normalizePath(branch)))) {
		return true;
	}
	return definition.watchedScope.repos.some((repo) => haystack.includes(normalizePath(repo)));
}

function tokenize(text: string): Set<string> {
	const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
	return new Set(matches.filter((token) => token.length > 1 && !TOKEN_STOP_WORDS.has(token)));
}

function overlapRatio(source: Set<string>, target: Set<string>): number {
	if (target.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const token of target) {
		if (source.has(token)) {
			overlap++;
		}
	}
	return overlap / target.size;
}

function clamp01(value: number): number {
	if (value < 0) {
		return 0;
	}
	if (value > 1) {
		return 1;
	}
	return value;
}

function matchesAnyScope(path: string, scopes: readonly string[]): boolean {
	return scopes.some((scope) => scopeMatchesPath(path, scope));
}

function scopesOverlap(first: string, second: string): boolean {
	return scopeMatchesPath(first, second) || scopeMatchesPath(second, first);
}

function scopeMatchesPath(path: string, scope: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedScope = normalizePath(scope);
	if (!normalizedPath || !normalizedScope) {
		return false;
	}
	if (normalizedScope.includes("*")) {
		return globToRegExp(normalizedScope).test(normalizedPath);
	}
	return pathHasScopePrefix(normalizedPath, normalizedScope);
}

function pathHasScopePrefix(path: string, scope: string): boolean {
	return path === scope || path.startsWith(`${scope}/`);
}

function normalizePath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function globToRegExp(glob: string): RegExp {
	let pattern = "^";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		const nextChar = glob[index + 1];
		if (char === "*" && nextChar === "*") {
			pattern += ".*";
			index++;
		} else if (char === "*") {
			pattern += "[^/]*";
		} else {
			pattern += escapeRegExp(char);
		}
	}
	return new RegExp(`${pattern}$`);
}

function escapeRegExp(char: string): string {
	return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
