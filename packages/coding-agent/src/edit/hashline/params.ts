/**
 * Zod schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (`.passthrough()`) so providers can attach extra
 * keys without rejection; only `input` is required and `path` is an
 * optional fallback used when the input lacks a `¶PATH#HASH` header.
 */
import * as z from "zod/v4";

export const hashlineEditParamsSchema = z.object({ input: z.string(), path: z.string().optional() }).passthrough();

export type HashlineParams = z.infer<typeof hashlineEditParamsSchema>;
