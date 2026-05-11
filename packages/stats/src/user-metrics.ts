/**
 * Behavioral metrics extracted from a single user message.
 *
 * Pure, side-effect free. Designed for batch use during session ingestion
 * and standalone testing.
 */

export interface UserMessageMetrics {
	/** Total characters of analyzed text. */
	chars: number;
	/** Whitespace-delimited word count. */
	words: number;
	/**
	 * Number of "yelling" sentences: sentences where more than half of the
	 * alphabetic characters are uppercase (and there are enough letters to
	 * make the ratio meaningful — short acronyms like "OK" don't count).
	 */
	yellingSentences: number;
	/** Profanity hits (word-boundary, case-insensitive). */
	profanity: number;
	/** Runs of 3+ `!` / `?` characters (including `1`-mishit fallout). */
	dramaRuns: number;
}

/**
 * Words considered profane/aggressive. Word-boundary, case-insensitive.
 *
 * Broad English coverage: f-/s-word families and their censored variants,
 * mild swears, intelligence-based insults, body-part epithets, British/
 * Australian/Irish slang, religious exclamations, chat acronyms, and
 * frustration interjections. Curated to exclude racial, homophobic, and
 * other identity slurs.
 */
const PROFANITY: readonly string[] = [
	// f-word family
	"fuck",
	"fucks",
	"fucked",
	"fucking",
	"fuckin",
	"fucker",
	"fuckers",
	"fuckup",
	"fuckups",
	"fuckhead",
	"fuckheads",
	"fuckface",
	"fuckwit",
	"fuckwits",
	"fucktard",
	"fuckery",
	"fuckoff",
	"motherfucker",
	"motherfuckers",
	"motherfucking",
	"clusterfuck",
	"ratfuck",
	"unfuck",
	// censored / euphemistic f-word
	"fk",
	"fks",
	"fking",
	"fkin",
	"fker",
	"fck",
	"fcks",
	"fcking",
	"fckin",
	"fcker",
	"fuk",
	"fuking",
	"fukin",
	"eff",
	"effs",
	"effed",
	"effing",
	"frick",
	"fricks",
	"fricked",
	"fricking",
	"frickin",
	"freaking",
	"freakin",
	"freaked",
	// s-word family
	"shit",
	"shits",
	"shat",
	"shitty",
	"shittier",
	"shittiest",
	"shite",
	"shites",
	"shited",
	"shitting",
	"shitter",
	"shitters",
	"shithead",
	"shitheads",
	"shitshow",
	"shitstorm",
	"shitstain",
	"shitfaced",
	"shitload",
	"shitbag",
	"shitcan",
	"shitcanned",
	"shitpost",
	"shitposting",
	"bullshit",
	"bullshits",
	"bullshitting",
	"bullshitter",
	"horseshit",
	"batshit",
	"dogshit",
	"dipshit",
	"jackshit",
	"dumbshit",
	"holyshit",
	// mild swears
	"damn",
	"damns",
	"damned",
	"damning",
	"dammit",
	"goddamn",
	"goddamned",
	"goddamnit",
	"goddammit",
	"darn",
	"darns",
	"darned",
	"darnit",
	"dang",
	"danged",
	"dangit",
	"hell",
	"hells",
	"heck",
	"hecks",
	"heckin",
	"gosh",
	"blast",
	"blasted",
	"bloody",
	"bollocks",
	"bollox",
	// crap family
	"crap",
	"craps",
	"crappy",
	"crappier",
	"crappiest",
	"crapped",
	"crapping",
	"crapload",
	"crapshoot",
	"crapola",
	// piss family
	"piss",
	"pisses",
	"pissed",
	"pissing",
	"pisser",
	"pisspoor",
	"pisstake",
	"pisshead",
	// ass family
	"ass",
	"asses",
	"asshole",
	"assholes",
	"asshat",
	"asshats",
	"asswipe",
	"asswipes",
	"assclown",
	"assbag",
	"asskisser",
	"dumbass",
	"dumbasses",
	"jackass",
	"jackasses",
	"smartass",
	"smartasses",
	"badass",
	"badasses",
	"lazyass",
	"fatass",
	"hardass",
	"halfass",
	"halfassed",
	"arse",
	"arsed",
	"arsehole",
	"arseholes",
	"arsewipe",
	// bitch family
	"bitch",
	"bitches",
	"bitched",
	"bitching",
	"bitchy",
	"bitchier",
	"bitchiest",
	"sonofabitch",
	"biatch",
	"biotch",
	// strong vulgarity
	"cunt",
	"cunts",
	"cunty",
	"cuntish",
	"twat",
	"twats",
	"twatty",
	"bastard",
	"bastards",
	// body-part insults
	"dick",
	"dicks",
	"dickhead",
	"dickheads",
	"dickish",
	"dickwad",
	"dickwads",
	"dickface",
	"dickbag",
	"prick",
	"pricks",
	"prickish",
	"cock",
	"cocks",
	"cocky",
	"cockier",
	"cockiest",
	"cockhead",
	"cockblock",
	"cocksucker",
	"cocksuckers",
	"knob",
	"knobhead",
	"knobheads",
	"knobend",
	"wanker",
	"wankers",
	"wankery",
	"tosser",
	"tossers",
	"jerkoff",
	"jerkoffs",
	"douche",
	"douches",
	"douchebag",
	"douchebags",
	"douchey",
	"scumbag",
	"scumbags",
	"scum",
	"sleazebag",
	"sleazeball",
	"slimeball",
	"lowlife",
	"lowlifes",
	"deadbeat",
	// intelligence-based insults
	"idiot",
	"idiots",
	"idiotic",
	"idiocy",
	"stupid",
	"stupider",
	"stupidest",
	"stupidity",
	"moron",
	"morons",
	"moronic",
	"imbecile",
	"imbeciles",
	"retard",
	"retards",
	"retarded",
	"dumb",
	"dumber",
	"dumbest",
	"dumbo",
	"dummy",
	"dummies",
	"fool",
	"fools",
	"foolish",
	"foolery",
	"clown",
	"clowns",
	"clownish",
	"buffoon",
	"buffoons",
	"simpleton",
	"halfwit",
	"halfwits",
	"nitwit",
	"nitwits",
	"dimwit",
	"dimwits",
	"dolt",
	"dolts",
	"doltish",
	"knucklehead",
	"knuckleheads",
	"blockhead",
	"blockheads",
	"lamebrain",
	"airhead",
	"airheads",
	"scatterbrain",
	"numbnuts",
	"numbskull",
	"numpty",
	"numpties",
	"muppet",
	"muppets",
	"pillock",
	"pillocks",
	"plonker",
	"plonkers",
	"prat",
	"prats",
	"berk",
	"berks",
	"ninny",
	"ninnies",
	"dingbat",
	"dingbats",
	"putz",
	"putzes",
	"schmuck",
	"schmucks",
	"jerk",
	"jerks",
	"jerkface",
	"git",
	"gits",
	"sod",
	"sodding",
	"bugger",
	"buggered",
	// generic aggression / dismissal
	"hate",
	"hated",
	"hates",
	"hating",
	"hateful",
	"suck",
	"sucks",
	"sucked",
	"sucking",
	"sucky",
	"suckage",
	"trash",
	"trashy",
	"trashed",
	"garbage",
	"crud",
	"crudded",
	// religious exclamations
	"jesus",
	"christ",
	"jeez",
	"jeezus",
	"sheesh",
	"holymoly",
	"holyfuck",
	"holysmokes",
	"godsake",
	// chat acronyms
	"wtf",
	"wth",
	"wtaf",
	"stfu",
	"gtfo",
	"omfg",
	"omg",
	"ffs",
	"jfc",
	"kys",
	"fml",
	"smh",
	"smdh",
	"smfh",
	"idgaf",
	"idfc",
	"lmfao",
	"fubar",
	"snafu",
	// frustration interjections
	"ugh",
	"ughh",
	"ughhh",
	"urgh",
	"argh",
	"arghh",
	"arghhh",
	"arrgh",
	"blah",
	"bleh",
	"meh",
	"yikes",
	"yeesh",
	"oof",
	"gah",
	"gahh",
	"grr",
	"grrr",
	"grrrr",
];

