#!/usr/bin/env python3
"""Harness graph analyzer — structural intelligence over harness-graph.json.

Bipartite-aware: agent → {skill,hook,mcp}. Classical articulation_points on the
undirected skeleton only finds leaf-bridge *agents* (private skills), never the
shared hubs that are the real single points of failure. Criticality is therefore
blast-radius + sole-provider loss, not DFS articulation.

Usage:
  python3 graph_analyze.py                 # full report -> out/graph-analysis.md|.json
  python3 graph_analyze.py --reach AGENT   # everything an agent can reach
  python3 graph_analyze.py --impact NODE   # blast radius if a node is removed
  python3 graph_analyze.py --json          # machine-readable only to stdout
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from typing import Any

import networkx as nx

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GRAPH = os.path.join(OUT, "harness-graph.json")
CAP_TYPES = frozenset({"skill", "hook", "mcp"})


def load() -> nx.DiGraph:
    try:
        with open(GRAPH, encoding="utf-8") as f:
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
            dead=n.get("dead", False),
        )
    for e in g["edges"]:
        G.add_edge(e["from"], e["to"], type=e["type"], tier=e.get("tier"))
    return G


def _resolve(G: nx.DiGraph, start: str) -> str | None:
    if start in G:
        return start
    cands = [n for n in G if n.endswith(":" + start) or n == start]
    return cands[0] if cands else None


def reach(G: nx.DiGraph, start: str) -> tuple[str, dict[str, list[str]]] | None:
    node = _resolve(G, start)
    if node is None:
        return None
    by: dict[str, list[str]] = defaultdict(list)
    for n in nx.descendants(G, node):
        by[G.nodes[n]["type"]].append(G.nodes[n]["name"])
    return node, {k: sorted(v) for k, v in by.items()}


def impact(G: nx.DiGraph, name: str) -> tuple[str, list[str]] | None:
    target = _resolve(G, name)
    if target is None:
        return None
    agents = sorted(
        G.nodes[n]["name"]
        for n in nx.ancestors(G, target)
        if G.nodes[n]["type"] == "agent"
    )
    return target, agents


def leaf_bridge_agents(G: nx.DiGraph) -> list[tuple[str, int, list[str]]]:
    """Agents that are classical articulation points — they alone bridge private caps."""
    U = G.to_undirected()
    rows: list[tuple[str, int, list[str]]] = []
    for a in nx.articulation_points(U):
        if G.nodes[a]["type"] != "agent":
            continue
        priv = sorted(
            G.nodes[n]["name"]
            for n in G.successors(a)
            if G.nodes[n]["type"] in CAP_TYPES and G.degree(n) == 1
        )
        if priv:
            rows.append((G.nodes[a]["name"], len(priv), priv[:8]))
    return sorted(rows, key=lambda r: -r[1])


def capability_criticality(G: nx.DiGraph, top: int = 25) -> list[dict[str, Any]]:
    """Rank caps by agent blast radius and sole-provider loss (bipartite SPOF)."""
    agent_caps: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for u, v, d in G.edges(data=True):
        if G.nodes[u]["type"] != "agent":
            continue
        typ = G.nodes[v]["type"]
        if typ not in CAP_TYPES:
            continue
        agent_caps[u][typ].add(v)

    rows: list[dict[str, Any]] = []
    for n in G:
        typ = G.nodes[n]["type"]
        if typ not in CAP_TYPES:
            continue
        agents = [p for p in G.predecessors(n) if G.nodes[p]["type"] == "agent"]
        if not agents:
            continue
        sole = [G.nodes[a]["name"] for a in agents if agent_caps[a][typ] == {n}]
        rows.append(
            {
                "id": n,
                "name": G.nodes[n]["name"],
                "type": typ,
                "tier": G.nodes[n].get("tier")
                or ("dead" if G.nodes[n].get("dead") else "live"),
                "agents": len(agents),
                "sole_provider_agents": len(sole),
                "sole_examples": sole[:6],
                "dead": bool(
                    G.nodes[n].get("dead") or G.nodes[n].get("tier") == "dead"
                ),
                # composite: blast radius weighted by sole-provider severity
                "score": len(agents) + 3 * len(sole),
            }
        )
    rows.sort(key=lambda r: (-r["score"], -r["agents"], r["name"]))
    return rows[:top]


def edge_concentration(G: nx.DiGraph) -> dict[str, Any]:
    """Top-hub share of agent→cap edges — high concentration = systemic SPOF risk."""
    by_type: dict[str, list[int]] = defaultdict(list)
    totals: dict[str, int] = defaultdict(int)
    hubs: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for n in G:
        typ = G.nodes[n]["type"]
        if typ not in CAP_TYPES:
            continue
        ib = sum(1 for p in G.predecessors(n) if G.nodes[p]["type"] == "agent")
        if ib <= 0:
            continue
        by_type[typ].append(ib)
        totals[typ] += ib
        hubs[typ].append((G.nodes[n]["name"], ib))
    out: dict[str, Any] = {}
    for typ, vals in by_type.items():
        vals_sorted = sorted(vals, reverse=True)
        total = totals[typ] or 1
        top1 = vals_sorted[0] / total
        top3 = sum(vals_sorted[:3]) / total
        out[typ] = {
            "edges": total,
            "top1_share": round(top1, 4),
            "top3_share": round(top3, 4),
            "top": sorted(hubs[typ], key=lambda x: -x[1])[:5],
        }
    return out


def cycles(G: nx.DiGraph) -> list[list[str]]:
    cyc: list[list[str]] = []
    for comp in nx.strongly_connected_components(G):
        if len(comp) > 1:
            cyc.append(sorted(G.nodes[n]["name"] for n in comp))
    return cyc[:20]


def _agent_skill_sets(G: nx.DiGraph) -> dict[str, set[str]]:
    """agent_name -> set of skill names (non-dead edges only)."""
    out: dict[str, set[str]] = defaultdict(set)
    for u, v, d in G.edges(data=True):
        if G.nodes[u]["type"] != "agent" or G.nodes[v]["type"] != "skill":
            continue
        if d.get("tier") == "dead" or G.nodes[v].get("tier") == "dead":
            continue
        out[G.nodes[u]["name"]].add(G.nodes[v]["name"])
    return {a: s for a, s in out.items() if s}


def _skill_agent_index(
    agent_skills: dict[str, set[str]],
) -> dict[str, set[str]]:
    inv: dict[str, set[str]] = defaultdict(set)
    for agent, skills in agent_skills.items():
        for sk in skills:
            inv[sk].add(agent)
    return inv


def skill_projection(G: nx.DiGraph, min_shared: int = 2) -> nx.Graph:
    """Weighted skill–skill graph: edge weight = #agents wiring both skills."""
    agent_skills = _agent_skill_sets(G)
    inv = _skill_agent_index(agent_skills)
    H = nx.Graph()
    skills = sorted(inv)
    H.add_nodes_from(skills)
    n = len(skills)
    for i in range(n):
        a = skills[i]
        sa = inv[a]
        if len(sa) < min_shared:
            continue
        for j in range(i + 1, n):
            b = skills[j]
            shared = len(sa & inv[b])
            if shared >= min_shared:
                H.add_edge(a, b, weight=shared)
    return H


