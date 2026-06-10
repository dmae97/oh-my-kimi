/**
 * Fallback context-window / max-output-token values for models discovered
 * without limit metadata.
 *
 * Kept in a dependency-free leaf module (rather than `openai-compat.ts`) so the
 * model-discovery helpers in `utils/discovery/*` can import them without pulling
 * the package root barrel (`@oh-my-pi/pi-ai`) into the model-manager init graph,
 * which would otherwise form an import cycle through the provider registry.
 */
export const UNK_CONTEXT_WINDOW = 222_222;
export const UNK_MAX_TOKENS = 8_888;
