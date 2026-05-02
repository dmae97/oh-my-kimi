/**
 * Lightweight line-hash utilities extracted from hashline.ts to avoid
 * circular dependencies (prompt-templates → hashline → tools → edit).
 */

/**
 * 647 single-token BPE bigrams for hashline anchors. Every entry tokenizes as
 * exactly one token in modern BPE vocabularies (cl100k / o200k / Claude family),
 * so a hashline anchor built from one bigram is exactly 1 token.
 *
 * This is the complete set of 2-letter lowercase combinations that are single
 * tokens — the 29 missing combinations are rare-letter pairs (q/x/z heavy)
 * that no major BPE vocabulary merges into a single token.
 *
 * Order is stable forever — changing it would invalidate every saved
 * `LINE+ID` reference in transcripts and prompts.
 */
export const HASHLINE_BIGRAMS = [
	"aa",
	"ab",
	"ac",
	"ad",
	"ae",
	"af",
	"ag",
	"ah",
	"ai",
	"aj",
	"ak",
	"al",
	"am",
	"an",
	"ao",
	"ap",
	"aq",
	"ar",
	"as",
	"at",
	"au",
	"av",
	"aw",
	"ax",
	"ay",
	"az",
	"ba",
	"bb",
	"bc",
	"bd",
	"be",
	"bf",
	"bg",
	"bh",
	"bi",
	"bj",
	"bk",
	"bl",
	"bm",
	"bn",
	"bo",
	"bp",
	"br",
	"bs",
	"bt",
	"bu",
	"bv",
	"bw",
	"bx",
	"by",
	"bz",
	"ca",
	"cb",
	"cc",
	"cd",
	"ce",
	"cf",
	"cg",
	"ch",
	"ci",
	"cj",
	"ck",
	"cl",
	"cm",
	"cn",
	"co",
	"cp",
	"cq",
	"cr",
	"cs",
	"ct",
	"cu",
	"cv",
	"cw",
	"cx",
	"cy",
	"cz",
	"da",
	"db",
	"dc",
	"dd",
	"de",
	"df",
	"dg",
	"dh",
	"di",
	"dj",
	"dk",
	"dl",
	"dm",
	"dn",
	"do",
	"dp",
	"dq",
	"dr",
	"ds",
	"dt",
	"du",
	"dv",
	"dw",
	"dx",
	"dy",
	"dz",
	"ea",
	"eb",
	"ec",
	"ed",
	"ee",
	"ef",
	"eg",
	"eh",
	"ei",
	"ej",
	"ek",
	"el",
	"em",
	"en",
	"eo",
	"ep",
	"eq",
	"er",
	"es",
	"et",
	"eu",
	"ev",
	"ew",
	"ex",
	"ey",
	"ez",
	"fa",
	"fb",
	"fc",
	"fd",
	"fe",
	"ff",
	"fg",
	"fh",
	"fi",
	"fj",
	"fk",
	"fl",
	"fm",
	"fn",
	"fo",
	"fp",
	"fq",
	"fr",
	"fs",
	"ft",
	"fu",
	"fv",
	"fw",
	"fx",
	"fy",
	"fz",
	"ga",
	"gb",
	"gc",
	"gd",
	"ge",
	"gf",
	"gg",
	"gh",
	"gi",
	"gj",
	"gl",
	"gm",
	"gn",
	"go",
	"gp",
	"gr",
	"gs",
	"gt",
	"gu",
	"gv",
	"gw",
	"gx",
	"gy",
	"gz",
	"ha",
	"hb",
	"hc",
	"hd",
	"he",
	"hf",
	"hg",
	"hh",
	"hi",
	"hj",
	"hk",
	"hl",
	"hm",
	"hn",
	"ho",
	"hp",
	"hq",
	"hr",
	"hs",
	"ht",
	"hu",
	"hv",
	"hw",
	"hx",
	"hy",
	"hz",
	"ia",
	"ib",
	"ic",
	"id",
	"ie",
	"if",
	"ig",
	"ih",
	"ii",
	"ij",
	"ik",
	"il",
	"im",
	"in",
	"io",
	"ip",
	"iq",
	"ir",
	"is",
	"it",
	"iu",
	"iv",
	"iw",
	"ix",
	"iy",
	"iz",
	"ja",
	"jb",
	"jc",
	"jd",
	"je",
	"jf",
	"jg",
	"jh",
	"ji",
	"jj",
	"jk",
	"jl",
	"jm",
	"jn",
	"jo",
	"jp",
	"jq",
	"jr",
	"js",
	"jt",
	"ju",
	"jw",
	"jx",
	"jy",
	"ka",
	"kb",
	"kc",
	"kd",
	"ke",
	"kf",
	"kg",
	"kh",
	"ki",
	"kj",
	"kk",
	"kl",
	"km",
	"kn",
	"ko",
	"kp",
	"kr",
	"ks",
	"kt",
	"ku",
	"kv",
	"kw",
	"kx",
	"ky",
	"la",
	"lb",
	"lc",
	"ld",
	"le",
	"lf",
	"lg",
	"lh",
	"li",
	"lj",
	"lk",
	"ll",
	"lm",
	"ln",
	"lo",
	"lp",
	"lr",
	"ls",
	"lt",
	"lu",
	"lv",
	"lw",
	"lx",
	"ly",
	"lz",
	"ma",
	"mb",
	"mc",
	"md",
	"me",
	"mf",
	"mg",
	"mh",
	"mi",
	"mj",
	"mk",
	"ml",
	"mm",
	"mn",
	"mo",
	"mp",
	"mq",
	"mr",
	"ms",
	"mt",
	"mu",
	"mv",
	"mw",
	"mx",
	"my",
	"mz",
	"na",
	"nb",
	"nc",
	"nd",
	"ne",
	"nf",
	"ng",
	"nh",
	"ni",
	"nj",
	"nk",
	"nl",
	"nm",
	"nn",
	"no",
	"np",
	"nr",
	"ns",
	"nt",
	"nu",
	"nv",
	"nw",
	"nx",
	"ny",
	"nz",
	"oa",
	"ob",
	"oc",
	"od",
	"oe",
	"of",
	"og",
	"oh",
	"oi",
	"oj",
	"ok",
	"ol",
	"om",
	"on",
	"oo",
	"op",
	"oq",
	"or",
	"os",
	"ot",
	"ou",
	"ov",
	"ow",
	"ox",
	"oy",
	"oz",
	"pa",
	"pb",
	"pc",
	"pd",
	"pe",
	"pf",
	"pg",
	"ph",
	"pi",
	"pj",
	"pk",
	"pl",
	"pm",
	"pn",
	"po",
	"pp",
	"pq",
	"pr",
	"ps",
	"pt",
	"pu",
	"pv",
	"pw",
	"px",
	"py",
	"pz",
	"qa",
	"qb",
	"qc",
	"qd",
	"qe",
	"qh",
	"qi",
	"ql",
	"qm",
	"qn",
	"qo",
	"qp",
	"qq",
	"qr",
	"qs",
	"qt",
	"qu",
	"qw",
	"qx",
	"qy",
	"ra",
	"rb",
	"rc",
	"rd",
	"re",
	"rf",
	"rg",
	"rh",
	"ri",
	"rk",
	"rl",
	"rm",
	"rn",
	"ro",
	"rp",
	"rq",
	"rr",
	"rs",
	"rt",
	"ru",
	"rv",
	"rw",
	"rx",
	"ry",
	"rz",
	"sa",
	"sb",
	"sc",
	"sd",
	"se",
	"sf",
	"sg",
	"sh",
	"si",
	"sj",
	"sk",
	"sl",
	"sm",
	"sn",
	"so",
	"sp",
	"sq",
	"sr",
	"ss",
	"st",
	"su",
	"sv",
	"sw",
	"sx",
	"sy",
	"sz",
	"ta",
	"tb",
	"tc",
	"td",
	"te",
	"tf",
	"tg",
	"th",
	"ti",
	"tj",
	"tk",
	"tl",
	"tm",
	"tn",
	"to",
	"tp",
	"tr",
	"ts",
	"tt",
	"tu",
	"tv",
	"tw",
	"tx",
	"ty",
	"tz",
	"ua",
	"ub",
	"uc",
	"ud",
	"ue",
	"uf",
	"ug",
	"uh",
	"ui",
	"uj",
	"uk",
	"ul",
	"um",
	"un",
	"uo",
	"up",
	"uq",
	"ur",
	"us",
	"ut",
	"uu",
	"uv",
	"uw",
	"ux",
	"uy",
	"uz",
	"va",
	"vb",
	"vc",
	"vd",
	"ve",
	"vf",
	"vg",
	"vh",
	"vi",
	"vj",
	"vk",
	"vl",
	"vm",
	"vn",
	"vo",
	"vp",
	"vq",
	"vr",
	"vs",
	"vt",
	"vu",
	"vv",
	"vw",
	"vx",
	"vy",
	"vz",
	"wa",
	"wb",
	"wc",
	"wd",
	"we",
	"wf",
	"wg",
	"wh",
	"wi",
	"wj",
	"wk",
	"wl",
	"wm",
	"wn",
	"wo",
	"wp",
	"wr",
	"ws",
	"wt",
	"wu",
	"wv",
	"ww",
	"wx",
	"wy",
	"xa",
	"xb",
	"xc",
	"xd",
	"xe",
	"xf",
	"xh",
	"xi",
	"xl",
	"xm",
	"xn",
	"xo",
	"xp",
	"xr",
	"xs",
	"xt",
	"xu",
	"xx",
	"xy",
	"xz",
	"ya",
	"yb",
	"yc",
	"yd",
	"ye",
	"yf",
	"yg",
	"yh",
	"yi",
	"yj",
	"yk",
	"yl",
	"ym",
	"yn",
	"yo",
	"yp",
	"yr",
	"ys",
	"yt",
	"yu",
	"yv",
	"yw",
	"yx",
	"yy",
	"yz",
	"za",
	"zb",
	"zc",
	"zd",
	"ze",
	"zf",
	"zg",
	"zh",
	"zi",
	"zk",
	"zl",
	"zm",
	"zn",
	"zo",
	"zp",
	"zr",
	"zs",
	"zt",
	"zu",
	"zw",
	"zx",
	"zy",
	"zz",
] as const;

