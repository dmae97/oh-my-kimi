#!/usr/bin/env python3
"""Harness graph dashboard — single executive summary over all out/* artifacts.

Usage: python3 dashboard.py   # -> out/dashboard.md
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def load(name: str) -> Any | None:
    p = os.path.join(OUT, name)
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def main() -> None:
    q = load("harness-queries.json")
    health = load("health-gate.json")
    analysis = load("graph-analysis.json")
    drift = None
    try:
        with open(os.path.join(OUT, "drift-report.md"), encoding="utf-8") as f:
            drift = f.read()
    except OSError:
        drift = None
    cross = load("code-crosslink.json")

    if not q:
        sys.exit("missing harness-queries.json — run build-harness-graph.mjs first")

    c = q["counts"]
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    status = (health or {}).get("status", "?")
    icon = {"PASS": "✅", "WARN": "🟠", "FAIL": "🔴"}.get(status, "❓")

    L = [
        f"# Harness Graph Dashboard {icon} {status}",
        "",
        f"_generated {ts}_",
        "",
        "## Scoreboard",
        "",
        "| metric | value |",
        "|---|---:|",
        f"| agents | {c.get('agents')} |",
        f"| skills active / on-disk-extra | {c.get('skillsActive')} / {c.get('skillsOnDiskExtra')} |",
        f"| skill edges (active/inactive/dead) | "
        f"{c.get('skillEdgesActive')}/{c.get('skillEdgesInactive')}/{c.get('skillEdgesDead')} |",
        f"| hook edges dead | {c.get('hookEdgesDead')} |",
        f"| mcp edges dead | {c.get('mcpEdgesDead')} |",
        f"| malformed agents | {c.get('malformedAgents')} |",
        f"| orphan-active skills | {len(q.get('orphanActiveSkills') or [])} |",
        f"| trigger collisions (≥0.5) | {len(q.get('collisions') or [])} |",
        f"| model drift | {'yes — ' + ', '.join((q.get('modelDrift') or {}).get('distinct') or []) if (q.get('modelDrift') or {}).get('drift') else 'no'} |",
        "",
    ]

    if health:
        L += ["## Health gate", ""]
        for f in health.get("fails") or []:
            L.append(f"- 🔴 {f}")
        for w in health.get("warns") or []:
            L.append(f"- 🟠 {w}")
        for i in health.get("info") or []:
            L.append(f"- ℹ️ {i}")
        if not (health.get("fails") or health.get("warns")):
            L.append("- ✅ clean")
        L.append("")

    if analysis:
        L += [
            "## Top capability SPOFs",
            "",
            "| node | type | agents | sole-provider |",
            "|---|---|---:|---:|",
        ]
        for r in (analysis.get("critical_capabilities") or [])[:8]:
            L.append(
                f"| {r['name']} | {r['type']} | {r['agents']} | {r['sole_provider_agents']} |"
            )
        L.append("")
        conc = analysis.get("concentration") or {}
        if conc:
            L += ["### Concentration", ""]
            for typ, row in conc.items():
                hubs = ", ".join(f"{n}({k})" for n, k in (row.get("top") or [])[:3])
                L.append(
                    f"- **{typ}**: top1={row['top1_share']:.1%} top3={row['top3_share']:.1%} — {hubs}"
                )
            L.append("")

        comms = analysis.get("communities") or []
        if comms:
            L += ["### Skill communities (modularity)", ""]
            for c in comms[:5]:
                sample = ", ".join((c.get("skills") or [])[:6])
                L.append(
                    f"- cluster {c.get('id')}: {c.get('skill_count')} skills, "
                    f"{c.get('agents')} agents, density={c.get('density')} — {sample}"
                )
            L.append("")

        rules = analysis.get("association_rules") or []
        if rules:
            L += ["### Top association rules (lift)", ""]
            for r in rules[:6]:
                L.append(
                    f"- lift={r['lift']} sup={r['support']}: `{r['a']}` ↔ `{r['b']}`"
                )
            L.append("")

        redun = analysis.get("skill_redundancy") or []
        if redun:
            L += ["### Skill redundancy (dedup)", ""]
            for r in redun[:5]:
                L.append(
                    f"- J={r['jaccard']}: `{r['a']}` ~ `{r['b']}` "
                    f"(shared={r['shared_agents']})"
                )
            L.append("")

    dead_h = q.get("deadHooks") or []
    if dead_h:
        L += ["## Dead hook backlog", ""]
        for r in dead_h:
            L.append(f"- `{r['target']}` × {r['count']} agents")
        L.append("")

    if cross and isinstance(cross, dict):
        deps = cross.get("dep_blast") or {}
        if deps:
            top = sorted(deps.items(), key=lambda x: -len(x[1]))[:6]
            L += [
                "## Code supply-chain (top deps by #skills)",
                "",
                ", ".join(f"`{d}`({len(s)})" for d, s in top),
                "",
            ]

    L += [
        "## Artifacts",
        "",
        "| file | role |",
        "|---|---|",
        "| `harness-report.md` | inventory + tiered dead/inactive |",
        "| `graph-analysis.md` | SPOF + modularity communities + lift rules |",
        "| `drift-report.md` | temporal delta vs previous snapshot |",
        "| `health-gate.md` | fail-closed gate + allowlisted debt |",
        "| `wiring-recommendations.md` | hybrid CF (jaccard·idf·lift) |",
        "| `code-crosslink.md` | agent→skill→script→dep chain |",
        "| `orphan-triage.md` | orphan-active prune-vs-wire review |",
        "| `../SCORECARD.md` | weighted 100-point system grade |",
        "",
    ]

    if drift:
        # pull alerts section only
        lines = drift.splitlines()
        alert_block: list[str] = []
        grab = False
        for line in lines:
            if line.strip() == "## Alerts":
                grab = True
                continue
            if grab and line.startswith("## "):
                break
            if grab and line.strip():
                alert_block.append(line)
        if alert_block:
            L += ["## Latest drift alerts", ""] + alert_block + [""]

    L += [
        "## Run",
        "",
        "```bash",
        "bash .omk/harness-graph/run.sh",
        "python3 .omk/harness-graph/health_gate.py   # exit 1 on FAIL",
        "```",
        "",
    ]

    path = os.path.join(OUT, "dashboard.md")
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(L))
    except OSError as e:
        sys.exit(f"cannot write dashboard: {e}")
    print(f"dashboard -> out/dashboard.md  status={status}")


if __name__ == "__main__":
    main()
