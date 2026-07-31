#!/usr/bin/env python3
"""Skill-wiring recommender — item-based collaborative filtering over the harness graph.

Turns the graph from detection into recommendation: for each agent, finds peer agents with
high skill overlap, then recommends skills those peers wire that this agent is missing. This
is the actionable "wire" side of orphan triage — recommendation-only, never auto-edits agents.

Scoring: rec(agent, skill) = Σ_peer  jaccard(agent, peer)   over peers that wire `skill`
and where `skill` ∉ agent.skills. Higher = more peers-like-you use it.

Usage:
  python3 recommend-wiring.py                 # full report -> out/wiring-recommendations.md
  python3 recommend-wiring.py --agent NAME    # recommendations for one agent
"""
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GRAPH = os.path.join(OUT, "harness-graph.json")

MIN_OVERLAP = 0.30   # peer must share >=30% of skills (Jaccard)
MIN_PEERS = 3        # a recommendation needs >=3 supporting peers
TOP_PER_AGENT = 5


def load():
    try:
        with open(GRAPH) as f:
            g = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"cannot load graph: {e} — run build-harness-graph.mjs first")
    agent_skills = defaultdict(set)
    for e in g["edges"]:
        if e["type"] == "agent->skill" and e.get("tier") != "dead":
            agent_skills[e["from"].split(":", 1)[1]].add(e["to"].split(":", 1)[1])
    return {a: s for a, s in agent_skills.items() if s}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def recommend(agent_skills, target):
    mine = agent_skills.get(target, set())
    if not mine:
        return []
    # peers by skill overlap
    peers = []
    for other, oskills in agent_skills.items():
        if other == target:
            continue
        sim = jaccard(mine, oskills)
        if sim >= MIN_OVERLAP:
            peers.append((other, sim, oskills))
    # score candidate skills the agent is missing
    score = defaultdict(float)
    support = defaultdict(int)
    for _other, sim, oskills in peers:
        for sk in oskills - mine:
            score[sk] += sim
            support[sk] += 1
    recs = [(sk, round(sc, 3), support[sk]) for sk, sc in score.items() if support[sk] >= MIN_PEERS]
    recs.sort(key=lambda r: (-r[1], -r[2]))
    return recs[:TOP_PER_AGENT]


def main():
    agent_skills = load()
    args = sys.argv[1:]
    if "--agent" in args:
        name = args[args.index("--agent") + 1]
        recs = recommend(agent_skills, name)
        print(f"# wiring recommendations for {name}")
        for sk, sc, sup in recs:
            print(f"  {sc:>5}  ({sup} peers)  {sk}")
        if not recs:
            print("  (none — agent has no peers above overlap threshold, or is fully equipped)")
        return

    all_recs = {}
    agg = defaultdict(int)
    for agent in agent_skills:
        r = recommend(agent_skills, agent)
        if r:
            all_recs[agent] = r
            for sk, _sc, _sup in r:
                agg[sk] += 1

    L = ["# Skill-Wiring Recommendations (item-based CF)", "",
         f"Agents with recommendations: **{len(all_recs)}** / {len(agent_skills)}. "
         f"Recommendation-only — review before wiring; never auto-applied.", "",
         f"_thresholds: peer-overlap ≥ {MIN_OVERLAP}, min supporting peers ≥ {MIN_PEERS}_", "",
         "## Most-recommended skills (wire these to raise coverage)", "",
         "| skill | #agents recommended for |", "|---|---:|"]
    for sk, n in sorted(agg.items(), key=lambda x: -x[1])[:20]:
        L.append(f"| {sk} | {n} |")

    L += ["", "## Per-agent recommendations (top 40 agents)", ""]
    for agent, recs in sorted(all_recs.items(), key=lambda x: -len(x[1]))[:40]:
        pretty = ", ".join(f"{sk}({sup})" for sk, _sc, sup in recs)
        L.append(f"- **{agent}** → {pretty}")

    try:
        with open(os.path.join(OUT, "wiring-recommendations.md"), "w") as f:
            f.write("\n".join(L) + "\n")
    except OSError as e:
        sys.exit(f"cannot write report: {e}")

    print("wiring recommendations -> out/wiring-recommendations.md")
    print(f"  agents with recs: {len(all_recs)}/{len(agent_skills)}  distinct recommended skills: {len(agg)}")
    top = sorted(agg.items(), key=lambda x: -x[1])[:6]
    for sk, n in top:
        print(f"    {n}\t{sk}")


if __name__ == "__main__":
    main()
