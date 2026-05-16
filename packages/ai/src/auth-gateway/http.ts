/**
 * Shared HTTP helpers for the auth-gateway routes.
 *
 * Centralized so we share the same JSON shape, auth check,
 * and peer-resolution logic.
 */

const JSON_HEADERS = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
} as const;
export function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body) ?? "null", {
		status,
		headers: JSON_HEADERS,
	});
}

export function resolvePeer(req: Request): string {
	const fwd = req.headers.get("x-forwarded-for");
	if (fwd) return fwd.split(",")[0].trim();
	return req.headers.get("x-real-ip") ?? "unknown";
}

export function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}
