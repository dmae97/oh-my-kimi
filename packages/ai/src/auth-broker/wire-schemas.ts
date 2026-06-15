/**
 * Zod schemas for the auth-broker wire protocol.
 *
 * Shared between the server (validates inbound request bodies) and the client
 * (validates responses from the broker). Schemas mirror the TypeScript types
 * in `./types.ts` 1:1; the types remain the source of truth for static typing,
 * and `z.infer<typeof Schema>` is asserted-compatible with them where possible.
 *
 * Envelope and fixed-shape schemas use `.strict()` so unknown keys are
 * rejected — the previous implementation used a hand-rolled `hasOnlyFields`
 * allowlist for the same effect. The OAuth credential schema is the deliberate
 * exception (`.loose()`): it preserves provider-specific extension fields so
 * they round-trip through the broker instead of being dropped (see below).
 */
import { z } from "zod/v4";
import { REMOTE_REFRESH_SENTINEL } from "../auth-storage";
import { usageReportSchema } from "../usage";

// ─── Credential payloads ───────────────────────────────────────────────────

/** Real OAuth credential (broker-side) — refresh token is the actual upstream value. */
export const oauthCredentialSchema = z
	.object({
		type: z.literal("oauth"),
		refresh: z
			.string()
			.min(1)
			// Reject the sentinel literal on writes: if a client somehow round-trips
			// a snapshot back into POST /v1/credential, accepting the sentinel as a
			// real refresh token would silently break that credential's refresh
			// forever (the broker would store `"__remote__"` and try to use it as
			// the upstream refresh token).
			.refine(value => value !== REMOTE_REFRESH_SENTINEL, {
				message: `refresh token must not equal the remote sentinel (${REMOTE_REFRESH_SENTINEL})`,
			}),
		access: z.string().min(1),
		expires: z.number(),
		enterpriseUrl: z.string().optional(),
		projectId: z.string().optional(),
		email: z.string().optional(),
		accountId: z.string().optional(),
	})
	// `.loose()`, not `.strict()`: OAuth credentials carry an open set of
	// provider-specific extension fields beyond the base shape above — e.g. an
	// MCP server's tokenUrl/clientId/clientSecret/resource embedded so token
	// refresh works without an `auth` block in config. The storage layer
	// (`serializeCredential`/`deserializeCredential`/`exportSnapshot`) already
	// preserves unknown OAuth fields generically; the wire schema must match or
	// the broker set->get round-trip silently strips them and the credential
	// can no longer refresh after reload. Envelope schemas stay `.strict()`.
	.loose();

/** OAuth credential as it appears in broker snapshots — refresh replaced with sentinel. */
export const remoteOauthCredentialSchema = oauthCredentialSchema.extend({
	refresh: z.literal(REMOTE_REFRESH_SENTINEL),
});

export const apiKeyCredentialSchema = z
	.object({
		type: z.literal("api_key"),
		key: z.string().min(1),
	})
	.strict();

/** Discriminated union accepted on POST /v1/credential (writes). */
export const writableAuthCredentialSchema = z.discriminatedUnion("type", [
	oauthCredentialSchema,
	apiKeyCredentialSchema,
]);

/** Discriminated union returned in snapshots (refresh is sentinel for OAuth). */
export const snapshotCredentialSchema = z.discriminatedUnion("type", [
	remoteOauthCredentialSchema,
	apiKeyCredentialSchema,
]);

// ─── Snapshot ──────────────────────────────────────────────────────────────

export const credentialSnapshotEntrySchema = z
	.object({
		id: z.number().int(),
		provider: z.string().min(1),
		credential: snapshotCredentialSchema,
		identityKey: z.string().nullable(),
	})
	.strict();

export const snapshotEntrySchema = credentialSnapshotEntrySchema
	.extend({
		rotatesInMs: z.number().nullable(),
	})
	.strict();

export const refresherScheduleSchema = z
	.object({
		enabled: z.boolean(),
		intervalMs: z.number(),
		skewMs: z.number(),
		nextSweepInMs: z.number(),
	})
	.strict();

export const snapshotResponseSchema = z
	.object({
		generation: z.number().int(),
		generatedAt: z.number(),
		serverNowMs: z.number(),
		refresher: refresherScheduleSchema,
		credentials: z.array(snapshotEntrySchema),
	})
	.strict();

// ─── Snapshot stream (SSE) ────────────────────────────────────────────────

/** First frame on connect — full snapshot embedded inline with a `kind` tag. */
export const snapshotStreamSnapshotEventSchema = snapshotResponseSchema
	.extend({
		kind: z.literal("snapshot"),
	})
	.strict();

/** Per-credential upsert/refresh delta. */
export const snapshotStreamEntryEventSchema = z
	.object({
		kind: z.literal("entry"),
		generation: z.number().int(),
		serverNowMs: z.number(),
		refresher: refresherScheduleSchema,
		entry: snapshotEntrySchema,
	})
	.strict();

/** Per-credential delete delta. */
export const snapshotStreamRemovedEventSchema = z
	.object({
		kind: z.literal("removed"),
		generation: z.number().int(),
		serverNowMs: z.number(),
		refresher: refresherScheduleSchema,
		id: z.number().int(),
	})
	.strict();

/** Discriminated union over every event frame the snapshot stream emits. */
export const snapshotStreamEventSchema = z.discriminatedUnion("kind", [
	snapshotStreamSnapshotEventSchema,
	snapshotStreamEntryEventSchema,
	snapshotStreamRemovedEventSchema,
]);

// ─── Healthz ────────────────────────────────────────────────────────────────

export const healthzResponseSchema = z
	.object({
		ok: z.boolean(),
		version: z.string().optional(),
	})
	.strict();

// ─── Usage ─────────────────────────────────────────────────────────────────

/**
 * Broker `/v1/usage` response. Reports are full {@link UsageReport}s minus the
 * heavy provider-specific `raw` field (the server strips it before send) — we
 * keep `raw` optional in the underlying schema so a misconfigured broker that
 * forgot to strip still validates.
 */
export const usageResponseSchema = z
	.object({
		generatedAt: z.number(),
		reports: z.array(usageReportSchema),
	})
	.strict();

// ─── Refresh ───────────────────────────────────────────────────────────────

export const credentialRefreshResponseSchema = z
	.object({
		entry: credentialSnapshotEntrySchema,
	})
	.strict();

// ─── Disable ───────────────────────────────────────────────────────────────

export const credentialDisableRequestSchema = z
	.object({
		cause: z.string().optional(),
	})
	.strict();

export const credentialDisableResponseSchema = z
	.object({
		ok: z.boolean(),
	})
	.strict();

// ─── Upload ────────────────────────────────────────────────────────────────

export const credentialUploadRequestSchema = z
	.object({
		provider: z.string().min(1),
		credential: writableAuthCredentialSchema,
	})
	.strict();

export const credentialUploadResponseSchema = z
	.object({
		entries: z.array(credentialSnapshotEntrySchema),
	})
	.strict();
