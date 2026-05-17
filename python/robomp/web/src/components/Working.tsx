import { For, type JSX, Show } from "solid-js";

import { CONFIG } from "../config";
import { fmtAge, fmtDuration, shortDelivery, splitIssueKey } from "../format";
import { runCancel, statusResource } from "../state";
import type { RunningEvent } from "../types";
import { GlassCard } from "./GlassCard";
import { IssueLink } from "./IssueLink";
import { Pill } from "./Pill";

interface Row {
  key: string;
  delivery_id: string;
  issue_key: string | null;
  event_type: string;
  attempts: number;
  model: string | null;
  last_tool: string | null;
  last_tool_ts: string | null;
  started_at: string | null;
  inflight_only: boolean;
}

function rowsFor(running: RunningEvent[], inflight: string[]): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const e of running) {
    const key = e.issue_key ?? e.delivery_id;
    seen.add(key);
    out.push({
      key,
      delivery_id: e.delivery_id,
      issue_key: e.issue_key,
      event_type: e.event_type,
      attempts: e.attempts,
      model: e.model,
      last_tool: e.last_tool,
      last_tool_ts: e.last_tool_ts,
      started_at: e.started_at ?? e.received_at,
      inflight_only: false,
    });
  }
  for (const key of inflight) {
    if (seen.has(key)) continue;
    out.push({
      key,
      delivery_id: "",
      issue_key: key,
      event_type: "",
      attempts: 0,
      model: null,
      last_tool: null,
      last_tool_ts: null,
      started_at: null,
      inflight_only: true,
    });
  }
  return out;
}

async function cancelDelivery(deliveryId: string): Promise<void> {
  if (
    !window.confirm(
      "Kill this running task? The omp subprocess dies and the row lands in 'failed'.",
    )
  ) {
    return;
  }
  await runCancel(deliveryId);
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return "—";
  return fmtDuration((Date.now() - t) / 1000);
}

export function Working(): JSX.Element {
  const rows = (): Row[] => {
    const s = statusResource();
    return s ? rowsFor(s.running_events, s.inflight) : [];
  };

  return (
    <GlassCard heading="currently working" accessory={<span class="tabular">{rows().length}</span>}>
      <Show when={rows().length} fallback={<div class="empty">idle — waiting for events</div>}>
        <div class="overflow-x-auto scrollable">
          <table class="t">
            <thead>
              <tr>
                <th>issue</th>
                <th>event</th>
                <th>state</th>
                <th>elapsed</th>
                <th>model</th>
                <th>last action</th>
                <th>attempt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>{(r) => <WorkingRow row={r} />}</For>
            </tbody>
          </table>
        </div>
      </Show>
    </GlassCard>
  );
}

function WorkingRow(props: { row: Row }): JSX.Element {
  const ref = (): { repo: string; number: string } => splitIssueKey(props.row.issue_key);
  return (
    <tr>
      <td>
        <Show when={ref().number} fallback={<code>{shortDelivery(props.row.delivery_id)}</code>}>
          <IssueLink repo={ref().repo} number={ref().number} />
        </Show>
      </td>
      <td class="text-ink-300">{props.row.event_type || "—"}</td>
      <td>
        <Pill state="running" dot>
          {props.row.inflight_only ? "inflight" : "running"}
        </Pill>
      </td>
      <td class="tabular">{elapsed(props.row.started_at)}</td>
      <td>
        {props.row.model ? (
          <code title={props.row.model}>{props.row.model}</code>
        ) : (
          <span class="text-ink-400">—</span>
        )}
      </td>
      <td>
        {props.row.last_tool ? (
          <span>
            <code>{props.row.last_tool}</code>
            <span class="text-ink-400 ml-2">{fmtAge(props.row.last_tool_ts)}</span>
          </span>
        ) : (
          <span class="text-ink-400">{props.row.inflight_only ? "held by pool" : "—"}</span>
        )}
      </td>
      <td class="text-ink-300 tabular">
        {props.row.inflight_only ? "—" : `#${props.row.attempts}`}
      </td>
      <td>
        <Show
          when={CONFIG.replayEnabled && !props.row.inflight_only}
          fallback={<span class="text-ink-400">—</span>}
        >
          <button class="tiny danger" onClick={() => cancelDelivery(props.row.delivery_id)}>
            cancel
          </button>
        </Show>
      </td>
    </tr>
  );
}
