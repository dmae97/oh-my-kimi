/**
 * Conservative secret redaction for tool output. Patterns target well-known
 * shapes (AWS key IDs, GitHub tokens, Slack tokens, OpenAI-style keys, JWTs,
 * Authorization headers) plus an env-style `KEY=VALUE` heuristic restricted to
 * key names that explicitly mention SECRET / TOKEN / PASSWORD / API_KEY /
 * PRIVATE_KEY.
 *
 * Replacement is `#REDACTED:<hint>#` so the model can tell what shape was
 * scrubbed without leaking the value. All patterns are ASCII-only, so the
 * UTF-16 backed `String#replace` will never split a surrogate pair.
 */

// Authorization header: keep the scheme, redact the credential.
const AUTH_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._+/=-]{8,}/g;

// Env-style assignment: only fires when the key name itself is sensitive.
// `\b` (not `^`) so it works inside anchored read output (e.g. `12ab|FOO=…`).
const ENV_RE = /(\b\w*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY)\w*\b\s*[=:]\s*)(["']?)([^\s"']{6,})\2/gi;

// Known token shapes. Order inside the alternation doesn't matter — they're
// disjoint by prefix.
const TOKEN_RE =
	/(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}|(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}|xox[abprs]-[0-9]+-[0-9]+-[0-9]+-[a-zA-Z0-9]+|sk-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

function shapeHintForToken(match: string): string {
	if (/^(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)/.test(match)) return "aws";
	if (/^(?:ghp|gho|ghu|ghs|ghr|github_pat)_/.test(match)) return "gh";
	if (/^xox[abprs]-/.test(match)) return "slack";
	if (match.startsWith("sk-")) return "openai";
	if (match.startsWith("eyJ")) return "jwt";
	return "token";
}

/**
 * Redact apparent secrets in `text`. Returns the rewritten text and the number
 * of distinct matches that were replaced. Order:
 *   1. env-style `KEY=VALUE` (keeps the key, replaces the value),
 *   2. `Authorization: Bearer/Basic …` (keeps the scheme),
 *   3. known token shapes (whole match replaced).
 * Running env/auth before tokens prevents double-counting when both could fire.
 */
export function redactSecrets(text: string): { text: string; redactedCount: number } {
	if (!text) return { text, redactedCount: 0 };
	let count = 0;

	let out = text.replace(ENV_RE, (_match, prefix: string, _quote: string, _value: string) => {
		count += 1;
		return `${prefix}#REDACTED:env#`;
	});

	out = out.replace(AUTH_RE, (_match, scheme: string) => {
		count += 1;
		return `${scheme} #REDACTED:auth#`;
	});

	out = out.replace(TOKEN_RE, (match: string) => {
		count += 1;
		return `#REDACTED:${shapeHintForToken(match)}#`;
	});

	return { text: out, redactedCount: count };
}

/**
 * Footer appended to redacted tool output so the model knows the text was
 * modified. Empty string when nothing was redacted.
 */
export function redactionFooter(redactedCount: number): string {
	if (redactedCount <= 0) return "";
	const noun = redactedCount === 1 ? "value" : "values";
	return `[redacted ${redactedCount} secret-like ${noun}]`;
}
