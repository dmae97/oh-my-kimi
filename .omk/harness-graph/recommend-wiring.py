#!/usr/bin/env python3
"""Skill-wiring recommender — hybrid CF over the harness graph.

v2 scoring (per missing skill s for agent a):

  score(a,s) = Σ_{peer p that has s}  sim(a,p) · idf(s) · lift_boost(a,s)

where
  sim      = Jaccard on skill sets (peer filter ≥ MIN_OVERLAP)
  idf(s)   = log(1 + N / df(s))          — down-weight ubiquitous skills
  lift_boost = 1 + mean(max(0, log2(lift(owned,s)))) over owned skills with
               an association edge to s  — prefer real bundles over hub noise

Also emits global high-lift bundles and near-duplicate skill pairs so the
report is actionable beyond per-agent lists. Recommendation-only — never
auto-edits agents.

Usage:
  python3 recommend-wiring.py                 # full report
  python3 recommend-wiring.py --agent NAME    # one agent
  python3 recommend-wiring.py --json          # machine-readable
"""

from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GRAPH = os.path.join(OUT, "harness-graph.json")

MIN_OVERLAP = 0.30
MIN_PEERS = 3
TOP_PER_AGENT = 5
MIN_LIFT = 2.0
MIN_SUPPORT = 4
MIN_REDUNDANCY = 0.7


def load_graph() -> dict[str, Any]:
    try:
        with open(GRAPH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"cannot load graph: {e} — run build-harness-graph.mjs first")


def agent_skills_from(g: dict[str, Any]) -> dict[str, set[str]]:
    agent_skills: dict[str, set[str]] = defaultdict(set)
    for e in g["edges"]:
        if e["type"] == "agent->skill" and e.get("tier") != "dead":
            agent_skills[e["from"].split(":", 1)[1]].add(e["to"].split(":", 1)[1])
    return {a: s for a, s in agent_skills.items() if s}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def skill_df(agent_skills: dict[str, set[str]]) -> dict[str, int]:
    df: dict[str, int] = defaultdict(int)
    for skills in agent_skills.values():
        for s in skills:
            df[s] += 1
    return dict(df)


def idf_table(df: dict[str, int], n_agents: int) -> dict[str, float]:
    return {s: math.log(1.0 + n_agents / max(c, 1)) for s, c in df.items()}


def build_lift_index(
    agent_skills: dict[str, set[str]],
    min_support: int = MIN_SUPPORT,
    min_lift: float = MIN_LIFT,
) -> dict[str, dict[str, float]]:
    """skill -> {other_skill: lift} for pairs above thresholds."""
    n = len(agent_skills)
    if n == 0:
        return {}
    inv: dict[str, set[str]] = defaultdict(set)
    for ag, skills in agent_skills.items():
        for s in skills:
            inv[s].add(ag)
    skills = sorted(s for s, ags in inv.items() if len(ags) >= min_support)
    idx: dict[str, dict[str, float]] = defaultdict(dict)
    for i, a in enumerate(skills):
        sa = inv[a]
        na = len(sa)
        for b in skills[i + 1 :]:
            both = len(sa & inv[b])
            if both < min_support:
                continue
            nb = len(inv[b])
            lift = (both * n) / (na * nb)
            if lift < min_lift:
                continue
            idx[a][b] = lift
            idx[b][a] = lift
    return idx


def lift_boost(
    owned: set[str], candidate: str, lift_idx: dict[str, dict[str, float]]
) -> float:
    """1 + mean positive log2(lift) from owned skills to candidate."""
    lifts = [lift_idx[o][candidate] for o in owned if candidate in lift_idx.get(o, ())]
    if not lifts:
        return 1.0
    # log2 so lift=2 → +1, lift=4 → +2; clamp floor at 0
    vals = [max(0.0, math.log2(L)) for L in lifts]
    return 1.0 + (sum(vals) / len(vals))


def association_rows(
    lift_idx: dict[str, dict[str, float]],
    df: dict[str, int],
    n_agents: int,
    top: int = 30,
) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    rows: list[dict[str, Any]] = []
    for a, others in lift_idx.items():
        for b, lift in others.items():
            key = (a, b) if a < b else (b, a)
            if key in seen:
                continue
            seen.add(key)
            # reconstruct support from lift: support = lift * na * nb / N
            na, nb = df.get(a, 0), df.get(b, 0)
            if na == 0 or nb == 0 or n_agents == 0:
                continue
            support = int(round(lift * na * nb / n_agents))
            rows.append(
                {
                    "a": key[0],
                    "b": key[1],
                    "lift": round(lift, 3),
                    "support": support,
                    "confidence_a_to_b": round(support / df[key[0]], 3)
                    if df.get(key[0])
                    else 0,
                    "confidence_b_to_a": round(support / df[key[1]], 3)
                    if df.get(key[1])
                    else 0,
                }
            )
    rows.sort(key=lambda r: (-r["lift"], -r["support"]))
    return rows[:top]


