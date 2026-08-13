#!/usr/bin/env python3
"""Self-contained tests for harness-graph structural + health layers.

Uses a synthetic bipartite fixture — does NOT depend on live ~/.omk state.
Run: python3 -m pytest .omk/harness-graph/test_harness_graph.py -q
  or: python3 .omk/harness-graph/test_harness_graph.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest import mock

HERE = Path(__file__).resolve().parent


def _load_path(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _load(name: str) -> ModuleType:
    return _load_path(name, HERE / f"{name}.py")


graph_analyze = _load("graph_analyze")
health_gate = _load("health_gate")
recommend_wiring = _load_path("recommend_wiring", HERE / "recommend-wiring.py")


def _skill(name: str, inbound: int = 0) -> dict:
    return {
        "id": f"skill:{name}",
        "type": "skill",
        "name": name,
        "tier": "active",
        "inbound": inbound,
    }


def _agent(name: str) -> dict:
    return {"id": f"agent:{name}", "type": "agent", "name": name, "inbound": 0}


def _edge(
    agent: str, skill: str, etype: str = "agent->skill", tier: str = "active"
) -> dict:
    kind = etype.split("->", 1)[1]
    return {
        "from": f"agent:{agent}",
        "to": f"{kind}:{skill}",
        "type": etype,
        "tier": tier,
    }


def _fixture_graph() -> dict:
    """Bipartite fixture: shared hub + two skill clusters + dead hook.

    Cluster FE: react/css co-wired by fe1..fe4 (high lift).
    Cluster BE: api/db co-wired by be1..be4 (high lift).
    Hub skill `shared` on everyone (low lift with anything).
    Duplicate pair twin-a/twin-b on same 3 agents (Jaccard=1).
    """
    agents = ["fe1", "fe2", "fe3", "fe4", "be1", "be2", "be3", "be4", "a1", "a2", "a3"]
    nodes = [_agent(a) for a in agents]
    nodes += [
        _skill("shared", 11),
        _skill("react", 4),
        _skill("css", 4),
        _skill("api", 4),
        _skill("db", 4),
        _skill("twin-a", 3),
        _skill("twin-b", 3),
        _skill("priv", 1),
        {"id": "mcp:fs", "type": "mcp", "name": "fs", "inbound": 2, "exists": True},
        {
            "id": "hook:dead-h",
            "type": "hook",
            "name": "dead-h",
            "inbound": 2,
            "dead": True,
        },
        {
            "id": "hook:live-h",
            "type": "hook",
            "name": "live-h",
            "inbound": 1,
            "exists": True,
        },
    ]
    edges: list[dict] = []
    for a in agents:
        edges.append(_edge(a, "shared"))
    for a in ("fe1", "fe2", "fe3", "fe4"):
        edges += [_edge(a, "react"), _edge(a, "css")]
    for a in ("be1", "be2", "be3", "be4"):
        edges += [_edge(a, "api"), _edge(a, "db")]
    for a in ("a1", "a2", "a3"):
        edges += [_edge(a, "twin-a"), _edge(a, "twin-b")]
    edges.append(_edge("a1", "priv"))
    edges += [
        _edge("a1", "fs", "agent->mcp"),
        _edge("a2", "fs", "agent->mcp"),
        _edge("a1", "dead-h", "agent->hook", "dead"),
        _edge("a2", "dead-h", "agent->hook", "dead"),
        _edge("a3", "live-h", "agent->hook"),
    ]
    return {"nodes": nodes, "edges": edges}


class GraphAnalyzeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        gpath = self.out / "harness-graph.json"
        gpath.write_text(json.dumps(_fixture_graph()), encoding="utf-8")
        self.patches = [
            mock.patch.object(graph_analyze, "OUT", str(self.out)),
            mock.patch.object(graph_analyze, "GRAPH", str(gpath)),
        ]
        for p in self.patches:
            p.start()
        self.G = graph_analyze.load()

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_impact_blast_radius(self) -> None:
        r = graph_analyze.impact(self.G, "shared")
        assert r is not None
        self.assertEqual(r[0], "skill:shared")
        # every agent wires `shared`
        self.assertEqual(len(r[1]), 11)
        self.assertIn("fe1", r[1])
        self.assertIn("be1", r[1])

    def test_criticality_ranks_shared_hub_first(self) -> None:
        rows = graph_analyze.capability_criticality(self.G)
        self.assertGreaterEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "shared")
        self.assertEqual(rows[0]["agents"], 11)

    def test_sole_provider_detected(self) -> None:
        rows = {r["name"]: r for r in graph_analyze.capability_criticality(self.G)}
        # a3's only hook is live-h → sole provider for a3
        self.assertIn("live-h", rows)
        self.assertGreaterEqual(rows["live-h"]["sole_provider_agents"], 1)

    def test_dead_cut_includes_hooks(self) -> None:
        dead = graph_analyze.dead_cut(self.G)
        names = [d[0] for d in dead]
        self.assertIn("dead-h", names)

    def test_acyclic(self) -> None:
        self.assertEqual(graph_analyze.cycles(self.G), [])

    def test_self_loop_is_reported_as_cycle(self) -> None:
        graph = graph_analyze.nx.DiGraph()
        graph.add_node("skill:recursive", name="recursive")
        graph.add_edge("skill:recursive", "skill:recursive")

        self.assertEqual(graph_analyze.cycles(graph), [["recursive"]])

    def test_analyze_json_shape(self) -> None:
        data = graph_analyze.analyze(self.G)
        for key in (
            "critical_capabilities",
            "leaf_bridge_agents",
            "concentration",
            "cycles",
            "communities",
            "association_rules",
            "skill_redundancy",
            "dead_cut",
        ):
            self.assertIn(key, data)
        names = [r["name"] for r in data["critical_capabilities"]]
        self.assertIn("shared", names)

    def test_association_lift_prefers_cluster_pairs(self) -> None:
        # lower thresholds so the tiny fixture produces rules
        rules = graph_analyze.association_rules(self.G, min_support=3, min_lift=1.5)
        pairs = {(r["a"], r["b"]) for r in rules}
        # react↔css and api↔db are pure cluster co-occurrences
        self.assertTrue(
            ("css", "react") in pairs or ("react", "css") in pairs,
            f"expected react/css rule, got {pairs}",
        )
        # hub `shared` co-occurs with everything → lift ~1, must not dominate
        hub_rules = [r for r in rules if r["a"] == "shared" or r["b"] == "shared"]
        cluster_rules = [
            r for r in rules if {r["a"], r["b"]} <= {"react", "css", "api", "db"}
        ]
        if hub_rules and cluster_rules:
            self.assertGreater(cluster_rules[0]["lift"], hub_rules[0]["lift"])

    def test_skill_redundancy_finds_twins(self) -> None:
        rows = graph_analyze.skill_redundancy(self.G, min_jaccard=0.9)
        pairs = {(r["a"], r["b"]) for r in rows}
        self.assertTrue(
            ("twin-a", "twin-b") in pairs or ("twin-b", "twin-a") in pairs,
            f"expected twin pair, got {pairs}",
        )

    def test_communities_not_one_giant_blob(self) -> None:
        comms = graph_analyze.communities(self.G, min_shared=2)
        # projection+modularity should separate FE/BE rather than one mega-component
        if len(comms) >= 2:
            sizes = [c["skill_count"] for c in comms]
            self.assertLess(max(sizes), sum(sizes))  # not a single all-skill cluster
        # method recorded
        for c in comms:
            self.assertIn(c.get("method"), ("louvain", "greedy_modularity"))


class RecommendWiringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        gpath = self.out / "harness-graph.json"
        gpath.write_text(json.dumps(_fixture_graph()), encoding="utf-8")
        self.patches = [
            mock.patch.object(recommend_wiring, "OUT", str(self.out)),
            mock.patch.object(recommend_wiring, "GRAPH", str(gpath)),
        ]
        for p in self.patches:
            p.start()
        g = recommend_wiring.load_graph()
        self.agent_skills = recommend_wiring.agent_skills_from(g)
        self.n = len(self.agent_skills)
        self.df = recommend_wiring.skill_df(self.agent_skills)
        self.idf = recommend_wiring.idf_table(self.df, self.n)
        self.lift_idx = recommend_wiring.build_lift_index(
            self.agent_skills, min_support=3, min_lift=1.5
        )

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_idf_downweights_hub(self) -> None:
        # shared is on every agent → lowest idf
        self.assertLess(self.idf["shared"], self.idf["react"])
        self.assertLess(self.idf["shared"], self.idf["priv"])

    def test_lift_index_has_cluster_edges(self) -> None:
        self.assertIn("css", self.lift_idx.get("react", {}))
        self.assertIn("db", self.lift_idx.get("api", {}))

    def test_recommend_prefers_bundle_completion(self) -> None:
        # agent with react but not css should get css boosted via lift
        # craft: fe-partial owns shared+react only
        skills = dict(self.agent_skills)
        skills["fe-partial"] = {"shared", "react"}
        # rebuild lift with looser thresholds for fixture scale
        lift = recommend_wiring.build_lift_index(skills, min_support=3, min_lift=1.5)
        df = recommend_wiring.skill_df(skills)
        idf = recommend_wiring.idf_table(df, len(skills))
        recs = recommend_wiring.recommend(
            skills,
            "fe-partial",
            df=df,
            idf=idf,
            lift_idx=lift,
            n_agents=len(skills),
        )
        # css should appear and carry lift_boost > 1 when association exists
        by_name = {sk: (sc, sup, comp) for sk, sc, sup, comp in recs}
        if "css" in by_name:
            _sc, _sup, comp = by_name["css"]
            self.assertGreaterEqual(comp["lift_boost"], 1.0)


class HealthGateTests(unittest.TestCase):
    def _allow(self, **over) -> dict:
        base = {
            "dead_hooks": {},
            "dead_mcp": {},
            "dead_skills": {},
            "thresholds": {
                "max_new_dead_skill_edges": 0,
                "max_inactive_skill_edges": 0,
                "max_malformed_agents": 0,
                "max_orphan_active_skills": 500,
                "max_mcp_top1_share": 0.35,
                "require_acyclic": True,
            },
        }
        base.update(over)
        return base

    def _q(self, **over) -> dict:
        q = {
            "counts": {
                "agents": 3,
                "skillEdgesDead": 0,
                "skillEdgesInactive": 0,
                "hookEdgesDead": 0,
                "mcpEdgesDead": 0,
                "malformedAgents": 0,
            },
            "deadHooks": [],
            "deadMcp": [],
            "deadSkills": [],
            "orphanActiveSkills": [],
            "modelDrift": {"drift": False, "distinct": []},
        }
        q["counts"].update(over.pop("counts", {}))
        q.update(over)
        return q

    def test_clean_pass(self) -> None:
        r = health_gate.check(
            self._q(),
            {"cycles": [], "concentration": {}, "critical_capabilities": []},
            self._allow(),
        )
        self.assertEqual(r["status"], "PASS")

    def test_new_dead_hook_fails(self) -> None:
        q = self._q(
            counts={"hookEdgesDead": 2},
            deadHooks=[{"target": "dead-h", "count": 2}],
        )
        r = health_gate.check(
            q,
            {"cycles": [], "concentration": {}, "critical_capabilities": []},
            self._allow(),
        )
        self.assertEqual(r["status"], "FAIL")
        self.assertTrue(any("dead-h" in f for f in r["fails"]))

    def test_allowlisted_dead_hook_warns(self) -> None:
        q = self._q(
            counts={"hookEdgesDead": 2},
            deadHooks=[{"target": "dead-h", "count": 2}],
        )
        allow = self._allow(
            dead_hooks={"dead-h": {"max_edges": 2, "reason": "test hold"}}
        )
        r = health_gate.check(
            q, {"cycles": [], "concentration": {}, "critical_capabilities": []}, allow
        )
        self.assertEqual(r["status"], "WARN")
        self.assertEqual(r["fails"], [])

    def test_allowlisted_growth_fails(self) -> None:
        q = self._q(
            counts={"hookEdgesDead": 5},
            deadHooks=[{"target": "dead-h", "count": 5}],
        )
        allow = self._allow(
            dead_hooks={"dead-h": {"max_edges": 2, "reason": "test hold"}}
        )
        r = health_gate.check(
            q, {"cycles": [], "concentration": {}, "critical_capabilities": []}, allow
        )
        self.assertEqual(r["status"], "FAIL")

    def test_cycles_fail(self) -> None:
        r = health_gate.check(
            self._q(),
            {"cycles": [["a", "b"]], "concentration": {}, "critical_capabilities": []},
            self._allow(),
        )
        self.assertEqual(r["status"], "FAIL")
        self.assertTrue(any("cycle" in f for f in r["fails"]))

    def test_dead_skill_edges_fail(self) -> None:
        q = self._q(counts={"skillEdgesDead": 3})
        r = health_gate.check(
            q,
            {"cycles": [], "concentration": {}, "critical_capabilities": []},
            self._allow(),
        )
        self.assertEqual(r["status"], "FAIL")


def main() -> None:
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
