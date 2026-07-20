/**
 * Flag-gated loader for the vendored oh-my-pi "pure" read/search/hashline seams.
 *
 * These seams are pure data/proposal-only functions (planning + presentation +
 * hashline parsing). They do NOT touch edit/write/file-mutation paths. The
 * loader is opt-in via OMK_OMP_SEAMS=1 and otherwise throws DISABLED, so the
 * feature is inert in all existing sessions unless explicitly enabled.
 *
 * The file is erasable TypeScript: no `enum`, no parameter properties, no `as`,
 * no non-null assertions, no `any` annotations, and no runtime dependencies
 * beyond the Node.js standard library.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Error categories raised by the OMP pure-seam loader. */
export type OmpSeamsErrorCode = "DISABLED" | "VENDOR_NOT_FOUND" | "INVALID_SEAM";

/** Typed error thrown by {@link loadOmpPureSeams}. */
export class OmpSeamsError extends Error {
	readonly code: OmpSeamsErrorCode;

	constructor(code: OmpSeamsErrorCode, message: string) {
		super(message);
		this.name = "OmpSeamsError";
		this.code = code;
	}
}

/** The validated set of pure oh-my-pi seams (data/proposal-only). */
export interface OmpPureSeams {
	planRead(input: unknown): unknown;
	presentRead(plan: unknown, file: unknown): unknown;
	planSearch(input: unknown): unknown;
	presentSearch(plan: unknown, matches: unknown, sourceDigests?: unknown): unknown;
	parseHashlineProposal(text: string): unknown;
	hashProposalLine(text: string): Promise<string>;
	hashProposalSource(text: string): Promise<string>;
}

/**
 * Returns true only when the seams feature is explicitly enabled
 * (OMK_OMP_SEAMS === "1"). Reads `process.env` when no record is supplied.
 */
export function isOmpSeamsEnabled(env?: Record<string, string | undefined>): boolean {
	const source: Record<string, string | undefined> = env ?? process.env;
	return source.OMK_OMP_SEAMS === "1";
}

const VENDOR_SEGMENT = join("vendor", "oh-my-pi");
const VENDOR_MARKER = join(VENDOR_SEGMENT, "packages", "coding-agent", "src", "pure", "read.ts");
const MAX_WALK_UP_LEVELS = 8;

/**
 * Walks up from `startDir` (inclusive) looking for a `vendor/oh-my-pi`
 * directory that contains the pure read seam marker file. Returns the absolute
 * vendor directory path, or `undefined` when none is found within the level cap.
 */
export function resolveOmpVendorDir(startDir: string): string | undefined {
	let dir = isAbsolute(startDir) ? startDir : resolve(startDir);
	for (let level = 0; level <= MAX_WALK_UP_LEVELS; level += 1) {
		if (existsSync(join(dir, VENDOR_MARKER))) {
			return join(dir, VENDOR_SEGMENT);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

// --- internal narrowing helpers (no `as`; type guards carry the signatures) ---

type SeamFn = (...args: never[]) => unknown;
type SeamAsyncStrFn = (...args: never[]) => Promise<string>;

function isSeamFn(member: unknown): member is SeamFn {
	return typeof member === "function";
}

function isSeamAsyncStrFn(member: unknown): member is SeamAsyncStrFn {
	return typeof member === "function";
}

function expectFn<T extends SeamFn>(member: unknown, guard: (m: unknown) => m is T, name: string): T {
	if (guard(member)) return member;
	throw new OmpSeamsError("INVALID_SEAM", `OMP seam missing or non-function: ${name}`);
}

const READ_SEAM = join("packages", "coding-agent", "src", "pure", "read.ts");
const SEARCH_SEAM = join("packages", "coding-agent", "src", "pure", "search.ts");
const PROPOSAL_SEAM = join("packages", "hashline", "src", "proposal.ts");

/**
 * Loads and validates the three pure seam modules from the vendored oh-my-pi
 * tree and returns a frozen {@link OmpPureSeams} record. Throws
 * {@link OmpSeamsError} with code DISABLED when the feature is off,
 * VENDOR_NOT_FOUND when the vendor tree cannot be located, or INVALID_SEAM when
 * any expected export is missing or not a function.
 */
export async function loadOmpPureSeams(options?: {
	vendorDir?: string;
	env?: Record<string, string | undefined>;
}): Promise<OmpPureSeams> {
	const env: Record<string, string | undefined> = options?.env ?? process.env;
	if (!isOmpSeamsEnabled(env)) {
		throw new OmpSeamsError("DISABLED", "OMP pure seams are disabled (set OMK_OMP_SEAMS=1 to enable).");
	}

	let vendorDir: string | undefined = options?.vendorDir ?? env.OMK_OMP_VENDOR_DIR;
	if (!vendorDir) {
		const moduleUrl = new URL(".", import.meta.url);
		if (moduleUrl.protocol !== "file:") {
			throw new OmpSeamsError(
				"VENDOR_NOT_FOUND",
				"OMP vendor dir was not provided and the module is not a file URL.",
			);
		}
		const found = resolveOmpVendorDir(fileURLToPath(moduleUrl));
		if (!found) {
			throw new OmpSeamsError(
				"VENDOR_NOT_FOUND",
				"OMP vendor dir not found by walking up from the module directory.",
			);
		}
		vendorDir = found;
	}
	if (!existsSync(vendorDir)) {
		throw new OmpSeamsError("VENDOR_NOT_FOUND", `OMP vendor dir does not exist: ${vendorDir}`);
	}

	const readUrl = pathToFileURL(join(vendorDir, READ_SEAM)).href;
	const searchUrl = pathToFileURL(join(vendorDir, SEARCH_SEAM)).href;
	const proposalUrl = pathToFileURL(join(vendorDir, PROPOSAL_SEAM)).href;

	const readMod = await import(readUrl);
	const searchMod = await import(searchUrl);
	const proposalMod = await import(proposalUrl);

	// Validate every expected member up front so the INVALID_SEAM error lists
	// ALL missing/non-function exports, not just the first one encountered.
	const expected: ReadonlyArray<readonly [unknown, string]> = [
		[readMod.planRead, "planRead"],
		[readMod.presentRead, "presentRead"],
		[searchMod.planSearch, "planSearch"],
		[searchMod.presentSearch, "presentSearch"],
		[proposalMod.parseHashlineProposal, "parseHashlineProposal"],
		[proposalMod.hashProposalLine, "hashProposalLine"],
		[proposalMod.hashProposalSource, "hashProposalSource"],
	];
	const missing: string[] = [];
	for (const [member, name] of expected) {
		if (typeof member !== "function") missing.push(name);
	}
	if (missing.length > 0) {
		throw new OmpSeamsError("INVALID_SEAM", `OMP seams missing or non-function: ${missing.join(", ")}`);
	}

	const rec: OmpPureSeams = {
		planRead: expectFn(readMod.planRead, isSeamFn, "planRead"),
		presentRead: expectFn(readMod.presentRead, isSeamFn, "presentRead"),
		planSearch: expectFn(searchMod.planSearch, isSeamFn, "planSearch"),
		presentSearch: expectFn(searchMod.presentSearch, isSeamFn, "presentSearch"),
		parseHashlineProposal: expectFn(proposalMod.parseHashlineProposal, isSeamFn, "parseHashlineProposal"),
		hashProposalLine: expectFn(proposalMod.hashProposalLine, isSeamAsyncStrFn, "hashProposalLine"),
		hashProposalSource: expectFn(proposalMod.hashProposalSource, isSeamAsyncStrFn, "hashProposalSource"),
	};
	Object.freeze(rec);
	return rec;
}
