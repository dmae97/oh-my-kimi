/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required. `_input` is accepted as a
 * provider-emitted alias for `input`.
 */
import { type } from "arktype";

const baseSchema = type({ input: "string" });

export const hashlineEditParamsSchema = baseSchema.pipe(raw => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

	const record = raw as Record<string, unknown>;
	if (typeof record.input === "string" || typeof record._input !== "string") return raw;

	return { ...record, input: record._input };
});

export type HashlineParams = Parameters<typeof hashlineEditParamsSchema.assert>[0];
