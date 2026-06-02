export interface JjCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface DiffOptions {
	readonly files?: readonly string[];
	readonly signal?: AbortSignal;
}

interface CommandOptions {
	readonly signal?: AbortSignal;
}

export class JjCommandError extends Error {
	readonly args: readonly string[];
	readonly result: JjCommandResult;

	constructor(args: readonly string[], result: JjCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "JjCommandError";
		this.args = [...args];
		this.result = result;
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<JjCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `jj ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function runCommand(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<JjCommandResult> {
	const child = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
		cwd,
		signal: options.signal,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture jj command output.");
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { exitCode: exitCode ?? 0, stdout, stderr };
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<JjCommandResult> {
	const result = await runCommand(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new JjCommandError(args, result);
	}
	return result;
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff", "--git"];
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

export async function workspaceRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const result = await runCommand(cwd, ["workspace", "root"], { signal });
		if (result.exitCode !== 0) return undefined;
		const root = result.stdout.trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

export async function isRepository(cwd: string, signal?: AbortSignal): Promise<boolean> {
	return (await workspaceRoot(cwd, signal)) !== undefined;
}

/** Run `jj diff --git` for the current workspace commit. Returns raw diff text. */
export async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
	return (await runChecked(cwd, buildDiffArgs(options), { signal: options.signal })).stdout;
}
