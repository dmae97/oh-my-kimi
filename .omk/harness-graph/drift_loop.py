#!/usr/bin/env python3
"""Harness graph drift loop — temporal layer over the harness graph.

Snapshots each run's counts + node sets, diffs against the previous snapshot, and emits
drift alerts (new dead links, inactive creep, catalog shrink). This is what turns the graph
from a one-shot report into a self-monitoring loop. Stdlib only.

Usage: python3 drift_loop.py            # snapshot current + diff vs previous -> out/drift-report.md
"""

import json
import os
import sys
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
QUERIES = os.path.join(OUT, "harness-queries.json")
GRAPH = os.path.join(OUT, "harness-graph.json")
STATE = os.path.join(OUT, "drift-state.json")
REPORT = os.path.join(OUT, "drift-report.md")


def load_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"cannot read {p}: {e} — run build-harness-graph.mjs first")


def snapshot(q, g):
    nodes = {n["id"]: n.get("tier") for n in g["nodes"]}
    return {
        "ts": datetime.datetime.now().isoformat(timespec="seconds"),
        "counts": q["counts"],
        "dead": sorted(r["target"] for r in q["deadSkills"]),
        # Hooks/MCP get their own sets. Folding them into "dead" would fix the counts but would
        # make the alert text lie about what kind of thing broke.
        "dead_hooks": sorted(r["target"] for r in q.get("deadHooks", [])),
        "dead_mcp": sorted(r["target"] for r in q.get("deadMcp", [])),
        "inactive": sorted(r["target"] for r in q["inactiveSkills"]),
        "orphan_count": len(q["orphanActiveSkills"]),
        "node_count": len(nodes),
        "nodes": nodes,
    }


def diff(prev, cur):
    def d(a, b):
        return sorted(set(b) - set(a))

    return {
        "new_dead": d(prev["dead"], cur["dead"]),
        "resolved_dead": d(cur["dead"], prev["dead"]),
        "new_inactive": d(prev["inactive"], cur["inactive"]),
        "resolved_inactive": d(cur["inactive"], prev["inactive"]),
        "node_delta": cur["node_count"] - prev["node_count"],
        "inactive_edge_delta": cur["counts"]["skillEdgesInactive"]
        - prev["counts"]["skillEdgesInactive"],
        "dead_edge_delta": cur["counts"]["skillEdgesDead"]
        - prev["counts"]["skillEdgesDead"],
        # A dead hook/MCP edge is an agent wired to a capability that does not exist. These were
        # rendered in the delta table but never alerted on, so hookEdgesDead 0 -> 398 shipped as
        # "no drift". Any metric worth printing is worth alerting on.
        "new_dead_hooks": d(prev.get("dead_hooks", []), cur["dead_hooks"]),
        "resolved_dead_hooks": d(cur["dead_hooks"], prev.get("dead_hooks", [])),
        "new_dead_mcp": d(prev.get("dead_mcp", []), cur["dead_mcp"]),
        "hook_edge_delta": cur["counts"]["hookEdgesDead"]
        - prev["counts"]["hookEdgesDead"],
        "mcp_edge_delta": cur["counts"]["mcpEdgesDead"]
        - prev["counts"]["mcpEdgesDead"],
        "orphan_delta": cur["orphan_count"] - prev["orphan_count"],
    }


def main():
    q = load_json(QUERIES)
    g = load_json(GRAPH)
    cur = snapshot(q, g)

    prev = None
    if os.path.exists(STATE):
        try:
            with open(STATE) as f:
                prev = json.load(f)
        except (OSError, json.JSONDecodeError):
            prev = None

    L = ["# Harness Graph — Drift Report", "", f"_current: {cur['ts']}_", ""]
    if prev is None:
        L += [
            "> First snapshot — baseline recorded. Re-run after any harness change to see drift.",
            "",
        ]
        L += ["## Baseline counts", "", "| metric | value |", "|---|---:|"]
        for k, v in cur["counts"].items():
            L.append(f"| {k} | {v} |")
        alerts = []
    else:
        dd = diff(prev, cur)
        L += [f"> previous: {prev['ts']}", ""]
        alerts = []
        if dd["new_dead"]:
            alerts.append(
                f"🔴 {len(dd['new_dead'])} NEW dead skill links: {', '.join(dd['new_dead'][:10])}"
            )
        if dd["dead_edge_delta"] > 0:
            alerts.append(f"🔴 dead skill edges grew by {dd['dead_edge_delta']}")
        if dd["new_dead_hooks"]:
            alerts.append(
                f"🔴 {len(dd['new_dead_hooks'])} NEW dead HOOK links: {', '.join(dd['new_dead_hooks'][:10])}"
            )
        if dd["hook_edge_delta"] > 0:
            alerts.append(
                f"🔴 dead hook edges grew by {dd['hook_edge_delta']} — agents wired to hooks that do not exist"
            )
        if dd["new_dead_mcp"]:
            alerts.append(
                f"🔴 {len(dd['new_dead_mcp'])} NEW dead MCP links: {', '.join(dd['new_dead_mcp'][:10])}"
            )
        if dd["mcp_edge_delta"] > 0:
            alerts.append(f"🔴 dead MCP edges grew by {dd['mcp_edge_delta']}")
        if dd["new_inactive"]:
            alerts.append(
                f"🟠 {len(dd['new_inactive'])} NEW inactive skills: {', '.join(dd['new_inactive'][:10])}"
            )
        if dd["inactive_edge_delta"] > 0:
            alerts.append(f"🟠 inactive edges grew by {dd['inactive_edge_delta']}")
        if dd["node_delta"] < 0:
            alerts.append(f"🟡 catalog shrank by {-dd['node_delta']} nodes")
        if dd["resolved_dead"]:
            alerts.append(
                f"✅ resolved {len(dd['resolved_dead'])} dead links: {', '.join(dd['resolved_dead'][:10])}"
            )
        if dd["resolved_dead_hooks"]:
            alerts.append(
                f"✅ resolved {len(dd['resolved_dead_hooks'])} dead hook links: {', '.join(dd['resolved_dead_hooks'][:10])}"
            )
        if dd["resolved_inactive"]:
            alerts.append(f"✅ resolved {len(dd['resolved_inactive'])} inactive skills")

        L += ["## Alerts", ""]
        L += (
            ["- " + a for a in alerts]
            if alerts
            else ["✅ no drift — harness stable since last run."]
        )
        L += [
            "",
            "## Deltas",
            "",
            "| metric | prev | cur | Δ |",
            "|---|---:|---:|---:|",
        ]
        for k in cur["counts"]:
            p, c = prev["counts"].get(k, 0), cur["counts"][k]
            L.append(f"| {k} | {p} | {c} | {c - p:+d} |")

    try:
        with open(REPORT, "w") as f:
            f.write("\n".join(L) + "\n")
        with open(STATE, "w") as f:
            json.dump(cur, f, indent=1)
    except OSError as e:
        sys.exit(f"cannot write drift state/report: {e}")

    print(f"drift loop -> {os.path.relpath(REPORT, os.getcwd())}")
    if prev is None:
        print("  baseline recorded (first run)")
    else:
        print(f"  alerts: {len(alerts)}")
        for a in alerts:
            print("   ", a)


if __name__ == "__main__":
    main()
