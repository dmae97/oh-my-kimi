import { $env, $flag } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/**
 * Parse PI_PY / PI_JS environment variables. Each is a boolean flag; unset
 * means "not specified, defer to settings". Returns null when neither is set
 * so the caller can fall through to `readEvalBackendsAllowance` per key.
 */
function getEvalBackendsFromEnv(): EvalBackendsAllowance | null {
	const pyEnv = $env.PI_PY;
	const jsEnv = $env.PI_JS;
	if (pyEnv === undefined && jsEnv === undefined) return null;
	return {
		python: pyEnv === undefined ? true : $flag("PI_PY"),
		js: jsEnv === undefined ? true : $flag("PI_JS"),
	};
}

/** Read per-backend allowance from settings (defaults true). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance: PI_PY / PI_JS env flags
 * override the per-key settings; otherwise settings (defaults true) win.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return getEvalBackendsFromEnv() ?? readEvalBackendsAllowance(session);
}
