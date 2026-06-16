// LaTeX → Unicode/ANSI converter.
//
// Terminals cannot lay out real math, but a surprising amount of LaTeX maps
// cleanly onto Unicode: superscripts/subscripts (x² xᵢ), Greek (α β), big
// operators (∫ ∑ ∏), relations/arrows (≤ ≠ → ⇒), fonts via the Mathematical
// Alphanumeric Symbols block (ℝ 𝐱 𝔄 𝒞), accents via combining marks (x̂ x̄ x⃗),
// fractions (½, (a+b)/c) and radicals (√, ∛). This module turns a LaTeX math
// fragment into the best-effort Unicode rendering of it.
//
// `latexToUnicode(src)` converts a *bare* math fragment (no `$`/`\(` delimiters).
// `renderMathInText(text)` scans prose for `$$…$$`, `$…$`, `\(…\)`, `\[…\]`
// spans and converts only those, with anti-currency heuristics so "$5 and $10"
// is left untouched. The markdown renderer isolates math via a Marked extension
// and calls `latexToUnicode` directly; `renderMathInText` serves callers that
// only have raw text.

// ---------------------------------------------------------------------------
// Character maps
// ---------------------------------------------------------------------------

// Unicode superscript forms. Letters are incomplete in Unicode (q, and several
// capitals have no superscript), so the converter falls back to `^(…)` when any
// character in a script group is unmappable.
const SUPERSCRIPT: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"−": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	".": "·",
	" ": " ",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	A: "ᴬ",
	B: "ᴮ",
	D: "ᴰ",
	E: "ᴱ",
	G: "ᴳ",
	H: "ᴴ",
	I: "ᴵ",
	J: "ᴶ",
	K: "ᴷ",
	L: "ᴸ",
	M: "ᴹ",
	N: "ᴺ",
	O: "ᴼ",
	P: "ᴾ",
	R: "ᴿ",
	T: "ᵀ",
	U: "ᵁ",
	V: "ⱽ",
	W: "ᵂ",
	α: "ᵅ",
	β: "ᵝ",
	γ: "ᵞ",
	δ: "ᵟ",
	ε: "ᵋ",
	θ: "ᶿ",
	ι: "ᶥ",
	φ: "ᵠ",
	χ: "ᵡ",
};

// Unicode subscript forms (even sparser than superscripts).
const SUBSCRIPT: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"−": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	" ": " ",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
	β: "ᵦ",
	γ: "ᵧ",
	ρ: "ᵨ",
	φ: "ᵩ",
	χ: "ᵪ",
};

// Prime runs: f' f'' f''' f''''.
const PRIMES = ["", "′", "″", "‴", "⁗"] as const;

// Common vulgar fractions, keyed by `${num}/${den}` of the rendered parts.
const VULGAR: Record<string, string> = {
	"1/2": "½",
	"1/3": "⅓",
	"2/3": "⅔",
	"1/4": "¼",
	"3/4": "¾",
	"1/5": "⅕",
	"2/5": "⅖",
	"3/5": "⅗",
	"4/5": "⅘",
	"1/6": "⅙",
	"5/6": "⅚",
	"1/7": "⅐",
	"1/8": "⅛",
	"3/8": "⅜",
	"5/8": "⅝",
	"7/8": "⅞",
	"1/9": "⅑",
	"1/10": "⅒",
	"0/3": "↉",
};

// `\not<rel>` negations that have a dedicated Unicode glyph (cleaner than the
// combining-solidus fallback).
const NOT_MAP: Record<string, string> = {
	"=": "≠",
	"<": "≮",
	">": "≯",
	"∈": "∉",
	"∋": "∌",
	"⊂": "⊄",
	"⊃": "⊅",
	"⊆": "⊈",
	"⊇": "⊉",
	"≡": "≢",
	"∃": "∄",
	"≤": "≰",
	"≥": "≱",
	"≈": "≉",
	"≅": "≇",
	"∼": "≁",
	"≃": "≄",
	"∣": "∤",
	"∥": "∦",
	"≺": "⊀",
	"≻": "⊁",
	"⊑": "⋢",
	"⊒": "⋣",
};

// Combining diacritics for accent commands (applied after each base glyph).
const ACCENTS: Record<string, string> = {
	hat: "\u0302",
	widehat: "\u0302",
	check: "\u030C",
	widecheck: "\u030C",
	tilde: "\u0303",
	widetilde: "\u0303",
	acute: "\u0301",
	grave: "\u0300",
	dot: "\u0307",
	ddot: "\u0308",
	dddot: "\u20DB",
	ddddot: "\u20DC",
	breve: "\u0306",
	bar: "\u0304",
	vec: "\u20D7",
	overrightarrow: "\u20D7",
	overleftarrow: "\u20D6",
	mathring: "\u030A",
	overline: "\u0305",
	underline: "\u0332",
	underbar: "\u0332",
};

