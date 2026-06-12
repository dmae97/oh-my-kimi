import type { CliRenderer } from "../../../cli/ui/renderer.js";
import type { SlashCommandResult } from "./types.js";

export function okSlashResult(partial: Omit<SlashCommandResult, "ok"> = {}): SlashCommandResult {
  return { ok: true, ...partial };
}

export function exitSlashResult(): SlashCommandResult {
  return { ok: true, exit: true };
}

export function errorSlashResult(text: string): SlashCommandResult {
  return { ok: false, text };
}

export function emitSlashResult(result: SlashCommandResult, renderer?: CliRenderer): void {
  for (const event of result.events ?? []) renderer?.emit(event);
  if (!renderer) return;
  if (result.json !== undefined) {
    renderer.emit({ type: "control:output", text: `${JSON.stringify(result.json, null, 2)}\n` });
  }
  if (result.text) {
    if (result.ok) renderer.emit({ type: "control:output", text: result.text.endsWith("\n") ? result.text : `${result.text}\n` });
    else renderer.emit({ type: "turn:error", message: result.text });
  }
}

export function printSlashResult(result: SlashCommandResult): void {
  if (result.json !== undefined) {
    console.log(JSON.stringify(result.json, null, 2));
  } else if (result.text) {
    if (result.ok) console.log(result.text);
    else console.error(result.text);
  }
}
