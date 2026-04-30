#!/usr/bin/env bun

export function buildZigArgs(args: string[], overrides: { target?: string; cpu?: string }): string[] {
	const nextArgs = [...args];
	if (nextArgs[0] !== "build") {
		return nextArgs;
	}

	const target = overrides.target?.trim();
	const cpu = overrides.cpu?.trim();

	if (target && !nextArgs.some(arg => arg.startsWith("-Dtarget="))) {
		nextArgs.push(`-Dtarget=${target}`);
	}
	if (cpu && !nextArgs.some(arg => arg.startsWith("-Dcpu="))) {
		nextArgs.push(`-Dcpu=${cpu}`);
	}

	return nextArgs;
}

export async function main(
	argv: string[] = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const realZigPath = env.PI_NATIVE_REAL_ZIG;
	if (!realZigPath) {
		throw new Error("PI_NATIVE_REAL_ZIG is required when using zig-safe-wrapper.ts");
	}

	const child = Bun.spawn(
		[realZigPath, ...buildZigArgs(argv, { target: env.PI_NATIVE_ZIG_TARGET, cpu: env.PI_NATIVE_ZIG_CPU })],
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	return await child.exited;
}

if (import.meta.main) {
	const exitCode = await main();
	process.exit(exitCode);
}