export const HASHLINE_BIGRAMS_COUNT = HASHLINE_BIGRAMS.length;

/**
 * Regex source matching one valid hashline anchor hash. Matches either:
 *   - a 2-letter BPE bigram from {@link HASHLINE_BIGRAMS} (the default
 *     1-token-per-anchor alphabet for ordinary lines), or
 *   - `>[a-z]` for lines whose trimmed content starts with `}`
 *     (closing-brace marker — uses `>` so the hash never visually collides
 *     with a literal `}` in line content), or
 *   - `[a-z]<` for lines whose trimmed content ends with `{`
 *     (opening-brace marker — uses `<` so the hash never visually collides
 *     with a literal `{` in line content).
 *
 * Brace markers cost ~2-3 BPE tokens instead of 1; the structural signal is
 * the explicit tradeoff. Keep in sync with {@link computeLineHash}.
 */
export const HASHLINE_HASH_RE_SRC = `(?:${HASHLINE_BIGRAMS.join("|")}|>[a-z]|[a-z]<)`;

/**
 * Lax hash regex source — same shape as {@link HASHLINE_HASH_RE_SRC} but
 * accepts any `[a-z]{2}` for the bigram arm instead of restricting to the
 * 647 BPE bigrams. Parsers that need to admit syntactically well-formed but
 * stale Lids use this form so the downstream content-fingerprint check can
 * emit a targeted hash-mismatch error rather than an opaque parse error.
 *
 * Keep in sync with {@link HASHLINE_HASH_RE_SRC} — the only legitimate
 * difference is the bigram arm. Update both whenever the hash shape changes.
 */
