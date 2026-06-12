#!/usr/bin/env node
/**
 * Cross-platform test runner for CI.
 * Discovers test files, runs each with node --test, collects failures,
 * and exits with non-zero if any test file failed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const TEST_DIR = "test";
const TIMEOUT_MS = 300_000;
const FAILED_LOG = "failed-tests.txt";
const SUMMARY_LOG = "test-summary.json";
const SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const options = { summaryPath: undefined, onlyFailed: false, match: undefined, list: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--summary-json" || arg === "--json-summary") {
      options.summaryPath = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : SUMMARY_LOG;
    } else if (arg.startsWith("--summary-json=")) {
      options.summaryPath = arg.slice("--summary-json=".length) || SUMMARY_LOG;
    } else if (arg.startsWith("--json-summary=")) {
      options.summaryPath = arg.slice("--json-summary=".length) || SUMMARY_LOG;
    } else if (arg === "--only-failed" || arg === "--failed") {
      options.onlyFailed = true;
    } else if (arg === "--match") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("--match requires a non-empty substring");
        process.exit(1);
      }
      options.match = value;
      i++;
    } else if (arg.startsWith("--match=")) {
      options.match = arg.slice("--match=".length);
      if (!options.match) {
        console.error("--match requires a non-empty substring");
        process.exit(1);
      }
    } else if (arg === "--list") {
      options.list = true;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

function cleanStaleArtifacts() {
  for (const artifact of [FAILED_LOG, SUMMARY_LOG]) {
    if (existsSync(artifact)) rmSync(artifact, { force: true });
  }
}

function listSourceFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

function expectedDistPath(sourcePath) {
  const relative = normalize(sourcePath).slice(`src${sep}`.length);
  return join("dist", relative.replace(/\.(tsx|ts)$/u, ".js"));
}

function checkDistFreshness() {
  if (process.env.OMK_SKIP_DIST_FRESHNESS === "1") return undefined;
  if (!existsSync("src")) return undefined;
  for (const source of listSourceFiles("src")) {
    const dist = expectedDistPath(source);
    if (!existsSync(dist)) {
      return `dist artifact missing for ${source}: expected ${dist}; run npm run build:clean before npm test`;
    }
    const sourceMtime = statSync(source).mtimeMs;
    const distMtime = statSync(dist).mtimeMs;
    if (sourceMtime > distMtime + 1000) {
      return `dist is stale: ${source} is newer than ${dist}; run npm run build:clean before npm test`;
    }
  }
  return undefined;
}

function classifyResult(result) {
  if (result.error?.code === "ETIMEDOUT") return "timeout";
  if (result.signal) return "signal";
  if (result.status === 0) return "passed";
  return "failed";
}

function writeSummary(path, summary) {
  const resolvedPath = resolveContainedOutputPath(path);
  const parent = resolvedPath.split(/[\\/]/).slice(0, -1).join(sep);
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

function resolveContainedOutputPath(path) {
  const root = resolve(process.cwd());
  const resolvedPath = resolve(root, path);
  const relativePath = relative(root, resolvedPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return resolvedPath;
  }
  throw new Error(`Refusing to write summary outside project: ${path}`);
}

function baseSummary(startedAt, startedMs, files = [], options = {}) {
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    testDir: TEST_DIR,
    timeoutMs: TIMEOUT_MS,
    mode: options.onlyFailed ? "only-failed" : "all",
    filters: {
      match: options.match ?? null,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    resources: collectHarnessResources(),
    startedAt,
    completedAt,
    durationMs: Math.round(performance.now() - startedMs),
    totalFiles: files.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedFiles: [],
    results: [],
  };
}

function discoverTestFiles() {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => join(TEST_DIR, f));
}

function isSafeTestPath(value) {
  const normalized = normalize(value);
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !normalized.split(/[\\/]/).includes("..") &&
    normalized.startsWith(`${TEST_DIR}${sep}`) &&
    normalized.endsWith(".test.mjs")
  );
}

function readFailedTestFiles() {
  if (!existsSync(FAILED_LOG)) {
    return { files: [], error: `${FAILED_LOG} not found; run the full suite first or use --match` };
  }
  const invalid = [];
  const missing = [];
  const files = [];
  const seen = new Set();
  for (const line of readFileSync(FAILED_LOG, "utf-8").split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    if (!isSafeTestPath(raw)) {
      invalid.push(raw);
      continue;
    }
    const normalized = normalize(raw);
    if (!existsSync(normalized)) {
      missing.push(raw);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      files.push(normalized);
    }
  }
  if (invalid.length > 0) return { files: [], error: `Invalid failed test path in ${FAILED_LOG}: ${invalid[0]}` };
  if (missing.length > 0) return { files: [], error: `Failed test file no longer exists: ${missing[0]}` };
  if (files.length === 0) return { files: [], error: `${FAILED_LOG} contains no runnable test files` };
  return { files: files.sort() };
}

function filterTestFiles(files, options) {
  if (!options.match) return files;
  return files.filter((file) => file.includes(options.match));
}

function countMcpServers(configPath) {
  return inspectMcpConfig(configPath).servers;
}

function inspectMcpConfig(configPath) {
  if (!existsSync(configPath)) {
    return { servers: [], diagnostics: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const servers = raw?.mcpServers ?? raw?.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { servers: [], diagnostics: [] };
    return { servers: Object.keys(servers), diagnostics: [] };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
    return {
      servers: [],
      diagnostics: [{
        source: "mcp-config",
        path: configPath,
        message: code ? `unreadable MCP config (${code})` : "invalid MCP config JSON",
      }],
    };
  }
}

function countSkillDirs(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dirPath, entry.name, "SKILL.md")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function countHookFiles(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith(".") && !entry.name.endsWith(".sample"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function countHookEvents(configPath) {
  try {
    const config = readFileSync(configPath, "utf-8");
    const events = [...config.matchAll(/^\s*event\s*=\s*"([^"]+)"/gm)].map((match) => match[1]);
    return [...new Set(events)];
  } catch {
    return [];
  }
}

function existingDirs(paths) {
  return paths.filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }).length;
}

function collectHarnessResources() {
  const mcpConfigPaths = [join(".omk", "mcp.json"), join(".kimi", "mcp.json")];
  const skillDirs = [join(".agents", "skills"), join(".kimi", "skills"), join(".omk", "skills")];
  const hookDirs = [join(".omk", "hooks"), join(".kimi", "hooks")];
  const mcpInspections = mcpConfigPaths.map(inspectMcpConfig);
  const mcpServers = new Set(mcpInspections.flatMap((inspection) => inspection.servers));
  const mcpDiagnostics = mcpInspections.flatMap((inspection) => inspection.diagnostics);
  const skills = new Set(skillDirs.flatMap(countSkillDirs));
  const hooks = new Set(hookDirs.flatMap(countHookFiles));
  const hookEvents = new Set([join(".omk", "kimi.config.toml"), join(".kimi", "settings.toml")].flatMap(countHookEvents));
  return {
    mcpServers: mcpServers.size,
    skills: skills.size,
    hooks: hooks.size,
    hookEvents: hookEvents.size,
    files: {
      mcpConfigs: mcpConfigPaths.filter(existsSync).length,
      skillDirs: existingDirs(skillDirs),
      hookDirs: existingDirs(hookDirs),
    },
    diagnostics: {
      mcpConfigs: mcpDiagnostics.length,
      invalidMcpConfigs: mcpDiagnostics.filter((item) => item.message.includes("invalid")).length,
      unreadableMcpConfigs: mcpDiagnostics.filter((item) => item.message.includes("unreadable")).length,
    },
  };
}

const options = parseArgs(process.argv);
const startedAt = new Date().toISOString();
const startedMs = performance.now();
const failedSelection = options.onlyFailed ? readFailedTestFiles() : undefined;

cleanStaleArtifacts();

if (!existsSync(TEST_DIR)) {
  const summary = baseSummary(startedAt, startedMs, [], options);
  summary.error = `Test directory not found: ${TEST_DIR}`;
  writeSummary(options.summaryPath ?? SUMMARY_LOG, summary);
  console.error(summary.error);
  process.exit(1);
}

const distFreshnessError = checkDistFreshness();
if (distFreshnessError) {
  const summary = baseSummary(startedAt, startedMs, discoverTestFiles(), options);
  summary.error = distFreshnessError;
  writeSummary(options.summaryPath ?? SUMMARY_LOG, summary);
  console.error(summary.error);
  process.exit(1);
}

if (failedSelection?.error) {
  const summary = baseSummary(startedAt, startedMs, [], options);
  summary.error = failedSelection.error;
  writeSummary(options.summaryPath ?? SUMMARY_LOG, summary);
  console.error(summary.error);
  process.exit(1);
}

const files = filterTestFiles(
  options.onlyFailed ? failedSelection.files : discoverTestFiles(),
  options
);

if (files.length === 0) {
  const summary = baseSummary(startedAt, startedMs, files, options);
  summary.error = options.match
    ? `No test files matched --match ${options.match}`
    : `No test files found in ${TEST_DIR}`;
  writeSummary(options.summaryPath ?? SUMMARY_LOG, summary);
  console.error(summary.error);
  process.exit(1);
}

if (options.list) {
  for (const file of files) console.log(file);
  const summary = baseSummary(startedAt, startedMs, files, options);
  summary.ok = true;
  summary.passed = 0;
  summary.skipped = files.length;
  if (options.summaryPath) writeSummary(options.summaryPath, summary);
  process.exit(0);
}

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.FORCE_COLOR;
childEnv.NO_COLOR = "1";

let failed = 0;
const failedFiles = [];
const results = [];

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const fileStarted = performance.now();
  const result = spawnSync(process.execPath, ["--test", `--test-timeout=${TIMEOUT_MS}`, file], {
    stdio: "inherit",
    timeout: TIMEOUT_MS + 10_000,
    env: childEnv,
  });
  const durationMs = Math.round(performance.now() - fileStarted);
  const outcome = classifyResult(result);
  const fileResult = {
    file,
    status: outcome,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
  };
  if (result.error) fileResult.error = result.error.message;
  results.push(fileResult);

  if (outcome !== "passed") {
    failed++;
    failedFiles.push(file);
    const exitDetail = outcome === "timeout"
      ? "timeout"
      : result.status ?? `signal ${result.signal}`;
    console.error(`\n❌ FAILED: ${file} (${exitDetail})`);
  } else {
    console.log(`\n✅ PASSED: ${file}`);
  }
}

const completedAt = new Date().toISOString();
const summary = {
  schemaVersion: SCHEMA_VERSION,
  ok: failed === 0,
  testDir: TEST_DIR,
  timeoutMs: TIMEOUT_MS,
  mode: options.onlyFailed ? "only-failed" : "all",
  filters: {
    match: options.match ?? null,
  },
  runtime: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  resources: collectHarnessResources(),
  startedAt,
  completedAt,
  durationMs: Math.round(performance.now() - startedMs),
  totalFiles: files.length,
  passed: files.length - failed,
  failed,
  skipped: 0,
  failedFiles,
  results,
};

console.log(`\n==============================`);
console.log(`Total files: ${files.length}`);
console.log(`Passed:      ${files.length - failed}`);
console.log(`Failed:      ${failed}`);
console.log(`==============================`);

if (failed > 0) {
  writeFileSync(FAILED_LOG, failedFiles.join("\n") + "\n", "utf-8");
  writeSummary(options.summaryPath ?? SUMMARY_LOG, summary);
  process.exit(1);
}

if (options.summaryPath) writeSummary(options.summaryPath, summary);
