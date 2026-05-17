import { For, type JSX } from "solid-js";

import { statusResource } from "../state";
import { EVENT_STATE_ORDER, type EventState } from "../types";

const ACCENT: Record<EventState, string> = {
  queued: "text-[#9ec9ff]",
  running: "text-[#ffe26b]",
  done: "text-[#7fe5a3]",
  failed: "text-[#ff8e85]",
  skipped: "text-ink-300",
};

export function Stats(): JSX.Element {
  const counts = (): Record<EventState, number> => {
    const status = statusResource();
    if (!status) return { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    return status.issue_event_counts ?? status.event_counts;
  };

  return (
    <section
      class="glass glass-rise rounded-[22px] grid gap-px overflow-hidden"
      style={{
        "grid-template-columns": "repeat(5, minmax(0, 1fr))",
        "background-color": "rgba(255, 255, 255, 0.05)",
      }}
      title="newest non-skipped event per issue"
    >
      <For each={EVENT_STATE_ORDER}>
        {(state) => (
          <div
            class="px-5 py-5 flex flex-col gap-1.5"
            style={{ "background-color": "rgba(8, 11, 16, 0.55)" }}
          >
            <span class="eyebrow">{state}</span>
            <span class={`text-[34px] leading-none font-semibold tabular ${ACCENT[state]}`}>
              {counts()[state] ?? 0}
            </span>
          </div>
        )}
      </For>
    </section>
  );
}