def communities(G: nx.DiGraph, min_shared: int = 2) -> list[dict[str, Any]]:
    """Skill communities via weighted projection + modularity (not raw WCC).

    Raw WCC on agent+skill collapses into one giant blob because hubs bridge
    everything. Project skills, threshold co-usage, then Louvain/greedy modularity.
    """
    agent_skills = _agent_skill_sets(G)
    inv = _skill_agent_index(agent_skills)
    H = skill_projection(G, min_shared=min_shared)
    if H.number_of_edges() == 0:
        return []

    try:
        from networkx.algorithms.community import louvain_communities

        parts = list(louvain_communities(H, weight="weight", seed=0))
        method = "louvain"
    except Exception:
        from networkx.algorithms.community import greedy_modularity_communities

        parts = list(greedy_modularity_communities(H, weight="weight"))
        method = "greedy_modularity"

    parts = [p for p in parts if len(p) >= 3]
    parts.sort(key=len, reverse=True)
    out: list[dict[str, Any]] = []
    for rank, part in enumerate(parts[:12], 1):
        skills = sorted(part)
        touch: dict[str, int] = defaultdict(int)
        for sk in skills:
            for ag in inv.get(sk, ()):
                touch[ag] += 1
        core_agents = sorted(a for a, k in touch.items() if k >= 2)
        sub = H.subgraph(skills)
        n_e = sub.number_of_edges()
        n_v = sub.number_of_nodes()
        max_e = n_v * (n_v - 1) / 2 or 1
        top_pairs = sorted(
            ((u, v, d["weight"]) for u, v, d in sub.edges(data=True)),
            key=lambda t: -t[2],
        )[:5]
        out.append(
            {
                "id": rank,
                "method": method,
                "skills": skills[:30],
                "skill_count": len(skills),
                "agents": len(core_agents),
                "agent_examples": core_agents[:8],
                "density": round(n_e / max_e, 4),
                "top_pairs": [
                    {"a": a, "b": b, "shared_agents": w} for a, b, w in top_pairs
                ],
            }
        )
    return out


