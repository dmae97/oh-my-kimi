#!/usr/bin/env python3
"""Generate a reviewable wiring patch from hybrid-CF + lift recommendations.

Never auto-edits agents. Emits:
  out/wiring-patch.md   — human review checklist
  out/wiring-patch.json — machine-readable ops

Each suggestion is either:
  - half_bundle: agent has A, missing B, lift(A,B) high + conf A→B high
  - cf_top:      top hybrid-CF rec with score/peers above thresholds

Usage:
  python3 apply-wiring-patch.py
  python3 apply-wiring-patch.py --min-lift 8 --min-conf 0.6
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GRAPH = os.path.join(OUT, "harness-graph.json")
WIRING = os.path.join(OUT, "wiring-recommendations.json")
ANALYSIS = os.path.join(OUT, "graph-analysis.json")


def load(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"cannot read {path}: {e}")


def agent_skills(g: dict[str, Any]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for e in g.get("edges", []):
        if e.get("type") == "agent->skill" and e.get("tier") != "dead":
            out[e["from"].split(":", 1)[1]].add(e["to"].split(":", 1)[1])
    return dict(out)


def main() -> None:
    args = sys.argv[1:]
    min_lift = 8.0
    min_conf = 0.6
    if "--min-lift" in args:
        min_lift = float(args[args.index("--min-lift") + 1])
    if "--min-conf" in args:
        min_conf = float(args[args.index("--min-conf") + 1])

    g = load(GRAPH)
    skills = agent_skills(g)
    rules = []
    if os.path.exists(ANALYSIS):
        rules = (load(ANALYSIS).get("association_rules") or [])[:]
    if os.path.exists(WIRING):
        w = load(WIRING)
        if not rules:
            rules = w.get("association_rules") or []
        per = w.get("per_agent") or {}
    else:
        per = {}

    half: list[dict[str, Any]] = []
    for r in rules:
        if r.get("lift", 0) < min_lift:
            continue
        a, b = r["a"], r["b"]
        conf_ab = r.get("confidence_a_to_b", 0)
        conf_ba = r.get("confidence_b_to_a", 0)
        for agent, sks in skills.items():
            if a in sks and b not in sks and conf_ab >= min_conf:
                half.append(
                    {
                        "agent": agent,
                        "add": b,
                        "because": a,
                        "lift": r["lift"],
                        "confidence": conf_ab,
                        "kind": "half_bundle",
                    }
                )
            if b in sks and a not in sks and conf_ba >= min_conf:
                half.append(
                    {
                        "agent": agent,
                        "add": a,
                        "because": b,
                        "lift": r["lift"],
                        "confidence": conf_ba,
                        "kind": "half_bundle",
                    }
                )

    # dedupe agent+add keeping highest lift
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for h in half:
        key = (h["agent"], h["add"])
        if key not in best or h["lift"] > best[key]["lift"]:
            best[key] = h
    half = sorted(best.values(), key=lambda x: (-x["lift"], x["agent"], x["add"]))

    cf_rows: list[dict[str, Any]] = []
    for agent, recs in per.items():
        for rec in recs[:2]:
            if rec.get("score", 0) >= 1.5 and rec.get("peers", 0) >= 3:
                cf_rows.append(
                    {
                        "agent": agent,
                        "add": rec["skill"],
                        "score": rec["score"],
                        "peers": rec["peers"],
                        "lift_boost": rec.get("lift_boost"),
                        "kind": "cf_top",
                    }
                )
    cf_rows.sort(key=lambda x: (-x["score"], x["agent"]))

    payload = {
        "generatedAt": __import__("datetime")
        .datetime.now()
        .isoformat(timespec="seconds"),
        "thresholds": {"min_lift": min_lift, "min_conf": min_conf},
        "half_bundle_count": len(half),
        "cf_top_count": len(cf_rows),
        "half_bundles": half[:80],
        "cf_top": cf_rows[:40],
        "note": "Review-only. Apply by editing agent - Skills: lines manually or with an approved fixer.",
    }

    L = [
        "# Wiring Patch (review-only)",
        "",
        f"_half-bundles: {len(half)} (lift≥{min_lift}, conf≥{min_conf}) · "
        f"cf-top: {len(cf_rows)}_",
        "",
        "Do **not** auto-apply. Each row is a suggested `+ skill` on the agent.",
        "",
        "## Half-bundle completions (highest confidence)",
        "",
        "| agent | add | because | lift | conf |",
        "|---|---|---|---:|---:|",
    ]
    for h in half[:40]:
        L.append(
            f"| {h['agent']} | `{h['add']}` | `{h['because']}` | {h['lift']} | {h['confidence']} |"
        )
    L += [
        "",
        "## Hybrid-CF top picks",
        "",
        "| agent | add | score | peers | lift_boost |",
        "|---|---|---:|---:|---:|",
    ]
    for r in cf_rows[:30]:
        L.append(
            f"| {r['agent']} | `{r['add']}` | {r['score']} | {r['peers']} | {r.get('lift_boost')} |"
        )
    L.append("")

    try:
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, "wiring-patch.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(L))
        with open(os.path.join(OUT, "wiring-patch.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
    except OSError as e:
        sys.exit(f"cannot write patch: {e}")

    print("wiring patch -> out/wiring-patch.md + .json")
    print(f"  half-bundles: {len(half)}  cf-top: {len(cf_rows)}")
    if half:
        h0 = half[0]
        print(
            f"  top: {h0['agent']} +{h0['add']} (via {h0['because']}, lift={h0['lift']})"
        )


if __name__ == "__main__":
    main()
