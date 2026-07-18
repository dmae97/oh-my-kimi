/** Platform-specific options for non-PTY daemon subprocesses. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/** Keep daemon subprocesses headless without discarding an inheritable Windows console. */
export function resolveDaemonSpawnOptions(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
}): DaemonSpawnOptions {
	if (opts.platform !== "win32") return { detached: true };
	return {
		detached: false,
		windowsHide: !opts.hostHasInheritableConsole,
	};
}