def association_rules(
    G: nx.DiGraph,
    min_support: int = 4,
    min_lift: float = 2.0,
    top: int = 40,
) -> list[dict[str, Any]]:
    """Skill association rules: lift(A,B) = |A∩B|·N / (|A|·|B|)."""
    agent_skills = _agent_skill_sets(G)
    if not agent_skills:
        return []
    n_agents = len(agent_skills)
    inv = _skill_agent_index(agent_skills)
    skills = sorted(s for s, ags in inv.items() if len(ags) >= min_support)
    rows: list[dict[str, Any]] = []
    for i, a in enumerate(skills):
        sa = inv[a]
        na = len(sa)
        for b in skills[i + 1 :]:
            sb = inv[b]
            both = len(sa & sb)
            if both < min_support:
                continue
            nb = len(sb)
            lift = (both * n_agents) / (na * nb)
            if lift < min_lift:
                continue
            rows.append(
                {
                    "a": a,
                    "b": b,
                    "support": both,
                    "support_frac": round(both / n_agents, 4),
                    "lift": round(lift, 3),
                    "confidence_a_to_b": round(both / na, 3),
                    "confidence_b_to_a": round(both / nb, 3),
                    "freq_a": na,
                    "freq_b": nb,
                }
            )
    rows.sort(key=lambda r: (-r["lift"], -r["support"], r["a"], r["b"]))
    return rows[:top]


def skill_redundancy(
    G: nx.DiGraph, min_jaccard: float = 0.7, top: int = 25
) -> list[dict[str, Any]]:
    """Near-duplicate skills by agent-set Jaccard (merge/dedup candidates)."""
    inv = _skill_agent_index(_agent_skill_sets(G))
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
            if jac >= min_jaccard:
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


def dead_cut(G: nx.DiGraph) -> list[tuple[str, str, int, list[str]]]:
    rows: list[tuple[str, str, int, list[str]]] = []
    for n in G:
        dead = G.nodes[n].get("tier") == "dead" or (
            G.nodes[n]["type"] in ("hook", "mcp") and G.nodes[n].get("dead")
        )
        if not dead:
            continue
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


def analyze(G: nx.DiGraph) -> dict[str, Any]:
    crit = capability_criticality(G)
    comms = communities(G)
    rules = association_rules(G)
    redun = skill_redundancy(G)
    return {
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "density": round(nx.density(G), 5),
        "weak_components": nx.number_weakly_connected_components(G),
        "critical_capabilities": crit,
        "leaf_bridge_agents": [
            {"agent": a, "private_caps": n, "examples": ex}
            for a, n, ex in leaf_bridge_agents(G)[:20]
        ],
        "concentration": edge_concentration(G),
        "cycles": cycles(G),
        "communities": comms,
        "association_rules": rules,
        "skill_redundancy": redun,
        "dead_cut": [
            {"name": n, "type": t, "agents": c, "examples": a}
            for n, t, c, a in dead_cut(G)[:40]
        ],
    }


