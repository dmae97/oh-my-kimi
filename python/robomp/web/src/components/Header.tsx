import { type JSX, Show } from "solid-js";

import { CONFIG } from "../config";
import { fmtDuration } from "../format";
import { isFetching, lastTickAt, lastTickError, statusResource } from "../state";
import type { RuntimeInfo } from "../types";

function relativeAgo(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 5) return "just now";
  return `${fmtDuration(seconds)} ago`;
}

export function Header(): JSX.Element {
  const runtime = (): RuntimeInfo | undefined => statusResource()?.runtime;

  return (
    <header class="px-6 lg:px-10 pt-8 pb-6 flex flex-col gap-5">
      <div class="flex flex-wrap items-end gap-x-6 gap-y-3 justify-between">
        <div class="flex items-baseline gap-3">
          <h1 class="text-[26px] font-semibold tracking-tight leading-none">
            <span class="text-ink-50">robomp</span>
            <span class="inline-block ml-2 size-[7px] rounded-full align-middle bg-accent shadow-[0_0_10px_rgba(10,132,255,0.7)]" />
          </h1>
          <span class="eyebrow">triage · fix · ship</span>
        </div>

        <div class="flex items-center gap-2 text-[11px] text-ink-300">
          <Show
            when={lastTickError()}
            fallback={
              <span class="flex items-center gap-2">
                <span
                  class={`inline-block size-[7px] rounded-full ${
                    isFetching() ? "bg-warn" : "bg-ok"
                  }`}
                  style={{
                    "box-shadow": isFetching()
                      ? "0 0 8px rgba(255,214,10,0.6)"
                      : "0 0 8px rgba(48,209,88,0.6)",
                  }}
                />
                {isFetching() ? "syncing…" : `synced ${relativeAgo(lastTickAt())}`}
              </span>
            }
          >
            <span class="flex items-center gap-2 text-err">
              <span class="inline-block size-[7px] rounded-full bg-err" />
              {lastTickError()}
            </span>
          </Show>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-7 gap-y-2 text-[12px] text-ink-300 tabular">
        <Meta label="bot" value={runtime()?.bot_login} mono />
        <Meta
          label="model"
          value={runtime()?.model}
          mono
          title={runtime()?.thinking_level ? `thinking ${runtime()?.thinking_level}` : undefined}
        />
        <Meta
          label="concurrency"
          value={
            runtime()?.max_concurrency != null ? String(runtime()?.max_concurrency) : undefined
          }
        />
        <Meta
          label="uptime"
          value={
            runtime()?.uptime_seconds != null ? fmtDuration(runtime()?.uptime_seconds) : undefined
          }
        />
        <Meta
          label="allowlist"
          value={
            runtime()?.repo_allowlist?.length ? runtime()!.repo_allowlist.join(", ") : "(none)"
          }
          mono
        />
        <Show when={!CONFIG.replayEnabled}>
          <span class="pill skipped">read-only · trigger disabled</span>
        </Show>
      </div>
    </header>
  );
}

interface MetaProps {
  label: string;
  value?: string;
  mono?: boolean;
  title?: string;
}

function Meta(props: MetaProps): JSX.Element {
  return (
    <span class="inline-flex items-baseline gap-1.5" title={props.title}>
      <span class="text-ink-500 uppercase tracking-[0.14em] text-[10px]">{props.label}</span>
      <span class={props.mono ? "font-mono text-[12px] text-ink-100" : "text-ink-100"}>
        {props.value ?? "…"}
      </span>
    </span>
  );
}
