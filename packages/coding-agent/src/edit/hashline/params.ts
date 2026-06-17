/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required. `_input` is accepted as a
 * provider-emitted alias for `input`.
 */
import { type } from "arktype";

const requiredInputSchema = type({ input: "string" });
const inputAliasSchema = type({ "input?": "string", "_input?": "string" });

export const hashlineEditParamsSchema = inputAliasSchema
	.pipe(raw => {
		if (raw.input !== undefined || raw._input === undefined) return raw;
		return { ...raw, input: raw._input };
	})
	.pipe(requiredInputSchema);

export type HashlineParams = Parameters<typeof hashlineEditParamsSchema.assert>[0];
