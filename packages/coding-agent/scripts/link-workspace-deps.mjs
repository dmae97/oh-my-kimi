#!/usr/bin/env node
/**
 * Ensure monorepo workspace packages are linked into coding-agent/node_modules.
 * npm workspaces normally hoist to root, but some resolvers still look under
 * packages/coding-agent/node_modules/omk-ai (broken → provider_protocol crash).
 */
import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const nm = join(pkgRoot, "node_modules");
const packagesRoot = resolve(pkgRoot, "..");

const LINKS = [
  ["omk-ai", "ai"],
  ["omk-tui", "tui"],
  ["omk-agent-core", "agent"],
  ["omk-adaptorch-wpl", "adaptorch-wpl"],
];

mkdirSync(nm, { recursive: true });

for (const [name, dir] of LINKS) {
  const target = join(packagesRoot, dir);
  const linkPath = join(nm, name);
  if (!existsSync(target)) {
    console.error(`[link-workspace-deps] skip ${name}: missing ${target}`);
    continue;
  }
  const rel = relative(nm, target);
  try {
    if (existsSync(linkPath) || lstatSync(linkPath).isSymbolicLink()) {
      try {
        const cur = readlinkSync(linkPath);
        if (cur === rel || resolve(nm, cur) === target) {
          console.error(`[link-workspace-deps] ok ${name} -> ${rel}`);
          continue;
        }
      } catch {
        /* replace */
      }
      rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    try { rmSync(linkPath, { recursive: true, force: true }); } catch { /* */ }
  }
  symlinkSync(rel, linkPath);
  console.error(`[link-workspace-deps] linked ${name} -> ${rel}`);
}
