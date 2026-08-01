#!/usr/bin/env python3
"""Harness health gate — fail-closed CI/session gate over harness-queries + structural analysis.

Reads the latest build artifacts and debt-allowlist.json. Known debt may WARN; new or
grown debt FAILs. Exit codes: 0 clean/warn-only, 1 fail, 2 missing inputs.

Usage:
  python3 health_gate.py              # report -> out/health-gate.md + exit code
  python3 health_gate.py --json       # machine-readable stdout
  python3 health_gate.py --strict     # treat WARN as FAIL
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
QUERIES = os.path.join(OUT, "harness-queries.json")
ANALYSIS = os.path.join(OUT, "graph-analysis.json")
ALLOW = os.path.join(HERE, "debt-allowlist.json")
REPORT = os.path.join(OUT, "health-gate.md")
REPORT_JSON = os.path.join(OUT, "health-gate.json")


def load_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"cannot read {path}: {e}")


def check(
    q: dict[str, Any],
    analysis: dict[str, Any] | None,
    allow: dict[str, Any],
) -> dict[str, Any]:
    thr = allow.get("thresholds") or {}
    counts = q.get("counts") or {}
    fails: list[str] = []
    warns: list[str] = []
    info: list[str] = []

    # --- hard skill / hygiene floors ---
    if counts.get("skillEdgesDead", 0) > thr.get("max_new_dead_skill_edges", 0):
        fails.append(
            f"dead skill edges={counts['skillEdgesDead']} "
            f"(max {thr.get('max_new_dead_skill_edges', 0)})"
        )
    if counts.get("skillEdgesInactive", 0) > thr.get("max_inactive_skill_edges", 0):
        fails.append(
            f"inactive skill edges={counts['skillEdgesInactive']} "
            f"(max {thr.get('max_inactive_skill_edges', 0)})"
        )
    if counts.get("malformedAgents", 0) > thr.get("max_malformed_agents", 0):
        fails.append(
            f"malformed agents={counts['malformedAgents']} "
            f"(max {thr.get('max_malformed_agents', 0)})"
        )

    orphans = len(q.get("orphanActiveSkills") or [])
    max_orph = thr.get("max_orphan_active_skills", 500)
    if orphans > max_orph:
        fails.append(f"orphan-active skills={orphans} (max {max_orph})")
    else:
        info.append(f"orphan-active skills={orphans} (budget {max_orph})")

    # --- dead hooks with allowlist ---
    dead_hook_allow = allow.get("dead_hooks") or {}
    for row in q.get("deadHooks") or []:
        name, cnt = row["target"], row["count"]
        if name in dead_hook_allow:
            cap = int(dead_hook_allow[name].get("max_edges", 0))
            if cnt > cap:
                fails.append(
                    f"allowed dead hook '{name}' grew: {cnt} > max_edges {cap}"
                )
            else:
                warns.append(
                    f"known dead hook '{name}': {cnt} edges "
                    f"(allow ≤{cap}) — {dead_hook_allow[name].get('reason', '')[:80]}"
                )
        else:
            fails.append(f"NEW dead hook '{name}': {cnt} agent edges (not allowlisted)")

    # residual dead-hook edge count must not exceed sum of allowlist caps
    allowed_hook_cap = sum(int(v.get("max_edges", 0)) for v in dead_hook_allow.values())
    if counts.get("hookEdgesDead", 0) > allowed_hook_cap:
        fails.append(
            f"hookEdgesDead={counts['hookEdgesDead']} exceeds allowlist total "
            f"cap {allowed_hook_cap}"
        )

    # --- dead mcp / skills ---
    dead_mcp_allow = allow.get("dead_mcp") or {}
    for row in q.get("deadMcp") or []:
        name, cnt = row["target"], row["count"]
        if name not in dead_mcp_allow:
            fails.append(f"NEW dead MCP '{name}': {cnt} edges")
        else:
            cap = int(dead_mcp_allow[name].get("max_edges", 0))
            if cnt > cap:
                fails.append(f"allowed dead MCP '{name}' grew: {cnt} > {cap}")
            else:
                warns.append(f"known dead MCP '{name}': {cnt} edges")

    dead_skill_allow = allow.get("dead_skills") or {}
    for row in q.get("deadSkills") or []:
        name, cnt = row["target"], row["count"]
        if name not in dead_skill_allow:
            fails.append(f"NEW dead skill '{name}': {cnt} edges")
        else:
            cap = int(dead_skill_allow[name].get("max_edges", 0))
            if cnt > cap:
                fails.append(f"allowed dead skill '{name}' grew: {cnt} > {cap}")

    # --- structural ---
    if analysis:
        if thr.get("require_acyclic", True) and analysis.get("cycles"):
            fails.append(
                f"dependency cycles present: {len(analysis['cycles'])} component(s)"
            )
        conc = analysis.get("concentration") or {}
        mcp = conc.get("mcp") or {}
        max_mcp = thr.get("max_mcp_top1_share", 0.35)
        if mcp and mcp.get("top1_share", 0) > max_mcp:
            top = (mcp.get("top") or [["?", 0]])[0]
            warns.append(
                f"MCP concentration: top1={mcp['top1_share']:.1%} "
                f"({top[0]}) exceeds soft cap {max_mcp:.0%} — replicate or diversify"
            )
        # critical dead caps that are also top SPOFs
        for c in analysis.get("critical_capabilities") or []:
            if c.get("dead") and c.get("agents", 0) >= 20:
                if c["name"] in dead_hook_allow or c["name"] in dead_mcp_allow:
                    continue
                fails.append(
                    f"critical dead capability '{c['name']}' "
                    f"({c['type']}, {c['agents']} agents) not allowlisted"
                )
        top_spof = analysis.get("critical_capabilities") or []
        if top_spof:
            t0 = top_spof[0]
            info.append(
                f"top SPOF: {t0['name']} ({t0['type']}, {t0['agents']} agents, "
                f"{t0['sole_provider_agents']} sole-provider)"
            )
    else:
        warns.append("graph-analysis.json missing — run graph_analyze.py")

    # model drift is informational (config surfaces disagree by design today)
    md = q.get("modelDrift") or {}
    if md.get("drift"):
        warns.append(
            "model drift across sources: " + ", ".join(md.get("distinct") or [])
        )

    status = "FAIL" if fails else ("WARN" if warns else "PASS")
    return {
        "status": status,
        "fails": fails,
        "warns": warns,
        "info": info,
        "counts": counts,
    }


def render(result: dict[str, Any]) -> str:
    icon = {"PASS": "✅", "WARN": "🟠", "FAIL": "🔴"}[result["status"]]
    L = [
        f"# Harness Health Gate — {icon} {result['status']}",
        "",
        f"_agents={result['counts'].get('agents')}  "
        f"skillEdgesDead={result['counts'].get('skillEdgesDead')}  "
        f"hookEdgesDead={result['counts'].get('hookEdgesDead')}  "
        f"mcpEdgesDead={result['counts'].get('mcpEdgesDead')}  "
        f"inactive={result['counts'].get('skillEdgesInactive')}  "
        f"malformed={result['counts'].get('malformedAgents')}_",
        "",
    ]
    if result["fails"]:
        L += ["## FAIL", ""] + [f"- 🔴 {x}" for x in result["fails"]] + [""]
    if result["warns"]:
        L += ["## WARN", ""] + [f"- 🟠 {x}" for x in result["warns"]] + [""]
    if result["info"]:
        L += ["## INFO", ""] + [f"- ℹ️ {x}" for x in result["info"]] + [""]
    if result["status"] == "PASS":
        L += ["✅ all gates green — no known or new debt.", ""]
    return "\n".join(L)


def main() -> None:
    args = sys.argv[1:]
    strict = "--strict" in args
    if not os.path.exists(QUERIES):
        print(f"missing {QUERIES} — run build-harness-graph.mjs first", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(ALLOW):
        print(f"missing allowlist {ALLOW}", file=sys.stderr)
        sys.exit(2)

    q = load_json(QUERIES)
    allow = load_json(ALLOW)
    analysis = load_json(ANALYSIS) if os.path.exists(ANALYSIS) else None
    result = check(q, analysis, allow)
    if strict and result["status"] == "WARN":
        result["status"] = "FAIL"
        result["fails"] = result["fails"] + [
            f"[strict] promoted warn: {w}" for w in result["warns"]
        ]

    md = render(result)
    try:
        os.makedirs(OUT, exist_ok=True)
        with open(REPORT, "w", encoding="utf-8") as f:
            f.write(md)
        with open(REPORT_JSON, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
    except OSError as e:
        sys.exit(f"cannot write health gate report: {e}")

    if "--json" in args:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(md)
        print(f"\nhealth gate -> {os.path.relpath(REPORT)}")

    if result["status"] == "FAIL":
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
