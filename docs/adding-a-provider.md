# Adding a provider

Providers in `packages/ai` are described by a single declarative
`ProviderDefinition` and collected in one registry. Every scattered structure —
the `KnownProvider` / `OAuthProvider` type unions, `PROVIDER_DESCRIPTORS`,
`DEFAULT_MODEL_PER_PROVIDER`, the `serviceProviderMap` env-key fallbacks, the
`/login` provider list, the `refreshOAuthToken` / `AuthStorage.login` dispatch,
and the coding-agent callback maps — is **derived** from that registry.

**Scope.** This is for a provider that reuses an existing wire API
(`openai-completions`, `anthropic-messages`, `google-generative-ai`, …) — the
common case for gateways and API-key providers, since stream dispatch keys on
`model.api`, not `model.provider`. Adding a *new wire protocol* (a new
`KnownApi`) is a separate task that also touches `stream.ts` dispatch,
`api-registry.ts`, and `types.ts`.

## Shape

For the common case, a provider is still **one new def file + one registry line**:

1. **Create `packages/ai/src/registry/<id>.ts`** exporting one
   `export const <camelId>Provider = { … } as const satisfies ProviderDefinition;`.
2. **Add it to the `ALL` array** in `packages/ai/src/registry/registry.ts`
   (one import + one array entry). `ALL` order is the `/login` list order for
   loginable providers.

That is the full change for:
- env-key-only providers,
- providers with a simple inline API-key login flow,
- most OpenAI-compatible gateways.

For a **non-trivial provider-local OAuth flow**, put the implementation in
`packages/ai/src/registry/oauth/<vendor>.ts` and lazy-import it from the def
file. The shared OAuth flow infrastructure it builds on lives in the same
`registry/oauth/` directory.

Either way, descriptors, default-model map, env-key map, login list, and refresh
dispatch all update automatically, and the `KnownProvider` / `OAuthProvider`
unions gain the new id by derivation.

## `ProviderDefinition` fields

See `packages/ai/src/registry/types.ts` for the authoritative,
JSDoc-annotated interface. Presence of a field opts the provider into a derived
structure:

| Field | Effect |
|---|---|
| `id`, `name` | Required. `name` shows in the `/login` list. |
| `defaultModel` | Present ⇒ member of `KnownProvider` (a chat-model provider). |
| `createModelManagerOptions` | Runtime model-discovery factory. Present (and not `specialModelManager`) ⇒ appears in `PROVIDER_DESCRIPTORS`. |
| `allowUnauthenticated` | Runtime creates a model manager even without a key. |
| `dynamicModelsAuthoritative` | Successful discovery replaces bundled models. |
| `catalogDiscovery` | `{ label, envVars, oauthProvider?, allowUnauthenticated? }` for offline catalog generation (`generate-models.ts`). |
| `specialModelManager` | Bespoke runtime factory (`google-antigravity` / `google-gemini-cli` / `openai-codex`); excluded from `PROVIDER_DESCRIPTORS`. |
| `envKeys` | Env-var fallback for `getEnvApiKey`: a var name string or a `() => string \| undefined` resolver. |
| `login` | Interactive login. Present ⇒ member of `OAuthProvider`, shown in `/login`, dispatchable via `AuthStorage.login`. Returns an api-key `string` or `OAuthCredentials`. |
| `refreshToken` | OAuth refresher; omit for static-token providers (the dispatch returns credentials unchanged). |
| `storeCredentialsAs` | Store credentials under a different provider id (e.g. `openai-codex-device` ⇒ `openai-codex`). |
| `callbackPort` | Present ⇒ entry in the auth-broker `CALLBACK_PORTS` map. |
| `pasteCodeFlow` | OAuth flow needs a pasted code/redirect URL ⇒ member of `PASTE_CODE_LOGIN_PROVIDERS`. |

## Conventions

- Use `... as const satisfies ProviderDefinition` so the literal `id` is preserved
  for the union derivation.
- `login` / `refreshToken` for simple API-key or validation-based flows can live
  directly in the provider def file (export the named login function there so
  tests can import it directly).
- `login` / `refreshToken` for heavy provider-local OAuth flows MUST reach the
  adjacent `registry/oauth/*` module via a dynamic-import
  thunk (`const { loginX } = await import("./oauth/x"); return loginX(cb);`),
  keeping those flows out of the eager startup graph.
- All OAuth code lives under `registry/oauth/`: the shared flow infra
  (`callback-server`, `pkce`, `google-oauth-shared`, `types`, the runtime API
  `index`) plus every provider flow, including the `github-copilot` / `kimi` /
  `openai-codex` helpers reused by the streaming and usage layers. The non-OAuth
  API-key helpers (`api-key-login`, `api-key-validation`) sit beside the def
  files in `registry/`, since they back simple paste-an-API-key logins.
- For a simple OpenAI-compatible gateway, build the manager inline with the
  exported `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` —
  no edits to `openai-compat.ts` required.
- A `ProviderDefinition` may also be registered at runtime by an extension via
  `registerOAuthProvider` (the `AuthStorage.login` dispatcher handles built-ins
  and extensions through the same path).
