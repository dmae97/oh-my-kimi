/**
 * Main-module path declared by self-dispatching CLI entrypoints — entries
 * whose top-level argv handling routes hidden `__omp_*` worker selectors.
 * Worker spawn sites re-enter this module via `new Worker(entry, { argv })`,
 * so every distribution (source, npm bundle, compiled binary) needs exactly
 * one JavaScript entrypoint. Never set under `bun test`, SDK embedding, or
 * standalone package bins — those hosts load worker modules directly.
 */
let workerHostMain: string | null = null;

/** Called by CLI entrypoints whose main module dispatches worker argv selectors. */
export function declareWorkerHostEntry(): void {
	workerHostMain = Bun.main;
}

/** Main-module path of the self-dispatching CLI host, or null outside it. */
export function workerHostEntry(): string | null {
	return workerHostMain;
}