// Math functions rendered as their literal upright name (sin, cos, lim, …).
const FUNCTIONS: Record<string, true> = {
	sin: true,
	cos: true,
	tan: true,
	cot: true,
	sec: true,
	csc: true,
	sinh: true,
	cosh: true,
	tanh: true,
	coth: true,
	arcsin: true,
	arccos: true,
	arctan: true,
	arccot: true,
	arcsec: true,
	arccsc: true,
	sech: true,
	csch: true,
	ln: true,
	log: true,
	lg: true,
	exp: true,
	lim: true,
	limsup: true,
	liminf: true,
	max: true,
	min: true,
	sup: true,
	inf: true,
	det: true,
	dim: true,
	ker: true,
	hom: true,
	arg: true,
	deg: true,
	gcd: true,
	lcm: true,
	Pr: true,
	argmax: true,
	argmin: true,
	sgn: true,
	tr: true,
	rank: true,
	diag: true,
	var: true,
	cov: true,
	median: true,
	mod: true,
};

// Math-mode font commands → Mathematical Alphanumeric Symbols style.
type FontStyle =
	| "bold"
	| "italic"
	| "bolditalic"
	| "script"
	| "boldscript"
	| "fraktur"
	| "doublestruck"
	| "boldfraktur"
	| "sans"
	| "sansbold"
	| "sansitalic"
	| "sansbolditalic"
	| "mono";

const FONTS: Record<string, FontStyle> = {
	mathbf: "bold",
	boldsymbol: "bolditalic",
	bm: "bolditalic",
	pmb: "bold",
	mathbb: "doublestruck",
	Bbb: "doublestruck",
	mathds: "doublestruck",
	mathbbm: "doublestruck",
	mathcal: "script",
	mathscr: "boldscript",
	mathfrak: "fraktur",
	mathbfscr: "boldscript",
	mathbfcal: "boldscript",
	mathbffrak: "boldfraktur",
	mathfrakbold: "boldfraktur",
	mathsf: "sans",
	mathsfit: "sansitalic",
	mathsfbf: "sansbold",
	mathbfsf: "sansbold",
	mathsfbfit: "sansbolditalic",
	mathbfsfit: "sansbolditalic",
	mathtt: "mono",
	mathit: "italic",
	mathbfit: "bolditalic",
	textbf: "bold",
	textit: "italic",
	texttt: "mono",
	textsf: "sans",
};

// Text-mode commands whose argument is passed through literally (no math).
const TEXT_COMMANDS: Record<string, true> = {
	text: true,
	textrm: true,
	textnormal: true,
	textup: true,
	textmd: true,
	textsc: true,
	textsl: true,
	emph: true,
	mathrm: true,
	mathnormal: true,
	mbox: true,
	hbox: true,
};