const PROFANITY_RE = new RegExp(`\\b(?:${PROFANITY.join("|")})\\b`, "gi");
const SENTENCE_RE = /[^.!?\n]+/g;
const LETTER_RE = /\p{L}/gu;
const UPPER_LETTER_RE = /\p{Lu}/gu;
const YELLING_MIN_LETTERS = 4;
const YELLING_THRESHOLD = 0.5;
// Runs starting with `!` or `?` followed by ≥2 of `!?1`. The `1` is the
// classic shift-key mishit ("!!!111" / "!?!??111") so we count those as
// part of the same drama burst.
const DRAMA_RE = /[!?][!?1]{2,}/g;
const WORD_RE = /\S+/g;

/** Count regex hits without materializing the match array. */
function countMatches(text: string, re: RegExp): number {
	let count = 0;
	re.lastIndex = 0;
	while (re.exec(text) !== null) count++;
	return count;
}

/**
 * Count sentences where the share of uppercase letters exceeds
 * {@link YELLING_THRESHOLD}. Sentences shorter than
 * {@link YELLING_MIN_LETTERS} alphabetic characters are ignored so that
 * short acronyms ("OK", "WIP", "TODO") don't register as yelling.
 */
function countYellingSentences(text: string): number {
	let count = 0;
	SENTENCE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = SENTENCE_RE.exec(text);
	while (match !== null) {
		const sentence = match[0];
		const letters = countMatches(sentence, LETTER_RE);
		if (letters >= YELLING_MIN_LETTERS) {
			const upper = countMatches(sentence, UPPER_LETTER_RE);
			if (upper / letters > YELLING_THRESHOLD) count++;
		}
		match = SENTENCE_RE.exec(text);
	}
	return count;
}

/**
 * Compute behavioral metrics for a user message.
 *
 * `text` may be empty or whitespace; in that case every metric is 0.
 */
export function computeUserMessageMetrics(text: string): UserMessageMetrics {
	const trimmed = text.trim();
	if (!trimmed) {
		return { chars: 0, words: 0, yellingSentences: 0, profanity: 0, dramaRuns: 0 };
	}
	return {
		chars: trimmed.length,
		words: countMatches(trimmed, WORD_RE),
		yellingSentences: countYellingSentences(trimmed),
		profanity: countMatches(trimmed, PROFANITY_RE),
		dramaRuns: countMatches(trimmed, DRAMA_RE),
	};
}

/** Empty metrics constant for callers that need a default. */
export const EMPTY_USER_METRICS: UserMessageMetrics = Object.freeze({
	chars: 0,
	words: 0,
	yellingSentences: 0,
	profanity: 0,
	dramaRuns: 0,
});
