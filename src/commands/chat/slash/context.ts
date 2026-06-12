import type { NativeRootLoopInput, NativeRootSessionState } from "../native-root-loop.js";
import type { SlashCommandContext, SlashCommandServices } from "./types.js";

export function createSlashCommandContext(
  input: NativeRootLoopInput,
  state: NativeRootSessionState,
  services: SlashCommandServices = {}
): SlashCommandContext {
  return {
    input,
    state,
    renderer: input.renderer,
    env: input.env,
    services,
  };
}
