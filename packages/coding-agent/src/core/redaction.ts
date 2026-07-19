/** Mask high-confidence credentials before user text reaches the model or session. */

const REDACTED = "[REDACTED]";
const SECRET_VALUE_NAME =
	"(?:(?:[a-z0-9]+[_-])?(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password))";

const QUOTED_SECRET_VALUE_PATTERN = new RegExp(
	`(["']?\\b${SECRET_VALUE_NAME}["']?\\s*[:=]\\s*)(["'])([^"']*)\\2`,
	"gi",
);
const UNQUOTED_SECRET_VALUE_PATTERN = new RegExp(
	`(["']?\\b${SECRET_VALUE_NAME}["']?\\s*[:=]\\s*)([^\\s"',;}&]+)`,
	"gi",
);
const BEARER_TOKEN_PATTERN = /(\b(?:authorization|proxy-authorization)\s*:\s*Bearer\s+)([^\s"',;<>]+)/gi;
const KNOWN_CREDENTIAL_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{20,}\b/g,
	/\bAIza[A-Za-z0-9_-]{20,}\b/g,
	/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
	/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
] as const;

/**
 * Replace high-confidence credential values while preserving their surrounding
 * context. This deliberately avoids generic entropy-based matching so ordinary
 * identifiers and prose remain unchanged.
 */
export function redactSensitiveText(text: string): string {
	let redacted = text
		.replace(
			QUOTED_SECRET_VALUE_PATTERN,
			(_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
		)
		.replace(UNQUOTED_SECRET_VALUE_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
		.replace(BEARER_TOKEN_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);

	for (const pattern of KNOWN_CREDENTIAL_PATTERNS) {
		redacted = redacted.replace(pattern, REDACTED);
	}
	return redacted;
}
