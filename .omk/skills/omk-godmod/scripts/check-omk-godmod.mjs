#!/usr/bin/env node
/**
 * omk-godmod skill structural validator
 *
 * Validates:
 *  - Package structure (SKILL.md, references/*.md, scripts/)
 *  - Frontmatter integrity (name, description, user-invocable, trigger rules)
 *  - Internal cross-reference link validity
 *  - No bypass/jailbreak material in skill prose
 *  - Corpus dependency declared correctly
 *
 * Usage: node scripts/check-omk-godmod.mjs
 * Exit: 0 = ok, 1 = structural error, 2 = policy violation
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const OK = { ok: true };

function fail(code, msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(code);
}

function warn(msg) {
  console.warn(`WARN: ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. Structure
// ---------------------------------------------------------------------------
const required = [
  'SKILL.md',
  'references/taxonomy.md',
  'references/route-map.md',
  'references/vendor-profiles.md',
  'references/safety-taxonomy.md',
  'references/gpt-5.6-architecture.md',
];

for (const f of required) {
  const p = resolve(SKILL_ROOT, f);
  if (!existsSync(p)) fail(1, `Missing required file: ${f}`);
  if (statSync(p).size < 100) fail(1, `File too small (likely empty): ${f}`);
}

// Corpus dependency — should exist and be a directory
const corpusPath = resolve(SKILL_ROOT, '..', 'system-prompts-leaks', 'corpus');
if (!existsSync(corpusPath)) {
  warn('system-prompts-leaks corpus not found — skill will work but corpus lookups will fail');
}
const searchScript = resolve(SKILL_ROOT, '..', 'system-prompts-leaks', 'scripts', 'search.mjs');
if (!existsSync(searchScript)) {
  warn('system-prompts-leaks search.mjs not found — search functionality unavailable');
}

// ---------------------------------------------------------------------------
// 2. SKILL.md frontmatter
// ---------------------------------------------------------------------------
const skillMd = readFileSync(resolve(SKILL_ROOT, 'SKILL.md'), 'utf-8');
const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) fail(1, 'SKILL.md missing frontmatter');

const fm = fmMatch[1];
const checks = {
  'name:': 'frontmatter missing name',
  'description:': 'frontmatter missing description',
  'user-invocable:': 'frontmatter missing user-invocable',
  'triggers:': 'frontmatter missing triggers',
  'license:': 'frontmatter missing license',
};
for (const [key, err] of Object.entries(checks)) {
  if (!fm.includes(key)) fail(1, err);
}

// ---------------------------------------------------------------------------
// 3. Internal cross-reference links
// ---------------------------------------------------------------------------
const refLinks = [
  'references/taxonomy.md',
  'references/route-map.md',
  'references/vendor-profiles.md',
  'references/safety-taxonomy.md',
  'references/gpt-5.6-architecture.md',
];
for (const link of refLinks) {
  const p = resolve(SKILL_ROOT, link);
  if (!existsSync(p)) fail(1, `Broken internal link: ${link}`);
}

// External skill references
const extRefs = [
  '../system-prompts-leaks/corpus/',
  '../system-prompts-leaks/references/index.md',
  '../system-prompts-leaks/SOURCE.md',
  '../reverse-skill/references/route-map.md',
];
for (const link of extRefs) {
  const p = resolve(SKILL_ROOT, link);
  if (!existsSync(p)) {
    warn(`External reference not found (may need refresh): ${link}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Policy: no bypass/jailbreak material in skill prose
// ---------------------------------------------------------------------------
const policyRedFlags = [
  /jailbreak/i,
  /bypass\s+(safety|policy|refusal|content\s+filter)/i,
  /liberation\s+(prompt|mode)/i,
  /godmode\s+(bypass|exploit|unlock)/i,
  /how\s+to\s+(bypass|circumvent|evade|disable)\s+(safety|filter|refusal)/i,
  /remove\s+(restrictions|safeguards|guardrails)/i,
];

// Check all files (including SKILL.md below frontmatter)
const prose = skillMd.slice(fmMatch.index + fmMatch[0].length);
const allFiles = [
  { path: 'SKILL.md', content: prose },
  ...required.filter(f => f !== 'SKILL.md').map(f => ({
    path: f,
    content: readFileSync(resolve(SKILL_ROOT, f), 'utf-8'),
  })),
];

for (const { path: f, content } of allFiles) {
  for (const flag of policyRedFlags) {
    // Allow mentions in defensive/negation context with proper framing
    const matches = content.match(new RegExp(flag.source, 'gi'));
    if (matches) {
      for (const m of matches) {
        // Check surrounding context (80 chars each side)
        const idx = content.toLowerCase().indexOf(m.toLowerCase());
        const ctx = content.slice(Math.max(0, idx - 80), idx + m.length + 80).toLowerCase();
        const defensive = /do not|never|decline|out of scope|not for|not support|for understanding|defensive/i;
        if (!defensive.test(ctx)) {
          fail(2, `Policy violation in ${f}: "${m}" used without defensive framing`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Trigger sanity
// ---------------------------------------------------------------------------
const triggers = [
  'godmod',
  'god mode',
  'prompt architecture',
  'reverse engineer system prompt',
  'L1B3RT4S analysis',
  'elder-plinius',
];
for (const t of triggers) {
  if (!prose.toLowerCase().includes(t.toLowerCase())) {
    warn(`Trigger "${t}" declared in frontmatter but not used in prose`);
  }
}

// ---------------------------------------------------------------------------
// 6. Structural completeness
// ---------------------------------------------------------------------------
const sections = [
  '## Hard rules',
  '## Core workflow',
  '## When to use this skill',
  '## When NOT to use this skill',
  '## Sub-capabilities',
  '## Acceptance',
];
for (const s of sections) {
  if (!skillMd.includes(s)) {
    fail(1, `Missing required section in SKILL.md: ${s}`);
  }
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------
console.log(JSON.stringify(OK));
process.exit(0);