export const HASHLINE_HASH_LAX_RE_SRC = `(?:[a-z]{2}|>[a-z]|[a-z]<)`;

/**
 * Decoration prefix that may precede a `LINE+HASH` anchor in tool output:
 * `>` (context line in grep), `+` (added line in diff), `-` (removed line),
 * `*` (match line). Any combination, in any order, surrounded by optional
 * whitespace. Output formatters emit at most one decoration per anchor; the
 * regex stays liberal because anchor-ref parsers accept whatever the model
 * echoes back.
 */
export const HASHLINE_ANCHOR_DECORATION_RE_SRC = `\\s*[>+\\-*]*\\s*`;

/**
 * Capture-group regex source for a decorated `LINE+HASH` anchor. Group 1
 * captures the line number (digits only); group 2 captures the strict hash
 * from {@link HASHLINE_HASH_RE_SRC}. The source is intentionally unanchored
 * — anchoring with `^` (or composing into a larger pattern) is the caller's
 * responsibility.
 */
export const HASHLINE_ANCHOR_RE_SRC = `${HASHLINE_ANCHOR_DECORATION_RE_SRC}(\\d+)(${HASHLINE_HASH_RE_SRC})`;

/**
 * Bare `LINE+HASH` Lid (no decorations, no captures, no anchors). Use for
 * embedding inside larger patterns where the line+hash unit appears as a
 * literal (e.g. range bounds, alternation arms, op-line heuristics). Strict
 * variant — only hashes that {@link computeLineHash} actually produces match.
 */
