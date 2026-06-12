import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { InputEnvelope } from "./input-envelope.js";

export interface PersistInputEnvelopeOptions {
  root: string;
  runId?: string;
}

export function inputRunDir(root: string, runId: string): string {
  return join(root, ".omk", "runs", runId);
}

export async function persistInputEnvelope(
  envelope: InputEnvelope,
  options: PersistInputEnvelopeOptions,
): Promise<{ latestPath: string; historyPath: string }> {
  const runId = options.runId ?? envelope.runId;
  const runDir = inputRunDir(options.root, runId);
  const inputsDir = join(runDir, "inputs");
  await mkdir(inputsDir, { recursive: true });
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  const latestPath = join(runDir, "input-envelope.json");
  const historyPath = join(inputsDir, `${envelope.inputId}.json`);
  await Promise.all([
    writeFile(latestPath, serialized, "utf-8"),
    writeFile(historyPath, serialized, "utf-8"),
  ]);
  return { latestPath, historyPath };
}
