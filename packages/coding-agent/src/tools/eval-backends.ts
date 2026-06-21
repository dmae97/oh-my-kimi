import { $flag } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	ruby: boolean;
	julia: boolean;
}

/** Read per-backend allowance from settings (defaults true). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
		ruby: session.settings.get("eval.rb") ?? true,
		julia: session.settings.get("eval.jl") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance: PI_PY / PI_JS / PI_RB / PI_JL
 * env flags override the per-key settings; otherwise settings (defaults true)
 * win.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("PI_PY", settings.python),
		js: $flag("PI_JS", settings.js),
		ruby: $flag("PI_RB", settings.ruby),
		julia: $flag("PI_JL", settings.julia),
	};
}
