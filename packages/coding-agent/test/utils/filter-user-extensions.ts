import { getAgentDir, getConfigRootDir, getPluginsDir, pathIsWithin } from "@oh-my-pi/pi-utils";

// Drop every extension discovered from the user's machine so each test only
// sees what it wrote into the per-test temp project dir. Production composes
// the user-extension list from three independent roots, any one of which can
// leak entries on a contributor's box:
//
// 1. `getConfigRootDir()` (`~/.omp`)
//    Catches the native builtin provider's settings.json-declared extensions
//    that resolve outside the `agent/extensions/` subtree (e.g. an absolute
//    or `../`-relative entry pointing somewhere else under `~/.omp/`), plus
//    the legacy non-XDG `~/.omp/plugins` tree on hosts without XDG dirs.
// 2. `getAgentDir()` (`~/.omp/agent` or `$PI_CODING_AGENT_DIR`)
//    Handles `PI_CODING_AGENT_DIR` overrides that relocate the agent dir
//    (and therefore `agent/extensions/`) out from under the config root.
// 3. `getPluginsDir()` (XDG-aware: `$XDG_DATA_HOME/omp/plugins` or legacy)
//    Handles installed plugin extensions that live outside `~/.omp` when
//    XDG_DATA_HOME resolves the plugins dir somewhere else.
export function filterUserScoped<T extends { path: string }>(items: T[]): T[] {
	const prefixes = [getConfigRootDir(), getAgentDir(), getPluginsDir()];
	return items.filter(it => !prefixes.some(prefix => pathIsWithin(prefix, it.path)));
}
