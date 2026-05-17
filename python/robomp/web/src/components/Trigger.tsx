import { createSignal, type JSX, Show } from "solid-js";

import { CONFIG } from "../config";
import { runTrigger, triggerStatus } from "../state";
import { GlassCard } from "./GlassCard";

const STATUS_TONE = {
  idle: "text-ink-400",
  pending: "text-ink-200",
  ok: "text-[#7fe5a3]",
  err: "text-[#ff8e85]",
} as const;

export function Trigger(): JSX.Element {
  const [issue, setIssue] = createSignal<string>("");

  const validate = (): string | null => {
    const value = issue().trim();
    if (!value) return "enter owner/repo#NN";
    return null;
  };

  const handleTriage = (): void => {
    const value = issue().trim();
    if (!value) return;
    void runTrigger({ mode: "triage", issue: value });
  };

  const handleRetry = (): void => {
    const value = issue().trim();
    if (!value) return;
    void runTrigger({ mode: "retry", issue: value });
  };

  return (
    <GlassCard heading="trigger" accessory={<span class="text-ink-400">owner/repo#NN</span>}>
      <Show
        when={CONFIG.replayEnabled}
        fallback={
          <div class="px-5 py-7 text-ink-300 text-[13px] leading-relaxed">
            trigger disabled. set <code>ROBOMP_REPLAY_TOKEN</code> in the server env to enable
            manual triage and retry actions.
          </div>
        }
      >
        <div class="px-5 pb-5 pt-1 flex flex-col gap-4">
          <div class="form-row">
            <input
              type="text"
              spellcheck={false}
              placeholder="octo/widget#42"
              autocomplete="off"
              value={issue()}
              onInput={(ev) => setIssue(ev.currentTarget.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") handleTriage();
              }}
              class="flex-1 min-w-[220px] font-mono"
            />
            <button class="primary" onClick={handleTriage}>
              fetch &amp; triage
            </button>
            <button onClick={handleRetry}>retry latest run</button>
          </div>
          <Show
            when={triggerStatus().text}
            fallback={
              <span class={`text-[12px] ${STATUS_TONE.idle}`}>{validate() ?? "ready"}</span>
            }
          >
            <span class={`text-[12px] ${STATUS_TONE[triggerStatus().kind]}`}>
              {triggerStatus().text}
            </span>
          </Show>
        </div>
      </Show>
    </GlassCard>
  );
}