def render_md(data: dict[str, Any]) -> str:
    L = [
        "# Harness Graph — Structural Analysis (networkx)",
        "",
        f"nodes: {data['nodes']}  edges: {data['edges']}  "
        f"density: {data['density']}  weak-components: {data['weak_components']}",
        "",
        "## 1. Capability criticality (bipartite SPOF)",
        "",
        "> Classical articulation_points only finds leaf-bridge agents in this",
        "> agent→capability digraph. Real SPOFs are high-inbound caps, especially",
        "> those that are an agent's *sole* provider of that type.",
        "",
        "| node | type | agents | sole-provider | score | tier |",
        "|---|---|---:|---:|---:|---|",
    ]
    for r in data["critical_capabilities"][:20]:
        L.append(
            f"| {r['name']} | {r['type']} | {r['agents']} | "
            f"{r['sole_provider_agents']} | {r['score']} | {r['tier']} |"
        )
    L += ["", "## 2. Edge concentration (hub risk)", ""]
    conc = data["concentration"]
    if not conc:
        L.append("(no capability edges)")
    else:
        L += [
            "| type | edges | top1 share | top3 share | top hubs |",
            "|---|---:|---:|---:|---|",
        ]
        for typ, c in conc.items():
            hubs = ", ".join(f"{n}({k})" for n, k in c["top"][:3])
            L.append(
                f"| {typ} | {c['edges']} | {c['top1_share']:.1%} | "
                f"{c['top3_share']:.1%} | {hubs} |"
            )

    L += [
        "",
        "## 3. Leaf-bridge agents (private-cap articulations)",
        "",
        "> These agents alone connect one or more private capabilities. Lower risk",
        "> than shared hubs; useful for merge/dedup decisions.",
        "",
    ]
    bridges = data["leaf_bridge_agents"]
    if not bridges:
        L.append("(none)")
    else:
        L += ["| agent | #private caps | examples |", "|---|---:|---|"]
        for b in bridges[:15]:
            L.append(
                f"| {b['agent']} | {b['private_caps']} | {', '.join(b['examples'])} |"
            )

    L += ["", "## 4. Dependency cycles (should be ~0 in a clean DAG)", ""]
    if not data["cycles"]:
        L.append("✅ none — the harness wiring is acyclic.")
    else:
        for c in data["cycles"]:
            L.append("- cycle: " + " ↔ ".join(c))

    L += [
        "",
        "## 5. Skill communities (projection + modularity)",
        "",
        "> Weighted skill–skill projection (edge = shared agents ≥2), then Louvain/",
        "> greedy modularity. Replaces the old WCC blob that glued ~all agents together.",
        "",
    ]
    if not data["communities"]:
        L.append("(none — projection empty or below thresholds)")
    for c in data["communities"]:
        method = c.get("method", "?")
        L.append(
            f"### cluster {c.get('id', '?')} — {c['skill_count']} skills, "
            f"{c['agents']} core agents, density={c.get('density', '?')} ({method})"
        )
        L.append("```\n" + "  ".join(c["skills"]) + "\n```")
        if c.get("top_pairs"):
            pairs = ", ".join(
                f"{p['a']}↔{p['b']}({p['shared_agents']})" for p in c["top_pairs"][:3]
            )
            L.append(f"strong pairs: {pairs}")
        if c.get("agent_examples"):
            L.append("core agents: " + ", ".join(c["agent_examples"]))
        L.append("")

    L += [
        "## 6. Association rules (lift ≥ 2, support ≥ 4)",
        "",
        "> lift(A,B) = P(A∧B)/(P(A)P(B)). High lift = real bundle, not popular-hub noise.",
        "",
    ]
    rules = data.get("association_rules") or []
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
    L.append("")

    L += [
        "## 7. Skill redundancy (agent-set Jaccard ≥ 0.7)",
        "",
        "> Near-duplicate skills — merge/dedup candidates, not auto-delete.",
        "",
    ]
    redun = data.get("skill_redundancy") or []
    if not redun:
        L.append("(none above threshold)")
    else:
        L += [
            "| jaccard | shared | only A | only B | A | B |",
            "|---:|---:|---:|---:|---|---|",
        ]
        for r in redun[:15]:
            L.append(
                f"| {r['jaccard']} | {r['shared_agents']} | {r['only_a']} | "
                f"{r['only_b']} | {r['a']} | {r['b']} |"
            )
    L.append("")

    L += [
        "## 8. Dead-node cut list (ranked fix backlog)",
        "",
        "| node | type | #agents | example agents |",
        "|---|---|---:|---|",
    ]
    for d in data["dead_cut"][:25]:
        L.append(
            f"| {d['name']} | {d['type']} | {d['agents']} | {', '.join(d['examples'])} |"
        )
    L.append("")
    return "\n".join(L)


def main() -> None:
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

    data = analyze(G)
    if "--json" in args:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    md = render_md(data)
    try:
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, "graph-analysis.md"), "w", encoding="utf-8") as f:
            f.write(md)
        with open(os.path.join(OUT, "graph-analysis.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except OSError as e:
        sys.exit(f"cannot write analysis report: {e}")

    print("structural analysis -> out/graph-analysis.md + graph-analysis.json")
    top = data["critical_capabilities"][:3]
    top_s = ", ".join(f"{r['name']}({r['agents']})" for r in top) or "(none)"
    print(
        f"  critical-caps: {len(data['critical_capabilities'])}  "
        f"leaf-bridges: {len(data['leaf_bridge_agents'])}  "
        f"cycles: {len(data['cycles'])}  communities: {len(data['communities'])}  "
        f"rules: {len(data.get('association_rules') or [])}  "
        f"redundancy: {len(data.get('skill_redundancy') or [])}  "
        f"dead-cut: {len(data['dead_cut'])}"
    )
    print(f"  top SPOF: {top_s}")
    if data["communities"]:
        c0 = data["communities"][0]
        print(
            f"  top community: {c0['skill_count']} skills / {c0['agents']} agents "
            f"({c0.get('method', '?')})"
        )
    if data.get("association_rules"):
        r0 = data["association_rules"][0]
        print(
            f"  top rule: {r0['a']} ↔ {r0['b']} lift={r0['lift']} sup={r0['support']}"
        )


if __name__ == "__main__":
    main()
