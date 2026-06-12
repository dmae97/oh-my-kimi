import {
  runShellStreaming,
  type ShellResult,
  type StreamingShellIo,
} from "../util/shell.js";
import { buildChildEnv, type ChildEnvSource } from "./child-env.js";

export type ProcessSessionIo = StreamingShellIo;

export interface ProcessSessionOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: ChildEnvSource;
  readonly parentEnv?: ChildEnvSource;
  readonly inheritParentEnv?: boolean;
  readonly allowedParentEnvNames?: readonly string[];
  readonly allowedSecretEnvNames?: readonly string[];
  readonly allowSecretPassthrough?: boolean;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly stdio?: "pipe" | "inherit";
  readonly logPath?: string;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: string, io?: ProcessSessionIo) => void;
  readonly onStderr?: (chunk: string, io?: ProcessSessionIo) => void;
}

export interface ProcessSessionResult extends ShellResult {
  readonly aborted: boolean;
  readonly durationMs: number;
}

export async function runProcessSession(
  options: ProcessSessionOptions
): Promise<ProcessSessionResult> {
  const startedAt = Date.now();
  const signal = options.signal;
  const env = buildChildEnv({
    parentEnv: options.parentEnv,
    overrideEnv: options.env,
    inheritParentEnv: options.inheritParentEnv,
    allowedParentEnvNames: options.allowedParentEnvNames,
    allowedSecretEnvNames: options.allowedSecretEnvNames,
    allowSecretPassthrough: options.allowSecretPassthrough,
  });

  const result = await runShellStreaming(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio,
    logPath: options.logPath,
    input: options.input,
    signal,
    inheritEnv: false,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
  const aborted = signal?.aborted === true;

  return {
    ...result,
    exitCode: aborted ? 130 : result.exitCode,
    failed: aborted ? true : result.failed,
    aborted,
    durationMs: Date.now() - startedAt,
  };
}