export const HASHLINE_LID_RE_SRC = `[1-9]\\d*${HASHLINE_HASH_RE_SRC}`;

/**
 * Lax variant of {@link HASHLINE_LID_RE_SRC}: same shape, accepts any
 * `[a-z]{2}` for the bigram arm. Parsers admit syntactically well-formed
 * but stale Lids and let the downstream hash-fingerprint check emit a
 * targeted mismatch error.
 */
export const HASHLINE_LID_LAX_RE_SRC = `[1-9]\\d*${HASHLINE_HASH_LAX_RE_SRC}`;

/**
 * Capture-group form of {@link HASHLINE_LID_RE_SRC}: group 1 captures the
 * line number, group 2 captures the strict hash.
 */
export const HASHLINE_LID_CAPTURE_RE_SRC = `([1-9]\\d*)(${HASHLINE_HASH_RE_SRC})`;

/**
 * Capture-group form of {@link HASHLINE_LID_LAX_RE_SRC}: group 1 captures
 * the line number, group 2 captures the lax hash.
 */
export const HASHLINE_LID_LAX_CAPTURE_RE_SRC = `([1-9]\\d*)(${HASHLINE_HASH_LAX_RE_SRC})`;

/** Width of a hash in display characters. */
export const HASHLINE_HASH_WIDTH = 2;

/** Human-readable hash-width label used in user-facing copy (e.g. "2-character"). */
export const HASHLINE_HASH_WIDTH_LABEL = `${HASHLINE_HASH_WIDTH}-character`;

/**
 * Representative hash suffixes for use in user-facing error messages and
 * prompt examples. Cycles through one bigram form, one closing-brace marker,
 * and one opening-brace marker so callers can show the full alphabet shape
 * with a single helper.
 */
export const HASHLINE_HASH_EXAMPLES = ["sr", ">t", "a<"] as const;

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160sr", "160>t", "160a<"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	return HASHLINE_HASH_EXAMPLES.map(e => `"${linePrefix}${e}"`).join(", ");
}