def redundancy_rows(
    agent_skills: dict[str, set[str]], min_j: float = MIN_REDUNDANCY, top: int = 20
) -> list[dict[str, Any]]:
    inv: dict[str, set[str]] = defaultdict(set)
    for ag, skills in agent_skills.items():
        for s in skills:
            inv[s].add(ag)
    skills = sorted(s for s, ags in inv.items() if len(ags) >= 2)
    rows: list[dict[str, Any]] = []
    for i, a in enumerate(skills):
        sa = inv[a]
        for b in skills[i + 1 :]:
            sb = inv[b]
            inter = len(sa & sb)
            if inter == 0:
                continue
            jac = inter / len(sa | sb)
            if jac >= min_j:
                rows.append(
                    {
                        "a": a,
                        "b": b,
                        "jaccard": round(jac, 3),
                        "shared_agents": inter,
                        "only_a": len(sa - sb),
                        "only_b": len(sb - sa),
                    }
                )
    rows.sort(key=lambda r: (-r["jaccard"], -r["shared_agents"]))
    return rows[:top]


def recommend(
    agent_skills: dict[str, set[str]],
    target: str,
    *,
    df: dict[str, int] | None = None,
    idf: dict[str, float] | None = None,
    lift_idx: dict[str, dict[str, float]] | None = None,
    n_agents: int | None = None,
) -> list[tuple[str, float, int, dict[str, float]]]:
    """Return [(skill, score, support_peers, components)]."""
    mine = agent_skills.get(target, set())
    if not mine:
        return []
    n = n_agents if n_agents is not None else len(agent_skills)
    if df is None:
        df = skill_df(agent_skills)
    if idf is None:
        idf = idf_table(df, n)
    if lift_idx is None:
        lift_idx = build_lift_index(agent_skills)

    peers: list[tuple[str, float, set[str]]] = []
    for other, oskills in agent_skills.items():
        if other == target:
            continue
        sim = jaccard(mine, oskills)
        if sim >= MIN_OVERLAP:
            peers.append((other, sim, oskills))

    score: dict[str, float] = defaultdict(float)
    support: dict[str, int] = defaultdict(int)
    # track component sums for explainability
    sim_part: dict[str, float] = defaultdict(float)
    idf_part: dict[str, float] = defaultdict(float)
    lift_part: dict[str, float] = defaultdict(float)

    for _other, sim, oskills in peers:
        for sk in oskills - mine:
            w_idf = idf.get(sk, math.log(1.0 + n))  # unseen → max-ish idf
            w_lift = lift_boost(mine, sk, lift_idx)
            contrib = sim * w_idf * w_lift
            score[sk] += contrib
            support[sk] += 1
            sim_part[sk] += sim
            idf_part[sk] = w_idf
            lift_part[sk] = w_lift

    recs: list[tuple[str, float, int, dict[str, float]]] = []
    for sk, sc in score.items():
        if support[sk] < MIN_PEERS:
            continue
        recs.append(
            (
                sk,
                round(sc, 3),
                support[sk],
                {
                    "avg_peer_sim": round(sim_part[sk] / support[sk], 3),
                    "idf": round(idf_part[sk], 3),
                    "lift_boost": round(lift_part[sk], 3),
                },
            )
        )
    recs.sort(key=lambda r: (-r[1], -r[2], r[0]))
    return recs[:TOP_PER_AGENT]


