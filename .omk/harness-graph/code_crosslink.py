#!/usr/bin/env python3
"""Code cross-link — bridges the harness graph to real code.

Honest definition of "a skill touches code": a skill's bundled `scripts/` are code, and those
scripts statically import external dependencies. So the real chain is:

    agent -> skill -> script (file, lang, LOC) -> dependency (npm/pip package)

This extracts that chain by static analysis (no execution), classifies skills as code-backed
vs prose-only, computes per-agent code footprint, and gives a dependency blast radius
(supply-chain view: "which agents transitively depend on package X"). Project-local scripts
are flagged as covered by the understand-anything KG (Layer B); global skill scripts are
Layer A only. Stdlib only.

Usage:
  python3 code_crosslink.py                # full report -> out/code-crosslink.md
  python3 code_crosslink.py --dep requests # who depends on a package (blast radius)
  python3 code_crosslink.py --agent NAME   # one agent's code footprint
"""
import json
import os
import re
import sys
from collections import defaultdict

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GRAPH = os.path.join(OUT, "harness-graph.json")
PROJECT = os.getcwd()
SKILL_ROOTS = [
    os.path.join(HOME, ".omk/agent/skills"), os.path.join(HOME, ".claude"),
    os.path.join(HOME, ".pi/agent"), os.path.join(PROJECT, ".omk/skills"),
]
SKIP = {"node_modules", ".git", "sessions", "quarantine", "QUARANTINE", ".cache", "backups", "dist", "build", ".next", "coverage"}
CODE_EXT = {".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".py", ".sh", ".bash"}

PY_STDLIB = {
    "os", "sys", "re", "json", "math", "time", "datetime", "collections", "itertools",
    "functools", "pathlib", "subprocess", "typing", "abc", "io", "random", "shutil",
    "argparse", "logging", "hashlib", "base64", "urllib", "http", "socket", "threading",
    "asyncio", "unittest", "csv", "sqlite3", "glob", "tempfile", "textwrap", "enum",
    "dataclasses", "copy", "traceback", "inspect", "importlib", "warnings", "contextlib",
}

JS_IMPORT = re.compile(r"""(?:^|\s)import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]""")
JS_REQUIRE = re.compile(r"""require\(\s*['"]([^'"]+)['"]\s*\)""")
JS_DYN = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")
PY_IMPORT = re.compile(r"""^\s*import\s+([a-zA-Z0-9_][\w.]*)""", re.M)
PY_FROM = re.compile(r"""^\s*from\s+([a-zA-Z0-9_][\w.]*)\s+import""", re.M)


def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def js_pkg(spec):
    if spec.startswith((".", "/")):
        return None                       # relative / absolute local import
    if spec.startswith("node:"):
        return None                       # node builtin
    parts = spec.split("/")
    return "/".join(parts[:2]) if spec.startswith("@") else parts[0]


def parse_imports(path):
    """Return (external_deps:set, loc:int, lang:str)."""
    ext = os.path.splitext(path)[1]
    text = read(path)
    loc = text.count("\n") + 1 if text else 0
    deps = set()
    if ext in (".mjs", ".js", ".cjs", ".ts", ".mts", ".cts"):
        lang = "js/ts"
        for rx in (JS_IMPORT, JS_REQUIRE, JS_DYN):
            for m in rx.findall(text):
                p = js_pkg(m)
                if p:
                    deps.add(p)
    elif ext == ".py":
        lang = "python"
        for rx in (PY_IMPORT, PY_FROM):
            for m in rx.findall(text):
                root = m.split(".")[0]
                if root and root not in PY_STDLIB and not root.startswith("_"):
                    deps.add(root)
    else:
        lang = "shell"
    return deps, loc, lang


def locate_skill_dirs():
    """name -> skill dir, by walking roots for SKILL.md frontmatter."""
    loc, seen = {}, set()

    def walk(d, depth):
        if depth > 6:
            return
        try:
            real = os.path.realpath(d)
        except OSError:
            return
        if real in seen:
            return
        seen.add(real)
        try:
            entries = os.scandir(d)
        except OSError:
            return
        for e in entries:
            if e.name in SKIP or (e.name.startswith(".") and e.name not in (".claude", ".agents")):
                continue
            try:
                is_dir = e.is_dir()
            except OSError:
                continue
            if is_dir:
                walk(e.path, depth + 1)
            elif e.name == "SKILL.md":
                m = re.search(r"^name:\s*(.+)$", read(e.path), re.M)
                if m:
                    nm = m.group(1).strip().strip("\"'")
                    loc.setdefault(nm, os.path.dirname(e.path))
    for r in SKILL_ROOTS:
        walk(r, 0)
    return loc


def find_scripts(skill_dir):
    """All code files under any scripts/ dir inside a skill."""
    out = []
    for root, dirs, files in os.walk(skill_dir):
        dirs[:] = [d for d in dirs if d not in SKIP]
        if os.path.basename(root) == "scripts" or "/scripts/" in root + "/":
            for fn in files:
                if os.path.splitext(fn)[1] in CODE_EXT:
                    out.append(os.path.join(root, fn))
    return out


def build():
    try:
        g = json.loads(read(GRAPH) or "{}")
    except json.JSONDecodeError as e:
        sys.exit(f"invalid JSON in {GRAPH}: {e} — run build-harness-graph.mjs first")
    agent_skills = defaultdict(set)
    for e in g.get("edges", []):
        if e["type"] == "agent->skill" and e.get("tier") != "dead":
            agent_skills[e["from"].split(":", 1)[1]].add(e["to"].split(":", 1)[1])
    active_skills = {n["name"] for n in g.get("nodes", []) if n["type"] == "skill" and n.get("tier") == "active"}

    skill_dir = locate_skill_dirs()
    skill_scripts = {}   # skill -> [{path, lang, loc, deps, project_local}]
    for sk in active_skills:
        d = skill_dir.get(sk)
        if not d:
            continue
        scripts = find_scripts(d)
        if not scripts:
            continue
        rows = []
        for sp in scripts:
            deps, loc, lang = parse_imports(sp)
            rows.append({
                "path": os.path.relpath(sp, HOME), "lang": lang, "loc": loc,
                "deps": sorted(deps), "project_local": sp.startswith(PROJECT),
            })
        skill_scripts[sk] = rows
    return agent_skills, active_skills, skill_scripts


def main():
    agent_skills, active_skills, skill_scripts = build()
    args = sys.argv[1:]

    # dependency -> skills (blast radius)
    dep_skills = defaultdict(set)
    for sk, rows in skill_scripts.items():
        for r in rows:
            for d in r["deps"]:
                dep_skills[d].add(sk)
    skill_agents = defaultdict(set)
    for ag, sks in agent_skills.items():
        for sk in sks:
            if sk in skill_scripts:
                skill_agents[sk].add(ag)

    if "--dep" in args:
        dep = args[args.index("--dep") + 1]
        sks = sorted(dep_skills.get(dep, []))
        ags = sorted({a for sk in sks for a in skill_agents.get(sk, [])})
        print(f"# dependency '{dep}' blast radius")
        print(f"  skills ({len(sks)}): {', '.join(sks)}")
        print(f"  agents ({len(ags)}): {', '.join(ags[:30])}")
        return

    if "--agent" in args:
        name = args[args.index("--agent") + 1]
        sks = [s for s in agent_skills.get(name, set()) if s in skill_scripts]
        scripts = loc = 0
        deps = set()
        for sk in sks:
            for r in skill_scripts[sk]:
                scripts += 1
                loc += r["loc"]
                deps.update(r["deps"])
        print(f"# {name} code footprint")
        print(f"  code-backed skills: {len(sks)}  scripts: {scripts}  LOC: {loc}  distinct deps: {len(deps)}")
        print(f"  deps: {', '.join(sorted(deps)[:30])}")
        return

    total_scripts = sum(len(v) for v in skill_scripts.values())
    total_loc = sum(r["loc"] for v in skill_scripts.values() for r in v)
    proj_local = sum(1 for v in skill_scripts.values() for r in v if r["project_local"])
    code_backed = len(skill_scripts)
    prose_only = len(active_skills) - code_backed

    # agent footprints
    foot = []
    for ag, sks in agent_skills.items():
        cb = [s for s in sks if s in skill_scripts]
        if not cb:
            continue
        n_scripts = sum(len(skill_scripts[s]) for s in cb)
        deps = {d for s in cb for r in skill_scripts[s] for d in r["deps"]}
        foot.append((ag, len(cb), n_scripts, len(deps)))
    foot.sort(key=lambda x: (-x[2], -x[3]))

    L = ["# Harness ↔ Code Cross-Link", "",
         "Chain: **agent → skill → bundled script → dependency**. Static analysis, no execution.", "",
         "## Coverage", "",
         f"- active skills: **{len(active_skills)}**  ·  code-backed (have scripts): **{code_backed}**  ·  prose-only: **{prose_only}**",
         f"- total bundled scripts: **{total_scripts}**  ·  total LOC: **{total_loc}**  ·  project-local (understand-anything KG-covered): **{proj_local}**",
         f"- distinct external dependencies: **{len(dep_skills)}**", "",
         "## Top dependency blast radius (supply-chain: dep → #skills using it)", "",
         "| dependency | #skills | #agents |", "|---|---:|---:|"]
    for dep, sks in sorted(dep_skills.items(), key=lambda x: -len(x[1]))[:20]:
        ags = {a for sk in sks for a in skill_agents.get(sk, [])}
        L.append(f"| {dep} | {len(sks)} | {len(ags)} |")

    L += ["", "## Agent code footprint (top 25 by scripts)", "",
          "| agent | code-backed skills | scripts | distinct deps |", "|---|---:|---:|---:|"]
    for ag, cb, ns, nd in foot[:25]:
        L.append(f"| {ag} | {cb} | {ns} | {nd} |")

    try:
        with open(os.path.join(OUT, "code-crosslink.md"), "w") as f:
            f.write("\n".join(L) + "\n")
        with open(os.path.join(OUT, "code-crosslink.json"), "w") as f:
            json.dump({"skill_scripts": skill_scripts,
                       "dep_blast": {d: sorted(s) for d, s in dep_skills.items()}}, f, indent=1)
    except OSError as e:
        sys.exit(f"cannot write report: {e}")

    print("code cross-link -> out/code-crosslink.md")
    print(f"  code-backed skills: {code_backed}/{len(active_skills)}  scripts: {total_scripts}  LOC: {total_loc}")
    print(f"  distinct deps: {len(dep_skills)}  project-local scripts (KG-covered): {proj_local}")
    print("  top deps:", ", ".join(f"{d}({len(s)})" for d, s in sorted(dep_skills.items(), key=lambda x: -len(x[1]))[:6]))


if __name__ == "__main__":
    main()
