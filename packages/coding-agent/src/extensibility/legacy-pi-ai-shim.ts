/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-ai` (or one of its aliased scopes like `@earendil-works/pi-ai`
 * or `@mariozechner/pi-ai`).
 *
 * pi-ai 15.1.0 removed the historical TypeBox root exports (`Type`, plus the
 * runtime-relevant half of the `Static`/`TSchema` pair) from the package
 * entrypoint. Legacy extensions still author parameter schemas as
 * `Type.Object({ ... })`, so this file is served by `legacy-pi-compat.ts` in
 * place of the real pi-ai entrypoint whenever a legacy extension imports the
 * bare package root. Subpath imports (`@oh-my-pi/pi-ai/utils/oauth`, etc.)
 * continue to resolve directly against the bundled pi-ai package.
 *
 * The `Type` runtime is borrowed from the Zod-backed TypeBox shim that
 * already serves bare `@sinclair/typebox` imports for the same extension
 * class, keeping the legacy-compat surface internally consistent.
 *
 * Type-level `Static` and `TSchema` continue to come from pi-ai's own
 * `types.ts` via the `export *` below — pi-ai still exports both as types,
 * only the runtime `Type` builder was removed.
 */

export * from "@oh-my-pi/pi-ai";
export { Type } from "./typebox";