def render_md(
    all_recs: dict[str, list[tuple[str, float, int, dict[str, float]]]],
    agent_skills: dict[str, set[str]],
    rules: list[dict[str, Any]],
    redun: list[dict[str, Any]],
    agg: dict[str, int],
) -> str:
    L = [
        "# Skill-Wiring Recommendations (hybrid CF + lift)",
        "",
        f"Agents with recommendations: **{len(all_recs)}** / {len(agent_skills)}. "
        "Recommendation-only — review before wiring; never auto-applied.",
        "",
        f"_score = Σ peer_jaccard · idf(skill) · lift_boost(owned→skill); "
        f"peer-overlap ≥ {MIN_OVERLAP}, min peers ≥ {MIN_PEERS}, "
        f"lift bundle ≥ {MIN_LIFT}_",
        "",
        "## Most-recommended skills",
        "",
        "| skill | #agents |",
        "|---|---:|",
    ]
    for sk, n in sorted(agg.items(), key=lambda x: -x[1])[:20]:
        L.append(f"| {sk} | {n} |")

    L += [
        "",
        "## High-lift bundles (wire together)",
        "",
        "> Pairs that co-occur far above chance. If an agent has A but not B (high conf), wire B.",
        "",
    ]
    if not rules:
        L.append("(none above thresholds)")
    else:
        L += [
            "| lift | support | conf A→B | conf B→A | A | B |",
            "|---:|---:|---:|---:|---|---|",
        ]
        for r in rules[:20]:
            L.append(
                f"| {r['lift']} | {r['support']} | {r['confidence_a_to_b']} | "
                f"{r['confidence_b_to_a']} | {r['a']} | {r['b']} |"
            )

    L += [
        "",
        "## Near-duplicate skills (dedup candidates)",
        "",
    ]
    if not redun:
        L.append("(none above Jaccard 0.7)")
    else:
        L += ["| jaccard | shared | A | B |", "|---:|---:|---|---|"]
        for r in redun[:15]:
            L.append(f"| {r['jaccard']} | {r['shared_agents']} | {r['a']} | {r['b']} |")

    L += ["", "## Per-agent recommendations (top 40)", ""]
    for agent, recs in sorted(all_recs.items(), key=lambda x: -len(x[1]))[:40]:
        parts = []
        for sk, sc, sup, comp in recs:
            parts.append(
                f"{sk}[s={sc},p={sup},idf={comp['idf']},lb={comp['lift_boost']}]"
            )
        L.append(f"- **{agent}** → " + ", ".join(parts))
    L.append("")
    return "\n".join(L)


def main() -> None:
    g = load_graph()
    agent_skills = agent_skills_from(g)
    n = len(agent_skills)
    df = skill_df(agent_skills)
    idf = idf_table(df, n)
    lift_idx = build_lift_index(agent_skills)
    rules = association_rows(lift_idx, df, n)
    redun = redundancy_rows(agent_skills)

    args = sys.argv[1:]
    if "--agent" in args:
        name = args[args.index("--agent") + 1]
        recs = recommend(
            agent_skills, name, df=df, idf=idf, lift_idx=lift_idx, n_agents=n
        )
        print(f"# wiring recommendations for {name}")
        for sk, sc, sup, comp in recs:
            print(
                f"  {sc:>7}  peers={sup}  idf={comp['idf']}  "
                f"lift_boost={comp['lift_boost']}  {sk}"
            )
        if not recs:
            print("  (none — no peers above overlap, or fully equipped)")
        return

    all_recs: dict[str, list[tuple[str, float, int, dict[str, float]]]] = {}
    agg: dict[str, int] = defaultdict(int)
    for agent in agent_skills:
        r = recommend(
            agent_skills, agent, df=df, idf=idf, lift_idx=lift_idx, n_agents=n
        )
        if r:
            all_recs[agent] = r
            for sk, _sc, _sup, _c in r:
                agg[sk] += 1

    payload = {
        "algorithm": "hybrid_cf_idf_lift",
        "thresholds": {
            "min_overlap": MIN_OVERLAP,
            "min_peers": MIN_PEERS,
            "min_lift": MIN_LIFT,
            "min_support": MIN_SUPPORT,
        },
        "agents_with_recs": len(all_recs),
        "agents_total": n,
        "per_agent": {
            a: [
                {
                    "skill": sk,
                    "score": sc,
                    "peers": sup,
                    **comp,
                }
                for sk, sc, sup, comp in recs
            ]
            for a, recs in all_recs.items()
        },
        "top_recommended": sorted(agg.items(), key=lambda x: -x[1])[:30],
        "association_rules": rules,
        "skill_redundancy": redun,
    }

    if "--json" in args:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    md = render_md(all_recs, agent_skills, rules, redun, agg)
    try:
        os.makedirs(OUT, exist_ok=True)
        with open(
            os.path.join(OUT, "wiring-recommendations.md"), "w", encoding="utf-8"
        ) as f:
            f.write(md + "\n")
        with open(
            os.path.join(OUT, "wiring-recommendations.json"), "w", encoding="utf-8"
        ) as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
    except OSError as e:
        sys.exit(f"cannot write report: {e}")

    print("wiring recommendations -> out/wiring-recommendations.md + .json")
    print(
        f"  agents with recs: {len(all_recs)}/{n}  "
        f"distinct skills: {len(agg)}  rules: {len(rules)}  redundancy: {len(redun)}"
    )
    top = sorted(agg.items(), key=lambda x: -x[1])[:6]
    for sk, cnt in top:
        print(f"    {cnt}\t{sk}")
    if rules:
        r0 = rules[0]
        print(
            f"  top lift: {r0['a']} ↔ {r0['b']} lift={r0['lift']} sup={r0['support']}"
        )


if __name__ == "__main__":
    main()
