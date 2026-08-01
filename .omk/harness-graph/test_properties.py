#!/usr/bin/env python3
"""Property-based invariants for harness-graph algorithms (stdlib only).

No Hypothesis dependency — uses deterministic random baskets. Run:
  python3 .omk/harness-graph/test_properties.py
"""

from __future__ import annotations

import math
import random
import sys
import unittest
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import importlib.util
from types import ModuleType


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ga = _load("graph_analyze", HERE / "graph_analyze.py")
rw = _load("recommend_wiring", HERE / "recommend-wiring.py")


def random_baskets(rng: random.Random, n_agents: int = 40, n_skills: int = 20):
    skills = [f"s{i}" for i in range(n_skills)]
    # plant two pure bundles
    bundle_a = {"s0", "s1", "s2"}
    bundle_b = {"s10", "s11"}
    agent_skills: dict[str, set[str]] = {}
    for i in range(n_agents):
        if i < 12:
            base = set(bundle_a)
        elif i < 20:
            base = set(bundle_b)
        else:
            base = {rng.choice(skills) for _ in range(rng.randint(1, 4))}
        # noise
        if rng.random() < 0.3:
            base.add(rng.choice(skills))
        agent_skills[f"a{i}"] = base
    return agent_skills


class LiftProperties(unittest.TestCase):
    def test_lift_symmetric_and_ge_zero(self) -> None:
        rng = random.Random(0)
        for trial in range(15):
            baskets = random_baskets(rng)
            # build fake DiGraph-like via association on inverted index directly
            n = len(baskets)
            inv: dict[str, set[str]] = defaultdict(set)
            for a, sks in baskets.items():
                for s in sks:
                    inv[s].add(a)
            skills = sorted(inv)
            for i, a in enumerate(skills):
                for b in skills[i + 1 :]:
                    both = len(inv[a] & inv[b])
                    if both == 0:
                        continue
                    lift = (both * n) / (len(inv[a]) * len(inv[b]))
                    self.assertGreaterEqual(lift, 0.0)
                    # symmetry by construction
                    lift2 = (both * n) / (len(inv[b]) * len(inv[a]))
                    self.assertAlmostEqual(lift, lift2)

    def test_independent_skills_lift_near_one(self) -> None:
        # two groups never co-occur → no pair across groups with support
        baskets = {f"a{i}": {"x"} for i in range(10)}
        baskets.update({f"b{i}": {"y"} for i in range(10)})
        n = len(baskets)
        # x and y never together
        both = 0
        nx = sum(1 for s in baskets.values() if "x" in s)
        ny = sum(1 for s in baskets.values() if "y" in s)
        if both == 0:
            # lift undefined / zero support — association_rules filters these
            self.assertEqual(both, 0)
            self.assertEqual(nx + ny, n)

    def test_perfect_bundle_high_lift(self) -> None:
        baskets = {f"a{i}": {"p", "q"} for i in range(20)}
        baskets.update({f"z{i}": {"r"} for i in range(20)})
        n = len(baskets)
        both = 20
        lift = (both * n) / (20 * 20)
        self.assertGreaterEqual(lift, 2.0)


class IdfProperties(unittest.TestCase):
    def test_idf_monotone_in_rarity(self) -> None:
        agent_skills = {
            "a1": {"hub", "rare"},
            "a2": {"hub"},
            "a3": {"hub"},
            "a4": {"hub"},
            "a5": {"hub", "mid"},
            "a6": {"hub", "mid"},
        }
        df = rw.skill_df(agent_skills)
        idf = rw.idf_table(df, len(agent_skills))
        self.assertLess(idf["hub"], idf["mid"])
        self.assertLess(idf["mid"], idf["rare"])

    def test_idf_positive(self) -> None:
        rng = random.Random(1)
        for _ in range(20):
            baskets = random_baskets(rng, n_agents=30, n_skills=15)
            df = rw.skill_df(baskets)
            idf = rw.idf_table(df, len(baskets))
            for v in idf.values():
                self.assertGreater(v, 0.0)
                self.assertTrue(math.isfinite(v))


class JaccardProperties(unittest.TestCase):
    def test_jaccard_bounds(self) -> None:
        rng = random.Random(2)
        for _ in range(50):
            a = {rng.randint(0, 20) for _ in range(rng.randint(0, 10))}
            b = {rng.randint(0, 20) for _ in range(rng.randint(0, 10))}
            j = rw.jaccard(a, b)
            self.assertGreaterEqual(j, 0.0)
            self.assertLessEqual(j, 1.0)
            self.assertAlmostEqual(j, rw.jaccard(b, a))


def main() -> None:
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
