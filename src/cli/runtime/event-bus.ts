/**
 * Phase 1 — CliEventBus
 * Normalizes core onProgress/onTrace events into a unified stream.
 * Deterministic; no LLM calls here.
 */

import type { NormalizedRunEvent } from "./types.js";

export interface CliEventBus {
  emit(event: NormalizedRunEvent): void;
  subscribe(listener: (event: NormalizedRunEvent) => void): () => void;
  snapshot(): readonly NormalizedRunEvent[];
}

export function createCliEventBus(): CliEventBus {
  const events: NormalizedRunEvent[] = [];
  const listeners = new Set<(event: NormalizedRunEvent) => void>();

  return {
    emit(event: NormalizedRunEvent): void {
      events.push(event);
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // isolated delivery; one failing listener must not break others
        }
      }
    },

    subscribe(listener: (event: NormalizedRunEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    snapshot(): readonly NormalizedRunEvent[] {
      return events.slice();
    },
  };
}
