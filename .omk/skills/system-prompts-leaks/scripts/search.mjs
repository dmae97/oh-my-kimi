#!/usr/bin/env node
// system-prompts-leaks corpus search helper.
//
// Walks the vendored corpus/ directory and lets an OMK agent (or a human)
// locate system-prompt references by vendor, model label, or content keyword
// WITHOUT loading all 400+ files into context.
//
// Usage:
//   node scripts/search.mjs                       # vendor summary + usage
//   node scripts/search.mjs list                  # all files grouped by vendor
//   node scripts/search.mjs list --json           # machine-readable catalog
//   node scripts/search.mjs <vendor>              # e.g. "xAI", "OpenAI", "Anthropic"
//   node scripts/search.mjs <term> [<term>...]    # label match (all terms, AND)
//   node scripts/search.mjs grep <pattern>        # content search (ripgrep if present)
//   node scripts/search.mjs show <rel/path.md>    # print a resolved corpus file
//
// Paths are reported relative to the skill root (e.g. corpus/xAI/grok-4.2.md).
// The corpus is a reference archive, not an authority. See SKILL.md for ethics.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const CORPUS = join(SKILL_ROOT, "corpus");

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const rest = args.filter((a) => a !== "--json");

// ---------- corpus walk ----------
function listMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listMarkdown(full, acc);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".md" || ext === ".txt" || ext === ".xml") acc.push(full);
    }
  }
  return acc;
}

function vendorOf(absPath) {
  return relative(CORPUS, absPath).split(/[\\/]/)[0];
}

function label(absPath) {
  const rel = relative(CORPUS, absPath).replace(/\\/g, "/");
  return rel.replace(/\.(md|txt|xml)$/i, "");
}

function firstHeading(absPath) {
  try {
    const text = readFileSync(absPath, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) return line.replace(/^#+\s*/, "").slice(0, 120);
      // Many leaked prompts have no heading; fall back to first line snippet.
      return line.slice(0, 120);
    }
  } catch {
    /* ignore */
  }
  return "";
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function corpusFiles() {
  if (!existsSync(CORPUS)) return [];
  return listMarkdown(CORPUS).sort();
}

function vendorSummary(files) {
  const map = new Map();
  for (const f of files) {
    const v = vendorOf(f);
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(f);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

// ---------- commands ----------
function usage() {
  const files = corpusFiles();
  const lines = [
    "system-prompts-leaks corpus search",
    "",
    "Commands:",
    "  list                       List every corpus file grouped by vendor",
    "  <vendor>                   All files under a vendor (Anthropic, OpenAI, xAI, ...)",
    "  <term> [<term>...]         Label match (all terms required, case-insensitive)",
    "  grep <pattern>             Content search across the corpus (ripgrep if available)",
    "  show <rel/path.md>         Print a single resolved corpus file",
    "",
    "Flags:",
    "  --json                     Emit machine-readable JSON for list/find/vendor",
    "",
    `Corpus: ${files.length} files in ${vendorSummary(files).length} vendors`,
    "",
    "All reported paths are relative to the skill root (corpus/<vendor>/...).",
    "The corpus is a reference archive. See SKILL.md for usage and ethics.",
  ];
  console.log(lines.join("\n"));
}

function cmdList() {
  const files = corpusFiles();
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        files.map((f) => ({
          path: relative(SKILL_ROOT, f),
          vendor: vendorOf(f),
          label: label(f),
        })),
        null,
        0,
      ),
    );
    return;
  }
  for (const [vendor, group] of vendorSummary(files)) {
    console.log(`\n## ${vendor} (${group.length})`);
    for (const f of group) console.log(`  ${relative(SKILL_ROOT, f)}`);
  }
  console.log(`\nTotal: ${files.length} files`);
}

function cmdVendor(name) {
  const want = name.toLowerCase();
  const files = corpusFiles().filter((f) => vendorOf(f).toLowerCase() === want);
  emitMatches(files, `Vendor "${name}"`);
}

function findFilesByLabel(terms) {
  const needles = terms.map((t) => t.toLowerCase());
  return corpusFiles().filter((f) => {
    const hay = `${label(f)} ${firstHeading(f)}`.toLowerCase();
    return needles.every((n) => hay.includes(n));
  });
}

function cmdFind(terms) {
  emitMatches(findFilesByLabel(terms), `Label match [${terms.join(" ")}]`);
}

function emitMatches(files, title) {
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        files.map((f) => ({
          path: relative(SKILL_ROOT, f),
          vendor: vendorOf(f),
          label: label(f),
          heading: firstHeading(f),
          size: humanBytes(statSync(f).size),
        })),
        null,
        0,
      ),
    );
    return;
  }
  console.log(`${title} — ${files.length} hit(s)`);
  for (const f of files) {
    const head = firstHeading(f);
    console.log(
      `  ${relative(SKILL_ROOT, f)}` + (head ? `\n      → ${head}` : ""),
    );
  }
}

function cmdGrep(pattern) {
  if (!pattern) {
    console.error("grep requires a pattern");
    process.exit(1);
  }
  // Prefer ripgrep for speed; fall back to a Node scan.
  const rg = spawnSync(
    "rg",
    ["-i", "-n", "--no-heading", "-g", "*.md", "-g", "*.txt", "-g", "*.xml", pattern, CORPUS],
    { encoding: "utf8" },
  );
  if (rg.status === 0 || rg.stdout) {
    const out = (rg.stdout || "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // rewrite absolute corpus paths to skill-relative
        const idx = line.indexOf("corpus/");
        return idx >= 0 ? line.slice(idx) : line;
      })
      .join("\n");
    console.log(out || "(no matches)");
    return;
  }
  // Fallback scan.
  const lower = pattern.toLowerCase();
  const hits = [];
  for (const f of corpusFiles()) {
    const text = readFileSync(f, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.toLowerCase().includes(lower)) {
        hits.push(`${relative(SKILL_ROOT, f)}:${i + 1}:${line.trim()}`);
      }
    });
  }
  console.log(hits.length ? hits.join("\n") : "(no matches)");
}

function cmdShow(rel) {
  const target = resolve(SKILL_ROOT, rel);
  if (!target.startsWith(CORPUS)) {
    console.error("show: path must resolve inside corpus/");
    process.exit(1);
  }
  if (!existsSync(target)) {
    console.error(`show: not found: ${rel}`);
    process.exit(1);
  }
  process.stdout.write(readFileSync(target, "utf8"));
}

// ---------- dispatch ----------
const vendorNames = new Set(
  corpusFiles().map((f) => vendorOf(f).toLowerCase()),
);
const [sub] = rest;

if (rest.length === 0) {
  usage();
} else if (sub === "list") {
  cmdList();
} else if (sub === "grep") {
  cmdGrep(rest.slice(1).join(" "));
} else if (sub === "show") {
  cmdShow(rest[1]);
} else if (vendorNames.has(sub.toLowerCase())) {
  cmdVendor(sub);
} else {
  cmdFind(rest);
}
