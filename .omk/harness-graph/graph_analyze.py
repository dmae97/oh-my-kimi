#!/usr/bin/env python3
"""Harness graph analyzer — structural graph intelligence over harness-graph.json.

Upgrades the harness loop from flat JSON queries to real graph analysis (networkx):
reachability, articulation points (single points of failure), condensation cycles,
community detection, and a ranked dead-node cut list. Stdlib + networkx only.

Usage:
  python3 graph_analyze.py                 # full report -> out/graph-analysis.md
  python3 graph_analyze.py --reach AGENT   # everything an agent can reach
  python3 graph_analyze.py --impact SKILL  # blast radius if a node is removed
"""

import json
import sys
import os
from collections import defaultdict
import networkx as nx

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GRAPH = os.path.join(OUT, "harness-graph.json")


def load():
    try:
        with open(GRAPH) as f:
            g = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(
            f"cannot load harness graph at {GRAPH}: {e} — run build-harness-graph.mjs first"
        )
    G = nx.DiGraph()
    for n in g["nodes"]:
        G.add_node(
            n["id"],
            type=n["type"],
            name=n["name"],
            tier=n.get("tier"),
            inbound=n.get("inbound", 0),
        )
    for e in g["edges"]:
        G.add_edge(e["from"], e["to"], type=e["type"], tier=e.get("tier"))
    return G


def reach(G, start):
    """All nodes reachable from an agent (skills/hooks/mcp it can pull in)."""
    if start not in G:
        # try prefix match by name
        cands = [n for n in G if n.endswith(":" + start) or n == start]
        if not cands:
            return None
        start = cands[0]
    nodes = nx.descendants(G, start)
    by = defaultdict(list)
    for n in nodes:
        by[G.nodes[n]["type"]].append(G.nodes[n]["name"])
    return start, {k: sorted(v) for k, v in by.items()}


def impact(G, name):
    """Blast radius: agents that lose this node if it is removed (reverse reachability)."""
    cands = [n for n in G if n.endswith(":" + name) or n == name]
    if not cands:
        return None
    target = cands[0]
    preds = nx.ancestors(G, target)
    agents = sorted(G.nodes[n]["name"] for n in preds if G.nodes[n]["type"] == "agent")
    return target, agents


def articulation(G):
    """Single points of failure: nodes whose removal disconnects the undirected skeleton."""
    U = G.to_undirected()
    arts = nx.articulation_points(U)
    rows = []
    for a in arts:
        if G.nodes[a]["type"] in ("skill", "hook", "mcp"):
            rows.append(
                (G.nodes[a]["name"], G.nodes[a]["type"], G.nodes[a].get("inbound", 0))
            )
    return sorted(rows, key=lambda r: -r[2])


def cycles(G):
    """Dependency cycles among skill/hook/mcp (agents are sources, rarely in cycles)."""
    cond = nx.condensation(G)
    cyc = []
    for scc in cond.graph["mapping"].values():
        pass
    # strongly connected components with >1 node = real cycle
    for comp in nx.strongly_connected_components(G):
        if len(comp) > 1:
            cyc.append(sorted(G.nodes[n]["name"] for n in comp))
    return cyc[:20]


def communities(G):
    """Skill clusters by co-usage (agents linking the same skills). Weakly-connected components."""
    skill_nodes = [n for n in G if G.nodes[n]["type"] == "skill"]
    H = G.subgraph(
        skill_nodes + [n for n in G if G.nodes[n]["type"] == "agent"]
    ).to_undirected()
    comps = [c for c in nx.connected_components(H) if len(c) > 3]
    comps.sort(key=len, reverse=True)
    out = []
    for c in comps[:8]:
        skills = sorted(G.nodes[n]["name"] for n in c if G.nodes[n]["type"] == "skill")
        agents = [n for n in c if G.nodes[n]["type"] == "agent"]
        out.append(
            {"agents": len(agents), "skills": skills[:25], "skill_count": len(skills)}
        )
    return out


def dead_cut(G):
    """Ranked list of dead nodes + how many agents reference them (the fix backlog)."""
    rows = []
    for n in G:
        if G.nodes[n].get("tier") == "dead" or (
            G.nodes[n]["type"] in ("hook", "mcp") and G.nodes[n].get("dead")
        ):
            preds = [p for p in G.predecessors(n) if G.nodes[p]["type"] == "agent"]
            rows.append(
                (
                    G.nodes[n]["name"],
                    G.nodes[n]["type"],
                    len(preds),
                    sorted(G.nodes[p]["name"] for p in preds)[:6],
                )
            )
    return sorted(rows, key=lambda r: -r[2])


def main():
    G = load()
    args = sys.argv[1:]
    if "--reach" in args:
        r = reach(G, args[args.index("--reach") + 1])
        print(json.dumps(r, indent=1, ensure_ascii=False) if r else "not found")
        return
    if "--impact" in args:
        r = impact(G, args[args.index("--impact") + 1])
        if r:
            print(f"{r[0]} — removing breaks {len(r[1])} agents:\n  " + ", ".join(r[1]))
        else:
            print("not found")
        return

    arts = articulation(G)
    cyc = cycles(G)
    comms = communities(G)
    dead = dead_cut(G)

    L = ["# Harness Graph — Structural Analysis (networkx)", ""]
    L += [
        f"nodes: {G.number_of_nodes()}  edges: {G.number_of_edges()}  "
        f"density: {nx.density(G):.5f}",
        "",
    ]

    L += [
        "## 1. Single points of failure (articulation nodes)",
        "",
        "> Remove one of these and a chunk of the harness loses capability. Monitor/replicate these.",
        "",
        "| node | type | inbound |",
        "|---|---|---:|",
    ]
    for name, typ, ib in arts[:20]:
        L.append(f"| {name} | {typ} | {ib} |")
    L.append("")

    L += ["## 2. Dependency cycles (should be ~0 in a clean DAG)", ""]
    if not cyc:
        L.append("✅ none — the harness wiring is acyclic.")
    else:
        for c in cyc:
            L.append("- cycle: " + " ↔ ".join(c))
    L.append("")

    L += ["## 3. Skill communities (co-used clusters)", ""]
    for i, c in enumerate(comms, 1):
        L.append(f"### cluster {i} — {c['agents']} agents, {c['skill_count']} skills")
        L.append("```\n" + "  ".join(c["skills"]) + "\n```")
    L.append("")

    L += [
        "## 4. Dead-node cut list (ranked fix backlog)",
        "",
        "| node | type | #agents | example agents |",
        "|---|---|---:|---|",
    ]
    for name, typ, cnt, ags in dead[:25]:
        L.append(f"| {name} | {typ} | {cnt} | {', '.join(ags)} |")
    L.append("")

    try:
        with open(os.path.join(OUT, "graph-analysis.md"), "w") as f:
            f.write("\n".join(L))
    except OSError as e:
        sys.exit(f"cannot write analysis report: {e}")
    print("structural analysis -> out/graph-analysis.md")
    print(
        f"  articulation points: {len(arts)}  cycles: {len(cyc)}  communities: {len(comms)}  dead-cut: {len(dead)}"
    )


if __name__ == "__main__":
    main()