/**
 * Sentinel token that {@link atomGrammar} (atom.lark) uses for the lax hash
 * regex source. Replaced at module-load time by {@link resolveLarkLidPlaceholders}
 * so the grammar is re-derived from a single source of truth alongside its
 * TypeScript consumers. Update both atoms whenever the placeholder name changes.
 */
export const LARK_LID_HASH_LAX_PLACEHOLDER = "$HASHFMT$";

/**
 * Substitute the LID hash placeholder in a Lark grammar text with the
 * central lax-hash regex source. Grammars that don't reference Lids pass
 * through unchanged.
 */
export function resolveLarkLidPlaceholders(grammar: string): string {
	return grammar.split(LARK_LID_HASH_LAX_PLACEHOLDER).join(HASHLINE_HASH_LAX_RE_SRC);
}

export const HASHLINE_CONTENT_SEPARATOR = "|";

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

/**
 * Pick a single lowercase letter (`a`-`z`) from xxHash32 of `line`. Mirrors the
 * seed rule used by {@link computeLineHash} for the bigram path: lines with no
 * letter or digit (e.g. bare `}` / `{`) mix in the line number so adjacent
 * brace-only lines hash differently; lines with significant content stay
 * line-number-independent.
 */
function braceLetter(line: string, idx: number): string {
	const seed = RE_SIGNIFICANT.test(line) ? 0 : idx;
	return String.fromCharCode(97 + (Bun.hash.xxHash32(line, seed) % 26));
}

/**
 * Compute a 2-character hash of a single line.
 *
 * - Lines whose trimmed content starts with `}` (closing brace) hash to
 *   `>[a-z]` (one of `>a`..`>z`).
 * - Lines whose trimmed content ends with `{` (opening brace) hash to
 *   `[a-z]<` (one of `a<`..`z<`). When both apply (e.g. `} else {`), the
 *   opening form wins — the new block is what needs tracking.
 * - All other lines map through {@link HASHLINE_BIGRAMS} via xxHash32 mod 647.
 *
 * For brace markers and other lines containing no letter/digit, the line
 * number is mixed into the seed so adjacent identical lines (e.g. consecutive
 * `}` lines) get distinct hashes; significant content stays
 * line-number-independent so a line is identifiable across small shifts.
 *
 * The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();

	const trimmedStart = line.trimStart();
	const endsOpen = line.endsWith("{");
	const startsClose = trimmedStart.startsWith("}");

	if (endsOpen) {
		return `${braceLetter(line, idx)}<`;
	}
	if (startsClose) {
		return `>${braceLetter(line, idx)}`;
	}

	const seed = RE_SIGNIFICANT.test(line) ? 0 : idx;
	return HASHLINE_BIGRAMS[Bun.hash.xxHash32(line, seed) % HASHLINE_BIGRAMS_COUNT];
}

/**
 * Formats an anchor reference given a line number and its text.
 * Returns `LINE+ID` (e.g., `42sr`, `42>t`, or `42a<`) — no separator between
 * number and hash.
 */
export function formatLineHash(line: number, lines: string): string {
	return `${line}${computeLineHash(line, lines)}`;
}

/**
 * Formats a single line with a hashline anchor.
 * Returns `LINE+ID|TEXT` (e.g., `42sr|function hi() {`, `3>p|}`).
 */
export function formatHashLine(lineNumber: number, line: string): string {
	return `${lineNumber}${computeLineHash(lineNumber, line)}${HASHLINE_CONTENT_SEPARATOR}${line}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINE+ID|TEXT` where LINENUM is 1-indexed.
 * No padding on line numbers; pipe separator between anchor and content.
 *
 * @param text - Raw file text string
 * @param startLine - First line number (1-indexed, defaults to 1)
 * @returns Formatted string with one hashline-prefixed line per input line
 *
 * @example
 * ```
 * formatHashLines("function hi() {\n  return;\n}")
 * // "1a<|function hi() {\n2er|  return;\n3>p|}"
 * ```
 */
export function formatHashLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}
