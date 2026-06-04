export const MAX_TITLE_INPUT_CHARS = 2000;

/**
 * Minimum length of code-stripped input below which we fall back to the
 * original message. Guards against messages that are (almost) entirely a code
 * block — stripping would otherwise leave the model nothing to title from.
 */
const MIN_STRIPPED_TITLE_CHARS = 12;
/** Matches a fenced code block (3+ backticks), including an unterminated trailing fence. */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;

export function truncateTitleInput(message: string): string {
	return message.length > MAX_TITLE_INPUT_CHARS ? `${message.slice(0, MAX_TITLE_INPUT_CHARS)}…` : message;
}

/**
 * Strip fenced code blocks from a message before titling.
 *
 * Small title models latch onto literal text inside code blocks — e.g. a pasted
 * UI mockup containing "Welcome to Claude Code v2.1.158" yields that string as
 * the title instead of the surrounding intent. Removing fenced blocks leaves the
 * prose that actually describes the task. Inline code (single backticks) is kept
 * — it is short, high-signal context like `/login`.
 *
 * Falls back to the original message when stripping leaves too little to title
 * (a message that is essentially just a code block).
 */
export function stripCodeBlocks(message: string): string {
	const cleaned = message
		.replace(FENCED_CODE_BLOCK, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

/** Prepare a raw user message for titling: drop code blocks, then bound length. */
export function prepareTitleInput(message: string): string {
	return truncateTitleInput(stripCodeBlocks(message));
}

export function formatTitleUserMessage(message: string): string {
	return `<user-message>\n${prepareTitleInput(message)}\n</user-message>`;
}

/**
 * Greeting / acknowledgement / filler tokens. A first user message composed
 * entirely of these (or of bare numbers / punctuation / emoji) carries no
 * concrete task, so titling is deferred to a later message instead of latching
 * onto "hi". See {@link isLowSignalTitleInput}.
 */
const FILLER_TITLE_TOKENS = new Set<string>([
	// greetings
	"hi",
	"hii",
	"hiii",
	"hiya",
	"hey",
	"heya",
	"hello",
	"helo",
	"hullo",
	"yo",
	"ya",
	"sup",
	"wassup",
	"whatsup",
	"howdy",
	"greetings",
	"hola",
	"ciao",
	"aloha",
	"gm",
	"gn",
	"good",
	"morning",
	"afternoon",
	"evening",
	"night",
	"day",
	// politeness / acknowledgement
	"thanks",
	"thank",
	"thx",
	"ty",
	"tysm",
	"cheers",
	"please",
	"pls",
	"plz",
	"ok",
	"okay",
	"okey",
	"k",
	"kk",
	"yep",
	"yes",
	"yeah",
	"yup",
	"nope",
	"no",
	"nah",
	"sure",
	"cool",
	"nice",
	"great",
	"awesome",
	"perfect",
	"lol",
	"lmao",
	"haha",
	"hehe",
	// poking the agent / fillers
	"test",
	"tests",
	"testing",
	"ping",
	"pong",
	"there",
	"you",
	"u",
	"hmm",
	"hmmm",
	"um",
	"uh",
	"so",
	"well",
	"anyway",
]);

const TITLE_WORD = /[\p{L}\p{N}]+/gu;

/**
 * True when a first user message is too low-signal to title (greeting, ack,
 * bare number, or empty once code/punctuation/emoji are stripped).
 *
 * Deterministic pre-filter: the default tiny title model (~350M local) cannot
 * reliably follow a "respond with none" instruction and tends to hallucinate a
 * title for trivial input, so we never ask it — the caller defers titling to
 * the next message instead.
 */
export function isLowSignalTitleInput(message: string): boolean {
	const tokens = stripCodeBlocks(message).toLowerCase().match(TITLE_WORD);
	if (!tokens) return true;
	return tokens.every(token => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

/**
 * Sentinel a capable title model may emit when a message carries no concrete
 * task. Treated as "no title yet" so the caller can defer titling. Backstop for
 * the deterministic {@link isLowSignalTitleInput} filter; kept in sync with the
 * `none` instruction in `prompts/system/title-system.md`.
 */
export const NO_TITLE_SENTINEL = "none";

export function normalizeGeneratedTitle(value: string | null | undefined): string | null {
	const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return null;
	const title = firstLine
		.replace(/^["']|["']$/g, "")
		.replace(/[.!?]$/, "")
		.trim();
	if (!title || title.toLowerCase() === NO_TITLE_SENTINEL) return null;
	return title;
}