// Base code points for each style's A, a, and (where it exists) 0 in the
// Mathematical Alphanumeric Symbols block (U+1D400–U+1D7FF).
interface Plane {
	upper: number;
	lower: number;
	digit?: number;
}
const PLANES: Record<FontStyle, Plane> = {
	bold: { upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
	italic: { upper: 0x1d434, lower: 0x1d44e },
	bolditalic: { upper: 0x1d468, lower: 0x1d482 },
	script: { upper: 0x1d49c, lower: 0x1d4b6 },
	boldscript: { upper: 0x1d4d0, lower: 0x1d4ea },
	fraktur: { upper: 0x1d504, lower: 0x1d51e },
	doublestruck: { upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8 },
	boldfraktur: { upper: 0x1d56c, lower: 0x1d586 },
	sans: { upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
	sansbold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
	sansitalic: { upper: 0x1d608, lower: 0x1d622 },
	sansbolditalic: { upper: 0x1d63c, lower: 0x1d656 },
	mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
};

// Reserved code points in the math alphabets that Unicode places in the
// Letterlike Symbols block instead (the famous "holes").
const ALPHA_HOLES: Record<string, string> = {
	"italic:h": "ℎ",
	"script:B": "ℬ",
	"script:E": "ℰ",
	"script:F": "ℱ",
	"script:H": "ℋ",
	"script:I": "ℐ",
	"script:L": "ℒ",
	"script:M": "ℳ",
	"script:R": "ℛ",
	"script:e": "ℯ",
	"script:g": "ℊ",
	"script:o": "ℴ",
	"fraktur:C": "ℭ",
	"fraktur:H": "ℌ",
	"fraktur:I": "ℑ",
	"fraktur:R": "ℜ",
	"fraktur:Z": "ℨ",
	"doublestruck:C": "ℂ",
	"doublestruck:H": "ℍ",
	"doublestruck:N": "ℕ",
	"doublestruck:P": "ℙ",
	"doublestruck:Q": "ℚ",
	"doublestruck:R": "ℝ",
	"doublestruck:Z": "ℤ",
};

// Matrix/cases environment delimiters: [open, close].
const ENV_DELIMS: Record<string, readonly [string, string]> = {
	matrix: ["", ""],
	smallmatrix: ["", ""],
	array: ["", ""],
	tabular: ["", ""],
	pmatrix: ["(", ")"],
	bmatrix: ["[", "]"],
	Bmatrix: ["{", "}"],
	vmatrix: ["|", "|"],
	Vmatrix: ["‖", "‖"],
	cases: ["{", ""],
	"cases*": ["{", ""],
	dcases: ["{", ""],
	"dcases*": ["{", ""],
	rcases: ["", "}"],
	drcases: ["", "}"],
	aligned: ["", ""],
	"aligned*": ["", ""],
	alignedat: ["", ""],
	"alignedat*": ["", ""],
	align: ["", ""],
	"align*": ["", ""],
	alignat: ["", ""],
	"alignat*": ["", ""],
	split: ["", ""],
	gathered: ["", ""],
	equation: ["", ""],
	"equation*": ["", ""],
};

// Greek, operators, relations, arrows, delimiters, and assorted symbols.
const SYMBOLS: Record<string, string> = {
	// Greek lowercase
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ϵ",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	varkappa: "ϰ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	omicron: "ο",
	pi: "π",
	varpi: "ϖ",
	rho: "ρ",
	varrho: "ϱ",
	sigma: "σ",
	varsigma: "ς",
	tau: "τ",
	upsilon: "υ",
	phi: "ϕ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	digamma: "ϝ",
	// Greek uppercase
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	// Big operators
	sum: "∑",
	prod: "∏",
	coprod: "∐",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	iiiint: "⨌",
	oint: "∮",
	oiint: "∯",
	oiiint: "∰",
	bigcap: "⋂",
	bigcup: "⋃",
	bigsqcup: "⨆",
	bigvee: "⋁",
	bigwedge: "⋀",
	bigodot: "⨀",
	bigoplus: "⨁",
	bigotimes: "⨂",
	biguplus: "⨄",
	Cap: "⋒",
	Cup: "⋓",
	bigstar: "★",
	// Binary operators
	pm: "±",
	mp: "∓",
	times: "×",
	div: "÷",
	ast: "∗",
	star: "⋆",
	circ: "∘",
	bullet: "∙",
	cdot: "⋅",
	cdotp: "·",
	centerdot: "·",
	cap: "∩",
	cup: "∪",
	uplus: "⊎",
	sqcap: "⊓",
	sqcup: "⊔",
	vee: "∨",
	wedge: "∧",
	land: "∧",
	lor: "∨",
	setminus: "∖",
	smallsetminus: "∖",
	wr: "≀",
	amalg: "⨿",
	diamond: "⋄",
	Diamond: "◇",
	bigtriangleup: "△",
	bigtriangledown: "▽",
	triangleleft: "◁",
	triangleright: "▷",
	lhd: "⊲",
	rhd: "⊳",
	unlhd: "⊴",
	unrhd: "⊵",
	oplus: "⊕",
	ominus: "⊖",
	otimes: "⊗",
	oslash: "⊘",
	odot: "⊙",
	dagger: "†",
	ddagger: "‡",
	boxplus: "⊞",
	boxtimes: "⊠",
	boxdot: "⊡",
	boxminus: "⊟",
	ltimes: "⋉",
	rtimes: "⋊",
	leftthreetimes: "⋋",
	rightthreetimes: "⋌",
	curlyvee: "⋎",
	curlywedge: "⋏",
	barwedge: "⊼",
	veebar: "⊻",
	doublebarwedge: "⩞",
	circledast: "⊛",
	circledcirc: "⊚",
	circleddash: "⊝",
	divideontimes: "⋇",
	dotplus: "∔",
	// Relations
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	ll: "≪",
	gg: "≫",
	neq: "≠",
	ne: "≠",
	equiv: "≡",
	doteq: "≐",
	sim: "∼",
	simeq: "≃",
	approx: "≈",
	approxeq: "≊",
	cong: "≅",
	propto: "∝",
	asymp: "≍",
	prec: "≺",
	succ: "≻",
	preceq: "⪯",
	succeq: "⪰",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	subsetneq: "⊊",
	supsetneq: "⊋",
	sqsubset: "⊏",
	sqsupset: "⊐",
	sqsubseteq: "⊑",
	sqsupseteq: "⊒",
	in: "∈",
	ni: "∋",
	owns: "∋",
	notin: "∉",
	mid: "∣",
	nmid: "∤",
	parallel: "∥",
	nparallel: "∦",
	perp: "⊥",
	vdash: "⊢",
	dashv: "⊣",
	models: "⊨",
	vDash: "⊨",
	Vdash: "⊩",
	bowtie: "⋈",
	smile: "⌣",
	frown: "⌢",
	between: "≬",
	lessgtr: "≶",
	gtrless: "≷",
	leqslant: "⩽",
	geqslant: "⩾",
	lesssim: "≲",
	gtrsim: "≳",
	lessapprox: "⪅",
	gtrapprox: "⪆",
	leqq: "≦",
	geqq: "≧",
	lneq: "⪇",
	gneq: "⪈",
	lneqq: "≨",
	gneqq: "≩",
	nleq: "≰",
	ngeq: "≱",
	nless: "≮",
	ngtr: "≯",
	nsubseteq: "⊈",
	nsupseteq: "⊉",
	nsim: "≁",
	ncong: "≇",
	triangleq: "≜",
	coloneqq: "≔",
	eqqcolon: "≕",
	risingdotseq: "≓",
	fallingdotseq: "≒",
	circeq: "≗",
	eqcirc: "≖",
	precsim: "≾",
	succsim: "≿",
	precapprox: "⪷",
	succapprox: "⪸",
	curlyeqprec: "⋞",
	curlyeqsucc: "⋟",
	Subset: "⋐",
	Supset: "⋑",
	subeq: "⊆",
	supeq: "⊇",
	subeqq: "⫅",
	supeqq: "⫆",
	subsetneqq: "⫋",
	supsetneqq: "⫌",
	Vvdash: "⊪",
	shortmid: "∣",
	shortparallel: "∥",
	pitchfork: "⋔",
	// Arrows
	leftarrow: "←",
	gets: "←",
	rightarrow: "→",
	to: "→",
	leftrightarrow: "↔",
	Leftarrow: "⇐",
	Rightarrow: "⇒",
	Leftrightarrow: "⇔",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	Uparrow: "⇑",
	Downarrow: "⇓",
	Updownarrow: "⇕",
	mapsto: "↦",
	longmapsto: "⟼",
	hookleftarrow: "↩",
	hookrightarrow: "↪",
	leftharpoonup: "↼",
	rightharpoonup: "⇀",
	leftharpoondown: "↽",
	rightharpoondown: "⇁",
	rightleftharpoons: "⇌",
	longleftarrow: "⟵",
	longrightarrow: "⟶",
	longleftrightarrow: "⟷",
	Longleftarrow: "⟸",
	Longrightarrow: "⟹",
	Longleftrightarrow: "⟺",
	implies: "⟹",
	impliedby: "⟸",
	iff: "⟺",
	nearrow: "↗",
	searrow: "↘",
	swarrow: "↙",
	nwarrow: "↖",
	nleftarrow: "↚",
	nrightarrow: "↛",
	leadsto: "⇝",
	rightsquigarrow: "⇝",
	leftrightsquigarrow: "↭",
	twoheadrightarrow: "↠",
	twoheadleftarrow: "↞",
	leftrightharpoons: "⇋",
	rightleftarrows: "⇄",
	leftrightarrows: "⇆",
	leftleftarrows: "⇇",
	rightrightarrows: "⇉",
	upuparrows: "⇈",
	downdownarrows: "⇊",
	circlearrowleft: "↺",
	circlearrowright: "↻",
	curvearrowleft: "↶",
	curvearrowright: "↷",
	dashleftarrow: "⇠",
	dashrightarrow: "⇢",
	Lleftarrow: "⇚",
	Rrightarrow: "⇛",
	leftarrowtail: "↢",
	rightarrowtail: "↣",
	looparrowleft: "↫",
	looparrowright: "↬",
	multimap: "⊸",
	// Miscellaneous
	infty: "∞",
	partial: "∂",
	nabla: "∇",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	emptyset: "∅",
	varnothing: "∅",
	neg: "¬",
	lnot: "¬",
	top: "⊤",
	bot: "⊥",
	angle: "∠",
	measuredangle: "∡",
	sphericalangle: "∢",
	aleph: "ℵ",
	beth: "ℶ",
	gimel: "ℷ",
	daleth: "ℸ",
	hbar: "ℏ",
	hslash: "ℏ",
	ell: "ℓ",
	imath: "ı",
	jmath: "ȷ",
	wp: "℘",
	Re: "ℜ",
	Im: "ℑ",
	mho: "℧",
	complement: "∁",
	surd: "√",
	flat: "♭",
	natural: "♮",
	sharp: "♯",
	clubsuit: "♣",
	diamondsuit: "♦",
	heartsuit: "♥",
	spadesuit: "♠",
	clubs: "♣",
	diamonds: "♦",
	hearts: "♥",
	spades: "♠",
	therefore: "∴",
	because: "∵",
	checkmark: "✓",
	maltese: "✠",
	dag: "†",
	ddag: "‡",
	S: "§",
	P: "¶",
	copyright: "©",
	circledR: "®",
	pounds: "£",
	yen: "¥",
	euro: "€",
	degree: "°",
	prime: "′",
	backprime: "‵",
	colon: ":",
	semicolon: ";",
	neper: "₪",
	square: "□",
	Box: "□",
	blacksquare: "■",
	lozenge: "◊",
	blacklozenge: "⧫",
	triangle: "△",
	blacktriangle: "▴",
	blacktriangledown: "▾",
	blacktriangleleft: "◂",
	blacktriangleright: "▸",
	diagup: "╱",
	diagdown: "╲",
	backepsilon: "϶",
	Game: "⅁",
	eth: "ð",
	// Dots & ellipses
	ldots: "…",
	dots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	hdots: "…",
	mathellipsis: "…",
	dotsc: "…",
	dotsb: "⋯",
	dotsm: "⋯",
	dotsi: "⋯",
	// Delimiters
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	lbrace: "{",
	rbrace: "}",
	lbrack: "[",
	rbrack: "]",
	vert: "|",
	Vert: "‖",
	lvert: "|",
	rvert: "|",
	lVert: "‖",
	rVert: "‖",
	backslash: "\\",
	slash: "/",
	ulcorner: "⌜",
	urcorner: "⌝",
	llcorner: "⌞",
	lrcorner: "⌟",
	lmoustache: "⎰",
	rmoustache: "⎱",
	lgroup: "⟮",
	rgroup: "⟯",
	bracevert: "⎪",
	// Blackboard / letterlike shortcuts commonly written bare
	Reals: "ℝ",
	Complex: "ℂ",
	Natural: "ℕ",
	Integer: "ℤ",
	Rational: "ℚ",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map every code point of `text` through `table`; null if any is unmappable. */
function mapAll(text: string, table: Record<string, string>): string | null {
	let out = "";
	for (const ch of text) {
		const mapped = table[ch];
		if (mapped === undefined) return null;
		out += mapped;
	}
	return out;
}

/** Number of Unicode code points (not UTF-16 units) in `s`. */
function codePointLength(s: string): number {
	let n = 0;
	for (const _ of s) n++;
	return n;
}

/** Style a single ASCII letter/digit via the math alphanumeric block. */
function styleAlnum(ch: string, style: FontStyle): string {
	const hole = ALPHA_HOLES[`${style}:${ch}`];
	if (hole) return hole;
	const plane = PLANES[style];
	const code = ch.charCodeAt(0);
	if (code >= 65 && code <= 90) return String.fromCodePoint(plane.upper + (code - 65));
	if (code >= 97 && code <= 122) return String.fromCodePoint(plane.lower + (code - 97));
	if (code >= 48 && code <= 57 && plane.digit !== undefined) return String.fromCodePoint(plane.digit + (code - 48));
	return ch;
}

/** Identity, or math-alphanumeric styling when a font style is active. */
function styleChar(ch: string, style: FontStyle | null): string {
	if (style === null) return ch;
	const code = ch.charCodeAt(0);
	const isAlnum = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
	return isAlnum ? styleAlnum(ch, style) : ch;
}

/** Append a combining mark after each non-space base glyph (accents/radicals). */
function applyCombining(text: string, mark: string): string {
	let out = "";
	for (const ch of text) out += ch === " " ? ch : ch + mark;
	return out;
}

/** Light unescape for text-mode content (`\&` → `&`, `~` → space). */
function unescapeText(s: string): string {
	return s.replace(/\\([&%$#_{}\s])/g, "$1").replace(/~/g, " ");
}

function toSuperscript(text: string, group: boolean): string {
	if (text === "") return "";
	const mapped = mapAll(text, SUPERSCRIPT);
	if (mapped !== null) return mapped;
	return group ? `^(${text})` : `^${text}`;
}

function toSubscript(text: string, group: boolean): string {
	if (text === "") return "";
	const mapped = mapAll(text, SUBSCRIPT);
	if (mapped !== null) return mapped;
	return group ? `_(${text})` : `_${text}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Argument {
	text: string;
	/** True when the argument came from a `{…}` group (affects fraction/script parens). */
	group: boolean;
}

const BIG_DELIM = /^(?:[bB]igg?|[bB]igg?[lrm])$/;

const EXTENSIBLE_ARROWS: Record<string, string> = {
	xleftarrow: "←",
	xrightarrow: "→",
	xleftrightarrow: "↔",
	xLeftarrow: "⇐",
	xRightarrow: "⇒",
	xLeftrightarrow: "⇔",
	xhookleftarrow: "↩",
	xhookrightarrow: "↪",
	xtwoheadleftarrow: "↞",
	xtwoheadrightarrow: "↠",
	xmapsto: "↦",
	xrightharpoonup: "⇀",
	xrightharpoondown: "⇁",
	xleftharpoonup: "↼",
	xleftharpoondown: "↽",
	xrightleftharpoons: "⇌",
	xleftrightharpoons: "⇋",
};

class LatexParser {
	#s: string;
	#i = 0;

	constructor(src: string) {
		this.#s = src;
	}

	/** Parse a run until end-of-input, or until `}` when `stopAtBrace`. */
	parse(style: FontStyle | null, stopAtBrace: boolean): string {
		let out = "";
		while (this.#i < this.#s.length) {
			const c = this.#s[this.#i];
			if (c === "}") {
				if (stopAtBrace) break;
				this.#i++; // stray close brace
				continue;
			}
			out += this.#node(style);
		}
		return out;
	}

	#node(style: FontStyle | null): string {
		const c = this.#s[this.#i];
		switch (c) {
			case "\\":
				return this.#command(style);
			case "{": {
				this.#i++;
				const inner = this.parse(style, true);
				if (this.#s[this.#i] === "}") this.#i++;
				return inner;
			}
			case "^":
				this.#i++;
				return this.#script(style, true);
			case "_":
				this.#i++;
				return this.#script(style, false);
			case "$":
				this.#i++;
				return ""; // stray delimiter
			case "~":
				this.#i++;
				return " "; // non-breaking space
			case "&":
				this.#i++;
				return "  "; // column separator
			case "'": {
				let k = 0;
				while (this.#s[this.#i] === "'") {
					k++;
					this.#i++;
				}
				return k <= 4 ? PRIMES[k] : PRIMES[1].repeat(k);
			}
			case "%": {
				const nl = this.#s.indexOf("\n", this.#i);
				this.#i = nl === -1 ? this.#s.length : nl + 1;
				return "";
			}
			default:
				this.#i++;
				return styleChar(c, style);
		}
	}

	#command(style: FontStyle | null): string {
		this.#i++; // past backslash
		if (this.#i >= this.#s.length) return "";
		const c = this.#s[this.#i];
		if (!/[A-Za-z]/.test(c)) {
			this.#i++;
			switch (c) {
				case "\\":
					return "\n"; // row break
				case "{":
				case "}":
				case "$":
				case "%":
				case "&":
				case "#":
				case "_":
				case " ":
				case ".":
					return c;
				case ",":
				case ":":
				case ";":
				case ">":
					return " "; // spacing
				case "!":
					return ""; // negative thin space
				case "/":
					return ""; // italic correction
				case "|":
					return "‖";
				case "(":
				case ")":
				case "[":
				case "]":
					return ""; // bare math delimiters that slipped through
				default:
					return c;
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i])) {
			name += this.#s[this.#i];
			this.#i++;
		}
		if (this.#s[this.#i] === "*") this.#i++; // starred variants (operatorname*, …)
		return this.#applyCommand(name, style);
	}

	#applyCommand(name: string, style: FontStyle | null): string {
		// Fonts: reparse the argument under the requested style.
		const font = FONTS[name];
		if (font) return this.#argument(font).text;

		if (TEXT_COMMANDS[name]) return unescapeText(this.#rawArgument());

		if (name === "operatorname") {
			const fn = unescapeText(this.#rawArgument());
			return fn + this.#spaceBeforeArg();
		}

		// Accents → combining marks over each glyph.
		const accent = ACCENTS[name];
		if (accent) return applyCombining(this.#argument(style).text, accent);

		if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
			const num = this.#argument(style);
			const den = this.#argument(style);
			return this.#fraction(num, den);
		}

		if (name === "genfrac") {
			const left = this.#argument(style).text;
			const right = this.#argument(style).text;
			this.#rawArgument(); // rule thickness
			this.#rawArgument(); // math style
			const num = this.#argument(style);
			const den = this.#argument(style);
			return left + this.#fraction(num, den) + right;
		}

		if (name === "binom" || name === "dbinom" || name === "tbinom") {
			const n = this.#argument(style);
			const k = this.#argument(style);
			return `C(${n.text}, ${k.text})`;
		}

		if (name === "sqrt") return this.#sqrt(style);

		if (name === "not") {
			const arg = this.#argument(style);
			return NOT_MAP[arg.text] ?? applyCombining(arg.text, "\u0338");
		}

		if (name === "overset" || name === "stackrel") return this.#scriptedAbove(style);
		if (name === "underset") return this.#scriptedBelow(style);
		if (name === "prescript") return this.#prescript(style);

		const arrow = EXTENSIBLE_ARROWS[name];
		if (arrow !== undefined) return this.#extensibleArrow(style, arrow);

		if (name === "boxed" || name === "fbox") return `[${this.#argument(style).text}]`;
		if (name === "overbrace") return `⏞(${this.#argument(style).text})`;
		if (name === "underbrace") return `⏟(${this.#argument(style).text})`;
		if (name === "overbracket") return `⎴(${this.#argument(style).text})`;
		if (name === "underbracket") return `⎵(${this.#argument(style).text})`;
		if (name === "overparen") return `⏜(${this.#argument(style).text})`;
		if (name === "underparen") return `⏝(${this.#argument(style).text})`;
		if (name === "cancel") return applyCombining(this.#argument(style).text, "\u0338");
		if (name === "bcancel") return applyCombining(this.#argument(style).text, "\u20E5");
		if (name === "xcancel") return applyCombining(applyCombining(this.#argument(style).text, "\u0338"), "\u20E5");
		if (name === "sout") return applyCombining(this.#argument(style).text, "\u0336");
		if (name === "substack") return this.#argument(style).text.replace(NEWLINES, ",");

		if (name === "left" || name === "right" || name === "middle") return this.#delimiter(style);

		if (BIG_DELIM.test(name)) return this.#delimiter(style); // \big \Bigl \Biggr …

		if (name === "begin") return this.#environment(style);
		if (name === "end") {
			this.#rawArgument();
			return "";
		}

		if (name === "bmod") return " mod ";
		if (name === "pmod") return `(mod ${this.#argument(style).text})`;
		if (name === "pod") return `(${this.#argument(style).text})`;
		if (name === "tag") return `(${this.#argument(style).text})`;
		if (name === "label") {
			this.#rawArgument();
			return "";
		}
		if (name === "ref" || name === "eqref") return `(${unescapeText(this.#rawArgument())})`;
		if (name === "url") return unescapeText(this.#rawArgument());
		if (name === "href") {
			this.#rawArgument();
			return this.#argument(style).text;
		}
		if (name === "textcolor") {
			this.#rawArgument();
			return this.#argument(style).text;
		}
		if (name === "color") {
			this.#rawArgument();
			return "";
		}

		if (FUNCTIONS[name]) return name + this.#spaceBeforeArg();

		const symbol = SYMBOLS[name];
		if (symbol !== undefined) return symbol;

		// Layout-only commands that carry no visible glyph.
		switch (name) {
			case "displaystyle":
			case "textstyle":
			case "scriptstyle":
			case "scriptscriptstyle":
			case "limits":
			case "nolimits":
			case "nonumber":
			case "notag":
			case "quad":
				return name === "quad" ? "  " : "";
			case "qquad":
				return "    ";
			case "thinspace":
			case "enspace":
			case "medspace":
			case "thickspace":
			case "space":
				return " ";
			case "negthinspace":
			case "negmedspace":
			case "negthickspace":
				return "";
		}

		// Unknown command: surface the bare name rather than dropping it silently.
		return name;
	}

	/** Read one argument: a `{…}` group, a single command, or a single char. */
	#argument(style: FontStyle | null): Argument {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === undefined) return { text: "", group: false };
		if (c === "{") {
			this.#i++;
			const inner = this.parse(style, true);
			if (this.#s[this.#i] === "}") this.#i++;
			return { text: inner, group: true };
		}
		if (c === "\\") return { text: this.#command(style), group: false };
		if (c === "^" || c === "_") {
			// Bare script with no base (e.g. `{}^{n}`): treat the script as the arg.
			this.#i++;
			return { text: this.#script(style, c === "^"), group: false };
		}
		this.#i++;
		return { text: styleChar(c, style), group: false };
	}

	/** Read a raw (unparsed) argument, returning its literal source text. */
	#rawArgument(): string {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "{") {
			const c = this.#s[this.#i];
			if (c === undefined) return "";
			if (c === "\\") {
				let t = "\\";
				this.#i++;
				if (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
					while (/[A-Za-z]/.test(this.#s[this.#i] ?? "")) {
						t += this.#s[this.#i];
						this.#i++;
					}
				} else {
					t += this.#s[this.#i] ?? "";
					this.#i++;
				}
				return t;
			}
			this.#i++;
			return c;
		}
		this.#i++; // past {
		let depth = 1;
		let out = "";
		while (this.#i < this.#s.length && depth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				out += c + (this.#s[this.#i + 1] ?? "");
				this.#i += 2;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) {
					this.#i++;
					break;
				}
			}
			out += c;
			this.#i++;
		}
		return out;
	}

	#script(style: FontStyle | null, sup: boolean): string {
		const arg = this.#argument(style);
		return sup ? toSuperscript(arg.text, arg.group) : toSubscript(arg.text, arg.group);
	}

	#wrapFrac(arg: Argument): string {
		return arg.group && codePointLength(arg.text) > 1 ? `(${arg.text})` : arg.text;
	}

	#fraction(num: Argument, den: Argument): string {
		const vulgar = VULGAR[`${num.text}/${den.text}`];
		if (vulgar) return vulgar;
		return `${this.#wrapFrac(num)}/${this.#wrapFrac(den)}`;
	}

	#scriptedAbove(style: FontStyle | null): string {
		const above = this.#argument(style);
		const base = this.#argument(style);
		return base.text + toSuperscript(above.text, true);
	}

	#scriptedBelow(style: FontStyle | null): string {
		const below = this.#argument(style);
		const base = this.#argument(style);
		return base.text + toSubscript(below.text, true);
	}

	#prescript(style: FontStyle | null): string {
		const sup = this.#argument(style);
		const sub = this.#argument(style);
		const base = this.#argument(style);
		return toSuperscript(sup.text, true) + toSubscript(sub.text, true) + base.text;
	}

	#extensibleArrow(style: FontStyle | null, arrow: string): string {
		const below = this.#optionalArgument(style);
		const above = this.#argument(style);
		return arrow + toSuperscript(above.text, true) + (below ? toSubscript(below.text, true) : "");
	}

	#delimiter(style: FontStyle | null): string {
		while (this.#s[this.#i] === " ") this.#i++;
		const c = this.#s[this.#i];
		if (c === undefined) return "";
		if (c === ".") {
			this.#i++;
			return "";
		}
		if (c !== "\\") {
			this.#i++;
			return styleChar(c, style);
		}
		this.#i++;
		if (this.#i >= this.#s.length) return "";
		const d = this.#s[this.#i];
		if (!/[A-Za-z]/.test(d)) {
			this.#i++;
			switch (d) {
				case ".":
					return "";
				case "{":
					return "{";
				case "}":
					return "}";
				case "|":
					return "‖";
				default:
					return d;
			}
		}
		let name = "";
		while (this.#i < this.#s.length && /[A-Za-z]/.test(this.#s[this.#i])) {
			name += this.#s[this.#i];
			this.#i++;
		}
		return SYMBOLS[name] ?? name;
	}

	#optionalArgument(style: FontStyle | null): Argument | null {
		const source = this.#optionalRawArgument();
		if (source === null) return null;
		return { text: new LatexParser(source).parse(style, false), group: true };
	}

	#optionalRawArgument(): string | null {
		while (this.#s[this.#i] === " ") this.#i++;
		if (this.#s[this.#i] !== "[") return null;
		this.#i++;
		let bracketDepth = 1;
		let braceDepth = 0;
		let out = "";
		while (this.#i < this.#s.length && bracketDepth > 0) {
			const c = this.#s[this.#i];
			if (c === "\\") {
				out += c + (this.#s[this.#i + 1] ?? "");
				this.#i += 2;
				continue;
			}
			if (c === "{") braceDepth++;
			else if (c === "}" && braceDepth > 0) braceDepth--;
			else if (braceDepth === 0 && c === "[") bracketDepth++;
			else if (braceDepth === 0 && c === "]") {
				bracketDepth--;
				if (bracketDepth === 0) {
					this.#i++;
					break;
				}
			}
			out += c;
			this.#i++;
		}
		return out;
	}

	#sqrt(style: FontStyle | null): string {
		while (this.#s[this.#i] === " ") this.#i++;
		let radical = "√";
		if (this.#s[this.#i] === "[") {
			const close = this.#s.indexOf("]", this.#i + 1);
			if (close !== -1) {
				const index = latexToUnicode(this.#s.slice(this.#i + 1, close));
				this.#i = close + 1;
				radical =
					index === "2" ? "√" : index === "3" ? "∛" : index === "4" ? "∜" : `${toSuperscript(index, false)}√`;
			}
		}
		const radicand = this.#argument(style).text;
		return radical + (codePointLength(radicand) > 1 ? `(${radicand})` : radicand);
	}

	#environment(style: FontStyle | null): string {
		const env = this.#rawArgument().trim();
		if (env === "array" || env === "tabular" || env === "array*" || env === "tabular*") {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument(); // column spec
		} else if (
			env === "alignedat" || env === "alignedat*" || env === "alignat" || env === "alignat*" || env === "gatheredat"
		) {
			this.#optionalRawArgument();
			if (this.#s[this.#i] === "{") this.#rawArgument(); // column count
		}
		let body = "";
		while (this.#i < this.#s.length) {
			if (this.#s.startsWith("\\end", this.#i)) {
				this.#i += 4;
				this.#rawArgument();
				break;
			}
			body += this.#node(style);
		}
		body = body.trim();
		const delims = ENV_DELIMS[env];
		return delims ? delims[0] + body + delims[1] : body;
	}

	/** A separator space when the next glyph is alphanumeric or a command. */
	#spaceBeforeArg(): string {
		const c = this.#s[this.#i];
		if (c === undefined) return "";
		return /[A-Za-z0-9\\]/.test(c) ? " " : "";
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a bare LaTeX math fragment (no surrounding `$`/`\(` delimiters) to its
 * best-effort Unicode rendering. Unknown commands degrade to their bare name;
 * `\\` becomes a newline. Always returns a string (never throws).
 */
export function latexToUnicode(src: string): string {
	if (typeof src !== "string" || src.length === 0) return src;
	return new LatexParser(src).parse(null, false);
}

const NEWLINES = /\n+/g;

/**
 * Scan prose for math spans — `$$…$$`, `\[…\]` (display) and `$…$`, `\(…\)`
 * (inline) — and replace each with its Unicode rendering, leaving everything
 * else verbatim. Newlines inside a span collapse to spaces so the result stays
 * single-line-safe.
 *
 * Inline `$…$` uses pandoc's anti-currency heuristics: the opener must not be
 * followed by whitespace, the closer must not be preceded by whitespace nor
 * followed by a digit, and `\$` is treated as a literal dollar — so "$5 and
 * $10" is left untouched.
 */
export function renderMathInText(text: string): string {
	if (typeof text !== "string" || text.length === 0) return text;
	if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;

	const conv = (inner: string): string => latexToUnicode(inner).replace(NEWLINES, " ");
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\\") {
			const d = text[i + 1];
			if (d === "\\") {
				// Escaped backslash: emit verbatim so a following `(`/`[` is plain text.
				out += "\\\\";
				i += 2;
				continue;
			}
			if (d === "(") {
				const close = text.indexOf("\\)", i + 2);
				if (close !== -1) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
			} else if (d === "[") {
				const close = text.indexOf("\\]", i + 2);
				if (close !== -1) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
			} else if (d === "$") {
				out += "$";
				i += 2;
				continue;
			}
			out += c;
			i++;
			continue;
		}
		if (c === "$") {
			if (text[i + 1] === "$") {
				const close = text.indexOf("$$", i + 2);
				if (close !== -1 && text.slice(i + 2, close).trim().length > 0) {
					out += conv(text.slice(i + 2, close));
					i = close + 2;
					continue;
				}
				out += "$$";
				i += 2;
				continue;
			}
			const close = inlineMathSpanEnd(text, i);
			if (close !== -1) {
				out += conv(text.slice(i + 1, close));
				i = close + 1;
				continue;
			}
			out += "$";
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * Index of the `$` that closes an inline math span opened at `open` (the index
 * of the opening `$`), or -1 when the run is not inline math. Applies pandoc's
 * anti-currency heuristics: the opener must not be followed by whitespace, the
 * closer must not be preceded by whitespace nor followed by a digit, `\$` is a
 * literal dollar, and the span may not span a newline. Shared by
 * `renderMathInText` and the markdown math tokenizer so the rule has one home.
 */
export function inlineMathSpanEnd(text: string, open: number): number {
	const after = text[open + 1];
	if (after === undefined || after === " " || after === "\t" || after === "\n" || after === "$") {
		return -1;
	}
	for (let j = open + 1; j < text.length; j++) {
		const ch = text[j];
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === "\n") return -1;
		if (ch === "$") {
			const prev = text[j - 1];
			if (prev === " " || prev === "\t") return -1;
			const next = text[j + 1];
			if (next !== undefined && next >= "0" && next <= "9") continue; // currency: keep scanning
			return text.slice(open + 1, j).trim().length > 0 ? j : -1;
		}
	}
	return -1;
}
