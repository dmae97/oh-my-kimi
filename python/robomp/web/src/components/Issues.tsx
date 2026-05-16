import { For, type JSX, Show } from "solid-js";

import { CONFIG } from "../config";
import { fmtAge, shortText } from "../format";
import { statusResource } from "../state";
import { type IssueRow, type LatestEvent, TERMINAL_ISSUE_STATES } from "../types";
import { GlassCard } from "./GlassCard";
import { IssueLink, PrLink } from "./IssueLink";
import { Pill } from "./Pill";

export interface IssuesProps {
  onRetry: (deliveryId: string) => void;
}

export function Issues(props: IssuesProps): JSX.Element {
  const active = (): IssueRow[] => {
    const s = statusResource();
    if (!s) return [];
    return s.issues.filter((i) => !TERMINAL_ISSUE_STATES.has(i.state));
  };

  return (
    <GlassCard heading="active issues" accessory={<span class="tabular">{active().length}</span>}>
      <Show when={active().length} fallback={<div class="empty">no active issues</div>}>
        <div class="overflow-x-auto scrollable">
          <table class="t">
            <thead>
              <tr>
                <th>issue</th>
                <th>state</th>
                <th>last event</th>
                <th>class</th>
                <th>branch</th>
                <th>pr</th>
                <th>error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={active()}>
                {(issue) => <IssueRowView issue={issue} onRetry={props.onRetry} />}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </GlassCard>
  );
}

interface RowProps {
  issue: IssueRow;
  onRetry: (deliveryId: string) => void;
}

function IssueRowView(props: RowProps): JSX.Element {
  const ev = (): LatestEvent | null => props.issue.latest_event;

  return (
    <tr>
      <td>
        <IssueLink repo={props.issue.repo} number={props.issue.number} />
      </td>
      <td>
        <Pill>{props.issue.state}</Pill>
      </td>
      <td>
        <Show when={ev()} fallback={<span class="text-ink-400">—</span>}>
          {(latest) => (
            <>
              <Pill state={latest().state}>{latest().state}</Pill>
              <span class="meta-line">
                {latest().event_type} · attempt #{latest().attempts} ·{" "}
                {fmtAge(latest().received_at)}
              </span>
            </>
          )}
        </Show>
      </td>
      <td class="text-ink-300">{props.issue.classification ?? ""}</td>
      <td>
        {props.issue.branch ? (
          <code>{props.issue.branch}</code>
        ) : (
          <span class="text-ink-400">—</span>
        )}
      </td>
      <td>
        <PrLink repo={props.issue.repo} number={props.issue.pr_number} />
      </td>
      <td class="err-cell">
        <Show
          when={ev()?.state === "failed" && ev()?.last_error}
          fallback={<span class="text-ink-400">—</span>}
        >
          <span title={ev()?.last_error ?? ""}>{shortText(ev()?.last_error)}</span>
        </Show>
      </td>
      <td>
        <Show
          when={CONFIG.replayEnabled && ev()?.state === "failed"}
          fallback={<span class="text-ink-400">—</span>}
        >
          <button
            class="tiny"
            onClick={() => {
              const latest = ev();
              if (latest) props.onRetry(latest.delivery_id);
            }}
          >
            retry
          </button>
        </Show>
      </td>
    </tr>
  );
}
