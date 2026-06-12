import type { AgentRuntime, RuntimeHealth } from "./agent-runtime.js";

export interface RuntimeRegistryEntry {
  runtime: AgentRuntime;
  registeredAt: string;
  enabled: boolean;
}

export type RuntimeRegistryListener = (runtimes: AgentRuntime[]) => void;

export function createRuntimeRegistry() {
  const adapters = new Map<string, RuntimeRegistryEntry>();
  const listeners = new Set<RuntimeRegistryListener>();

  function notify(): void {
    const runtimes = list();
    for (const listener of listeners) listener(runtimes);
  }

  function register(runtime: AgentRuntime): void {
    adapters.set(runtime.id, {
      runtime,
      registeredAt: new Date().toISOString(),
      enabled: true,
    });
    notify();
  }

  function unregister(runtimeId: string): boolean {
    const removed = adapters.delete(runtimeId);
    if (removed) notify();
    return removed;
  }

  function get(runtimeId: string): AgentRuntime | undefined {
    return adapters.get(runtimeId)?.runtime;
  }

  function list(): AgentRuntime[] {
    return [...adapters.values()]
      .filter((e) => e.enabled)
      .map((e) => e.runtime)
      .sort((a, b) => b.priority - a.priority);
  }

  function disable(runtimeId: string): void {
    const entry = adapters.get(runtimeId);
    if (entry) {
      entry.enabled = false;
      notify();
    }
  }

  function enable(runtimeId: string): void {
    const entry = adapters.get(runtimeId);
    if (entry) {
      entry.enabled = true;
      notify();
    }
  }

  function onChange(listener: RuntimeRegistryListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function healthCheck(): Promise<RuntimeHealth[]> {
    const results: RuntimeHealth[] = [];
    for (const entry of adapters.values()) {
      if (entry.runtime.health) {
        results.push(await entry.runtime.health());
      } else {
        results.push({
          runtimeId: entry.runtime.id,
          available: true,
          checkedAt: new Date().toISOString(),
          reason: "no health check available",
        });
      }
    }
    return results;
  }

  function findCompatible(capsule: {
    nodeId?: string;
    role?: string;
    taskType?: string;
  }, requiredAuthority?: string[]): AgentRuntime[] {
    return list().filter((r) => {
      if (!r.capabilities) return true;
      if (requiredAuthority) {
        return requiredAuthority.every((auth) => {
          const key = auth as keyof typeof r.capabilities;
          return r.capabilities![key] === true;
        });
      }
      if (capsule.role) {
        const roleKey = capsule.role as keyof typeof r.capabilities;
        return r.capabilities[roleKey] === true;
      }
      return true;
    });
  }

  return {
    register,
    unregister,
    get,
    list,
    disable,
    enable,
    onChange,
    healthCheck,
    findCompatible,
  };
}

export type RuntimeRegistry = ReturnType<typeof createRuntimeRegistry>;
