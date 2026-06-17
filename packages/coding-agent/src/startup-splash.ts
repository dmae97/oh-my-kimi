export interface StartupSplashDecisionOptions {
	readonly configured: boolean;
	readonly isInteractive: boolean;
	readonly resuming: boolean;
	readonly quiet: boolean;
	readonly timing: boolean;
	readonly stdinIsTTY: boolean | undefined;
	readonly stdoutIsTTY: boolean | undefined;
}

export function shouldShowStartupSplash(options: StartupSplashDecisionOptions): boolean {
	if (!options.configured) return false;
	if (!options.isInteractive) return false;
	if (options.resuming || options.quiet) return false;
	if (options.timing) return false;
	return options.stdinIsTTY === true && options.stdoutIsTTY === true;
}
