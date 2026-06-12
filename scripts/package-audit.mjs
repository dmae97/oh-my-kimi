#!/usr/bin/env node
/**
 * Package truth audit — cross-platform (Windows / Linux / macOS)
 * Validates the tarball that npm would publish using npm pack --dry-run --json.
 * No shell pipes, grep, head, or shell-interpolated tar commands.
 * Does NOT rebuild or repack the artifact — only audits what npm pack reports.
 *
 * Hard-fail checks:
 *   - pack JSON structure (exactly 1 object, required fields)
 *   - local package.json name\/version\/bin\/files match pack metadata
 *   - required entries exist in tarball
 *   - forbidden entries do NOT exist in tarball (glob-based, full path)
 *   - package.json.files entries exist locally and are packed
 *   - bin targets exist locally, are packed, live under dist\/ , have shebang
 *   - dist drift: every src\/\/*\/*.ts has matching dist artifacts
 *   - stale dist files have no source counterpart (unless allowlisted)
 *   - sourcemap source paths are clean (no absolute, node_modules, traversal)
 *   - size budgets (tarball, unpacked, entryCount, single file, readmeasset, dist)
 *   - markdown local link integrity (README.md + docs\/\/*\/ links point to packed files)
 */
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { basename, join, relative, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COMMAND_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.OMK_PACKAGE_AUDIT_TIMEOUT_MS || "120000", 10) || 120_000
);
const LINUX_TMPDIR = process.platform !== "win32" ? "/tmp" : undefined;

export const REQUIRED_ENTRIES = [
  "package.json",
  "README.md",
  "LICENSE",
  "AGENTS.md",
  "dist/cli.js",
  "templates/AGENTS.md",
  "templates/.kimi/AGENTS.md",
  "templates/web-bridge/chrome-extension/manifest.json",
  "templates/web-bridge/chrome-extension/background.js",
  "templates/web-bridge/chrome-extension/content-script.js",
  "templates/web-bridge/chrome-extension/README.md",
  "templates/.omk/agents/okabe.yaml",
  "templates/.omk/agents/root.yaml",
  "templates/.omk/agents/roles/aggregator.yaml",
  "templates/.omk/agents/roles/architect.yaml",
  "templates/.omk/agents/roles/coder.yaml",
  "templates/.omk/agents/roles/explorer.yaml",
  "templates/.omk/agents/roles/integrator.yaml",
  "templates/.omk/agents/roles/interviewer.yaml",
  "templates/.omk/agents/roles/ontology.yaml",
  "templates/.omk/agents/roles/planner.yaml",
  "templates/.omk/agents/roles/qa.yaml",
  "templates/.omk/agents/roles/researcher.yaml",
  "templates/.omk/agents/roles/reviewer.yaml",
  "templates/.omk/agents/roles/router.yaml",
  "templates/.omk/agents/roles/security.yaml",
  "templates/.omk/agents/roles/tester.yaml",
  "templates/.omk/agents/roles/vision-debugger.yaml",
  "templates/.omk/prompts/root.md",
  "readmeasset/kimicat.png",
];

export const NON_EMPTY_TEXT_ENTRIES = [
  "AGENTS.md",
  "templates/AGENTS.md",
  "templates/.kimi/AGENTS.md",
];

export const FORBIDDEN_PATTERNS = [
  "src/**",
  "test/**",
  "scripts/**",
  ".github/**",
  ".omk/**",
  ".kimi/**",
  ".agents/**",
  ".specify/**",
  "specs/**",
  "public/assets/**",
  "dist.old/**",
  "node_modules/**",
  "package-lock.json",
  "**/*.tgz",
  "**/*.tar.gz",
  "**/*.zip",
  "archives/**",
  "logs/**",
  "**/*.log",
  "**/.env*",
  "keys/**",
  "credentials/**",
  "**/*.pem",
  "**/*.key",
  "id_rsa",
  "id_ed25519",
];

export const SIZE_BUDGETS = {
  tarballMb: 35,
  unpackedMb: 40,
  entryCount: 1100,
  singleFileMb: 20,
  readmeassetMb: 30,
  distMb: 20,
};

export const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
]);

export const STALE_DIST_ALLOWLIST = new Set([]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

export function walkDir(dir, base = dir) {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkDir(fullPath, base));
    } else {
      entries.push(toPosix(relative(base, fullPath)));
    }
  }
  return entries;
}

export function globMatch(pattern, target) {
  const parts = pattern.split("/");
  const targetParts = target.split("/");

  let pi = 0;
  let ti = 0;

  while (pi < parts.length && ti < targetParts.length) {
    const pp = parts[pi];
    const tp = targetParts[ti];

    if (pp === "**") {
      if (pi === parts.length - 1) return true;
      const nextPart = parts[pi + 1];
      while (ti < targetParts.length && !segmentMatch(nextPart, targetParts[ti])) {
        ti++;
      }
      if (ti >= targetParts.length) return false;
      pi += 2;
      ti++;
      continue;
    }

    if (!segmentMatch(pp, tp)) {
      return false;
    }
    pi++;
    ti++;
  }

  if (pi < parts.length && parts[pi] === "**") {
    pi++;
  }

  if (pi === parts.length && ti === targetParts.length) return true;

  if (
    pi === parts.length - 1 &&
    parts[pi] === "**" &&
    ti === targetParts.length
  ) {
    return true;
  }

  return false;
}

function segmentMatch(pattern, segment) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === segment;

  const parts = pattern.split("*");
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") continue;
    const idx = segment.indexOf(part, pos);
    if (idx === -1) return false;
    if (i === 0 && idx !== 0) return false;
    pos = idx + part.length;
  }
  if (parts[parts.length - 1] !== "" && pos !== segment.length) return false;
  return true;
}

export function anyGlobMatch(patterns, target) {
  return patterns.some((p) => globMatch(p, target));
}

export function parseMarkdownLocalLinks(content) {
  const links = [];
  const regex = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const raw = m[2].trim();
    const url = raw.split("#")[0].split("?")[0];
    if (!url) continue;
    if (/^(https?:|mailto:|data:)/i.test(url)) continue;
    if (url.startsWith("/")) continue;
    links.push(url);
  }
  return links;
}

export function resolveLink(fromFile, link) {
  const dirParts = dirname(fromFile).split("/").filter((p) => p && p !== ".");
  const linkParts = link.split("/").filter((p) => p !== ".");
  const parts = [...dirParts, ...linkParts];
  const result = [];
  for (const part of parts) {
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validatePackStructure(packResult) {
  const errors = [];
  if (!Array.isArray(packResult)) {
    errors.push("npm pack JSON is not an array");
    return { errors };
  }
  if (packResult.length === 0) {
    errors.push("npm pack JSON array is empty");
    return { errors };
  }
  if (packResult.length > 1) {
    errors.push(`Expected exactly 1 pack object, got ${packResult.length}`);
  }
  const pkg = packResult[0];
  const requiredFields = [
    "name",
    "version",
    "filename",
    "size",
    "unpackedSize",
    "entryCount",
    "files",
  ];
  for (const field of requiredFields) {
    if (!(field in pkg)) {
      errors.push(`Missing required pack field: ${field}`);
    }
  }
  return { errors, pkg };
}

export function validateMetadata(localPkg, pkg) {
  const errors = [];
  if (localPkg.name !== pkg.name) {
    errors.push(`name mismatch: local="${localPkg.name}" pack="${pkg.name}"`);
  }
  if (localPkg.version !== pkg.version) {
    errors.push(
      `version mismatch: local="${localPkg.version}" pack="${pkg.version}"`
    );
  }
  return { errors };
}

export function validateRequiredEntries(files, required) {
  const errors = [];
  const pathSet = new Set(files.map((f) => toPosix(f.path || "")));
  for (const req of required) {
    if (!pathSet.has(req)) {
      errors.push(`Required entry missing: ${req}`);
    }
  }
  return { errors };
}

export function validateNonEmptyTextEntries(files, required) {
  const errors = [];
  const fileByPath = new Map(files.map((f) => [toPosix(f.path || ""), f]));
  for (const entry of required) {
    const file = fileByPath.get(entry);
    if (!file) continue;
    const packedSize = typeof file.size === "number" ? file.size : 0;
    if (packedSize > 0) continue;
    errors.push(`Required text entry is empty: ${entry}`);
  }
  return { errors };
}

export function validateForbiddenEntries(files, patterns) {
  const errors = [];
  for (const f of files) {
    const path = toPosix(f.path || "");
    if (anyGlobMatch(patterns, path)) {
      errors.push(`Forbidden entry found in tarball: ${path}`);
    }
  }
  return { errors };
}

export function validateFilesAllowlist(localFiles, pathSet) {
  const errors = [];
  for (const entry of localFiles) {
    const localPath = toPosix(entry);
    if (!existsSync(localPath)) {
      errors.push(`Stale files allowlist entry: ${localPath}`);
      continue;
    }
    let packed = false;
    if (pathSet.has(localPath)) {
      packed = true;
    } else if (
      statSync(localPath).isDirectory() &&
      [...pathSet].some((p) => p.startsWith(localPath + "/"))
    ) {
      packed = true;
    }
    if (!packed) {
      errors.push(`Local files entry not packed: ${localPath}`);
    }
  }
  return { errors };
}


export function nativePlatformArch(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function nativeBinaryName(platform = process.platform) {
  return platform === "win32" ? "omk-safety.exe" : "omk-safety";
}

export function expectedNativeSafetyPath(platform = process.platform, arch = process.arch) {
  return `dist/native/${nativePlatformArch(platform, arch)}/${nativeBinaryName(platform)}`;
}

export function validateNativeSafety(files, platform = process.platform, arch = process.arch) {
  const errors = [];
  const pathSet = new Set(files.map((f) => toPosix(f.path || "")));
  const expected = expectedNativeSafetyPath(platform, arch);
  if (!pathSet.has(expected)) {
    errors.push(`Native safety binary missing for current platform: ${expected}. Run npm run native:build before packing.`);
  }

  const nativeEntries = files.filter((f) => toPosix(f.path || "").startsWith("dist/native/"));
  for (const file of nativeEntries) {
    const entry = toPosix(file.path || "");
    if (!/^dist\/native\/[^/]+-[^/]+\/omk-safety(?:\.exe)?$/.test(entry)) {
      errors.push(`Unexpected native safety layout: ${entry}`);
      continue;
    }
    if (!entry.endsWith(".exe") && typeof file.mode === "number" && (file.mode & 0o111) === 0) {
      errors.push(`Native safety binary not executable: ${entry}. Run npm run native:normalize before packing downloaded artifacts.`);
    }
  }

  return { errors };
}

export function validateBinTruth(binEntries, pathSet) {
  const errors = [];
  for (const [name, target] of binEntries) {
    const targetPath = toPosix(target);
    if (!existsSync(targetPath)) {
      errors.push(`Bin target missing locally: ${name} -> ${targetPath}`);
      continue;
    }
    if (!pathSet.has(targetPath)) {
      errors.push(`Bin target not packed: ${name} -> ${targetPath}`);
      continue;
    }
    if (!targetPath.startsWith("dist/")) {
      errors.push(`Bin target not under dist/: ${name} -> ${targetPath}`);
      continue;
    }
    try {
      const firstLine = readFileSync(targetPath, "utf-8").split(/\r?\n/)[0];
      if (!firstLine.startsWith("#!/usr/bin/env node")) {
        errors.push(`Bin target missing shebang: ${name} -> ${targetPath}`);
      }
    } catch (e) {
      errors.push(`Could not read bin target: ${name} -> ${targetPath}`);
    }
  }
  return { errors };
}

export function validateDistDrift(srcFiles, distFiles, pathSet) {
  const errors = [];
  const srcTsSet = new Set(
    srcFiles
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .map((f) => f.replace(/\.ts$/, ""))
  );

  const expectedDistArtifacts = [];
  for (const srcBase of srcTsSet) {
    expectedDistArtifacts.push(`dist/${srcBase}.js`);
    expectedDistArtifacts.push(`dist/${srcBase}.d.ts`);
    // .js.map excluded for smaller tarball
    // .d.ts.map excluded for smaller tarball
  }

  for (const artifact of expectedDistArtifacts) {
    if (!pathSet.has(artifact)) {
      errors.push(`Missing expected dist artifact: ${artifact}`);
    }
  }

  for (const distFile of distFiles) {
    if (!distFile.endsWith(".js")) continue;
    if (distFile.endsWith(".d.ts")) continue;
    const base = distFile.replace(/\.js$/, "");
    if (!srcTsSet.has(base) && !STALE_DIST_ALLOWLIST.has(`dist/${distFile}`)) {
      errors.push(`Stale dist file: dist/${distFile}`);
    }
  }

  return { errors };
}

export function validateSourcemapPaths(mapFiles) {
  const errors = [];
  for (const mapFile of mapFiles) {
    try {
      const mapContent = JSON.parse(readFileSync(mapFile, "utf-8"));
      const sources = Array.isArray(mapContent.sources)
        ? mapContent.sources
        : [];
      for (const src of sources) {
        if (typeof src !== "string") continue;
        if (src.startsWith("/") || /^[A-Za-z]:[\\/]/.test(src)) {
          errors.push(`Sourcemap absolute path in ${mapFile}: ${src}`);
        }
        if (src.includes("node_modules")) {
          errors.push(`Sourcemap node_modules path in ${mapFile}: ${src}`);
        }
        if (src.includes("././") || (src.includes("..") && !/^(\.\.\/)+src\//.test(src))) {
          errors.push(`Sourcemap traversal path in ${mapFile}: ${src}`);
        }
      }
    } catch {
      // ignore unreadable maps
    }
  }
  return { errors };
}

export function validateMarkdownLinks(markdownFiles, pathSet) {
  const errors = [];
  for (const mdFile of markdownFiles) {
    const content = readFileSync(mdFile, "utf-8");
    const links = parseMarkdownLocalLinks(content);
    for (const link of links) {
      const resolved = resolveLink(mdFile, link);
      if (!pathSet.has(resolved)) {
        errors.push(
          `Broken local link in ${mdFile}: ${link} -> ${resolved}`
        );
      }
    }
  }
  return { errors };
}

export function validateTemplateAgentReferences(pathSet, rootPath = "templates/.omk/agents/root.yaml") {
  const errors = [];
  if (!pathSet.has(rootPath)) return { errors };

  let content;
  try {
    content = readFileSync(rootPath, "utf-8");
  } catch (error) {
    errors.push(`Template agent root missing locally: ${rootPath}: ${error.message}`);
    return { errors };
  }

  for (const match of content.matchAll(/^\s*path:\s*([^#\s]+)\s*$/gm)) {
    const rawPath = match[1].replace(/^["']|["']$/g, "");
    if (rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath)) {
      errors.push(`Template agent path must be relative: ${rootPath} -> ${rawPath}`);
      continue;
    }
    const resolved = resolveLink(rootPath, rawPath);
    if (!pathSet.has(resolved)) {
      errors.push(`Broken template agent path in ${rootPath}: ${rawPath} -> ${resolved}`);
    }
  }

  return { errors };
}

export function validateSizeBudgets(files, pkg) {
  const errors = [];
  const tarballSizeBytes = typeof pkg.size === "number" ? pkg.size : 0;
  const unpackedSizeBytes =
    typeof pkg.unpackedSize === "number" ? pkg.unpackedSize : 0;
  const entryCount =
    typeof pkg.entryCount === "number" ? pkg.entryCount : files.length;

  const sizeMb = tarballSizeBytes / (1024 * 1024);
  const unpackedMb = unpackedSizeBytes / (1024 * 1024);

  if (sizeMb > SIZE_BUDGETS.tarballMb) {
    errors.push(
      `Tarball size ${sizeMb.toFixed(2)} MB exceeds ${SIZE_BUDGETS.tarballMb} MB`
    );
  }
  if (unpackedMb > SIZE_BUDGETS.unpackedMb) {
    errors.push(
      `Unpacked size ${unpackedMb.toFixed(2)} MB exceeds ${SIZE_BUDGETS.unpackedMb} MB`
    );
  }
  if (entryCount > SIZE_BUDGETS.entryCount) {
    errors.push(
      `Entry count ${entryCount} exceeds ${SIZE_BUDGETS.entryCount}`
    );
  }

  const largestFiles = [];
  const groupSizes = new Map();
  for (const f of files) {
    const path = toPosix(f.path || "");
    const size = f.size || 0;
    const fileSizeMb = size / (1024 * 1024);
    if (fileSizeMb > SIZE_BUDGETS.singleFileMb) {
      errors.push(
        `Oversized single file: ${path} ${fileSizeMb.toFixed(2)} MB`
      );
    }
    largestFiles.push({ path, size, sizeMb: fileSizeMb });
    const group = path.includes("/") ? path.split("/")[0] + "/" : "(root)";
    groupSizes.set(group, (groupSizes.get(group) ?? 0) + size);
  }

  let readmeassetTotal = 0;
  let distTotal = 0;
  for (const f of files) {
    const path = toPosix(f.path || "");
    if (path.startsWith("readmeasset/")) readmeassetTotal += f.size || 0;
    if (path.startsWith("dist/")) distTotal += f.size || 0;
  }
  const readmeassetMb = readmeassetTotal / (1024 * 1024);
  const distMb = distTotal / (1024 * 1024);

  if (readmeassetMb > SIZE_BUDGETS.readmeassetMb) {
    errors.push(
      `readmeasset/ size ${readmeassetMb.toFixed(2)} MB exceeds ${SIZE_BUDGETS.readmeassetMb} MB`
    );
  }
  if (distMb > SIZE_BUDGETS.distMb) {
    errors.push(
      `dist/ size ${distMb.toFixed(2)} MB exceeds ${SIZE_BUDGETS.distMb} MB`
    );
  }

  const sizeDrivers = {
    groups: [...groupSizes.entries()]
      .map(([path, size]) => ({ path, size, sizeMb: size / (1024 * 1024) }))
      .sort((a, b) => b.size - a.size),
    largestFiles: largestFiles.slice().sort((a, b) => b.size - a.size),
  };

  return { errors, largestFiles, sizeDrivers };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

function log(label, message, type = "info") {
  const icons = { info: "ℹ️", ok: "✅", warn: "⚠️", fail: "❌" };
  console.log(`${icons[type] || "ℹ️"} [${label}] ${message}`);
}

function ciAnnotation(type, message) {
  if (process.env.CI) {
    console.log(`::${type}::${message}`);
  }
}

function runValidator(label, result, ciPrefix) {
  let failed = false;
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      log(label, err, "fail");
      ciAnnotation("error", `${ciPrefix}: ${err}`);
    }
    failed = true;
  } else {
    log(label, "passed", "ok");
  }
  return failed;
}


export function resolveTarballArg(pattern, cwd = process.cwd()) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    const p = resolve(cwd, pattern);
    if (!existsSync(p)) throw new Error(`Tarball not found: ${p}`);
    return p;
  }

  const absolutePattern = resolve(cwd, pattern);
  const dir = dirname(absolutePattern) || cwd;
  const base = basename(absolutePattern);
  const regex = new RegExp(
    "^" + base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") + "$"
  );
  const files = readdirSync(dir).filter((f) => regex.test(f)).sort();

  if (files.length === 0) throw new Error(`No tarball matches glob: ${pattern}`);
  if (files.length > 1) throw new Error(`Ambiguous tarball glob ${pattern}: ${files.join(", ")}`);
  return join(dir, files[0]);
}


export function modeFromTarPermissions(permissions) {
  if (!/^[bcdlps-][rwxstST-]{9}$/.test(permissions)) return 0o644;
  let mode = 0;
  const triplets = [permissions.slice(1, 4), permissions.slice(4, 7), permissions.slice(7, 10)];
  for (const triplet of triplets) {
    mode <<= 3;
    if (triplet[0] === "r") mode |= 4;
    if (triplet[1] === "w") mode |= 2;
    if (["x", "s", "t"].includes(triplet[2])) mode |= 1;
  }
  return mode;
}

export function readTarballMetadata(tarballPath) {
  const tarballDir = dirname(tarballPath);
  const tarballName = basename(tarballPath);

  // Extract package.json from tarball without shell interpolation.
  const pkgJson = execFileSync("tar", ["-xzf", tarballName, "-O", "package/package.json"], {
    cwd: tarballDir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  const pkg = JSON.parse(pkgJson);

  // List all entries with permissions without shell interpolation.
  const listOutput = execFileSync("tar", ["-tvzf", tarballName], {
    cwd: tarballDir,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  const files = listOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l)
    .flatMap((line) => {
      const pathIndex = line.indexOf(" package/");
      if (pathIndex === -1) return [];
      const pathPart = line.slice(pathIndex + 1).replace(/ -> .+$/, "");
      if (!pathPart.startsWith("package/") || pathPart.endsWith("/")) return [];
      const prefix = line.slice(0, pathIndex).trim();
      const columns = prefix.split(/\s+/);
      const permissions = columns[0] || "";
      const sizeMatch = /\s(\d+)\s+(?:\d{4}-\d{2}-\d{2}|[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:)/.exec(prefix);
      const parsedSize = Number.parseInt(sizeMatch?.[1] ?? columns[2] ?? "0", 10);
      const size = Number.isFinite(parsedSize) ? parsedSize : 0;
      return [{ path: pathPart.slice("package/".length), size, mode: modeFromTarPermissions(permissions) }];
    });

  return [{
    name: pkg.name,
    version: pkg.version,
    filename: basename(tarballPath),
    size: statSync(tarballPath).size,
    unpackedSize: 0,
    entryCount: files.length,
    files,
  }];
}

export function resolveNpmPackCommand(env = process.env, platform = process.platform) {
  if (env.npm_execpath) {
    return {
      command: process.execPath,
      argsPrefix: [env.npm_execpath],
    };
  }
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    argsPrefix: [],
  };
}

export function main(tarballPath) {
  const isCI = Boolean(process.env.CI);
  let failed = false;

  // 1. Obtain pack metadata
  let packResult;
  try {
    if (tarballPath) {
      packResult = readTarballMetadata(resolveTarballArg(tarballPath));
    } else {
      const npmCmd = resolveNpmPackCommand(process.env, process.platform);
      const smokeTmpDir = process.env.OMK_SMOKE_TMPDIR || LINUX_TMPDIR;
      const env = {
        ...process.env,
        ...(smokeTmpDir ? { TMPDIR: smokeTmpDir, TMP: smokeTmpDir, TEMP: smokeTmpDir } : {}),
        ...(process.env.npm_config_cache || smokeTmpDir
          ? { npm_config_cache: process.env.npm_config_cache || `${smokeTmpDir}/omk-npm-cache` }
          : {}),
      };
      const stdout = execFileSync(npmCmd.command, [
        ...npmCmd.argsPrefix,
        "pack",
        "--dry-run",
        "--ignore-scripts",
        "--json",
      ], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
        env,
      });
      const jsonStart = stdout.indexOf("[");
      if (jsonStart === -1) throw new Error("No JSON array found in npm pack output");
      packResult = JSON.parse(stdout.slice(jsonStart));
    }
  } catch (e) {
    log("PACK", `Failed to obtain pack metadata: ${e.message}`, "fail");
    ciAnnotation("error", `Failed to obtain pack metadata: ${e.message}`);
    process.exit(1);
  }

  const struct = validatePackStructure(packResult);
  if (struct.errors.length > 0) {
    for (const err of struct.errors) {
      log("PACK", err, "fail");
      ciAnnotation("error", err);
    }
    failed = true;
  }
  if (!struct.pkg) {
    process.exit(1);
  }
  const pkg = struct.pkg;
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const tarballName = pkg.filename || "unknown.tgz";

  // 2. Read local package.json
  let localPkg;
  try {
    localPkg = JSON.parse(readFileSync("package.json", "utf-8"));
  } catch (e) {
    log("PACKAGE", `Could not read local package.json: ${e.message}`, "fail");
    ciAnnotation("error", `Could not read local package.json: ${e.message}`);
    process.exit(1);
  }

  const pathSet = new Set(files.map((f) => toPosix(f.path || "")));

  failed = runValidator("METADATA", validateMetadata(localPkg, pkg), "METADATA") || failed;
  failed = runValidator("REQUIRED", validateRequiredEntries(files, REQUIRED_ENTRIES), "REQUIRED") || failed;
  failed = runValidator("NON_EMPTY_TEXT", validateNonEmptyTextEntries(files, NON_EMPTY_TEXT_ENTRIES), "NON_EMPTY_TEXT") || failed;
  failed = runValidator("FORBIDDEN", validateForbiddenEntries(files, FORBIDDEN_PATTERNS), "FORBIDDEN") || failed;
  failed = runValidator("FILES_ALLOWLIST", validateFilesAllowlist(localPkg.files || [], pathSet), "FILES_ALLOWLIST") || failed;
  failed = runValidator("TEMPLATE_AGENT_REFS", validateTemplateAgentReferences(pathSet), "TEMPLATE_AGENT_REFS") || failed;

  const binEntries = localPkg.bin && typeof localPkg.bin === "object"
    ? Object.entries(localPkg.bin)
    : [];
  failed = runValidator("BIN", validateBinTruth(binEntries, pathSet), "BIN") || failed;
  failed = runValidator("NATIVE_SAFETY", validateNativeSafety(files), "NATIVE_SAFETY") || failed;

  // Dist drift
  if (existsSync("src") && existsSync("dist")) {
    const srcFiles = walkDir("src");
    const distFiles = walkDir("dist");
    failed = runValidator("DIST_DRIFT", validateDistDrift(srcFiles, distFiles, pathSet), "DIST_DRIFT") || failed;

    const mapFiles = [...pathSet].filter(
      (p) => p.endsWith(".js.map") || p.endsWith(".d.ts.map")
    );
    failed = runValidator("SOURCEMAP", validateSourcemapPaths(mapFiles), "SOURCEMAP") || failed;
  } else {
    log("DIST_DRIFT", "src/ or dist/ missing — skipping drift check", "warn");
  }

  // Markdown links
  const markdownFiles = [];
  if (existsSync("README.md")) markdownFiles.push("README.md");
  if (existsSync("docs")) {
    for (const f of walkDir("docs")) {
      if (f.endsWith(".md")) markdownFiles.push(`docs/${f}`);
    }
  }
  failed = runValidator("LINK", validateMarkdownLinks(markdownFiles, pathSet), "LINK") || failed;

  // Size budgets
  const sizeResult = validateSizeBudgets(files, pkg);
  if (sizeResult.errors.length > 0) {
    for (const err of sizeResult.errors) {
      log("SIZE", err, "fail");
      ciAnnotation("error", err);
    }
    failed = true;
    const groups = sizeResult.sizeDrivers?.groups ?? [];
    if (groups.length > 0) {
      console.log("\n📦 Top size drivers by package directory:");
      for (const group of groups.slice(0, 8)) {
        console.log(`   ${group.sizeMb.toFixed(2)} MB  ${group.path}`);
      }
    }
    sizeResult.largestFiles.sort((a, b) => b.size - a.size);
    console.log("\n📦 Top 10 largest files in tarball:");
    for (const f of sizeResult.largestFiles.slice(0, 10)) {
      console.log(`   ${f.sizeMb.toFixed(2)} MB  ${f.path}`);
    }
  } else {
    log("SIZE", "All size budgets within limits", "ok");
  }

  // CI Summary
  const tarballSizeBytes = typeof pkg.size === "number" ? pkg.size : 0;
  const unpackedSizeBytes = typeof pkg.unpackedSize === "number" ? pkg.unpackedSize : 0;
  const entryCount = typeof pkg.entryCount === "number" ? pkg.entryCount : files.length;
  const sizeMb = tarballSizeBytes / (1024 * 1024);
  const unpackedMb = unpackedSizeBytes / (1024 * 1024);

  const summaryLines = [
    "## Package Audit Summary",
    `- Tarball: ${tarballName}`,
    `- Size: ${sizeMb.toFixed(2)} MB (compressed) / ${unpackedMb.toFixed(2)} MB (unpacked)`,
    `- Entries: ${entryCount}`,
    `- Required: ${REQUIRED_ENTRIES.join(", ")}`,
    `- Native safety: ${expectedNativeSafetyPath()}`,
    `- Forbidden patterns: ${FORBIDDEN_PATTERNS.length} rules`,
    `- Result: ${failed ? "FAILED" : "PASSED"}`,
  ];
  console.log("");
  for (const line of summaryLines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        summaryLines.join("\n") + "\n",
        "utf-8"
      );
    } catch {
      // ignore
    }
  }

  if (failed) {
    log("AUDIT", "Package audit FAILED", "fail");
    process.exit(1);
  }

  log("AUDIT", "Package audit passed", "ok");
}

function parseTarballArg() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--tarball");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main(parseTarballArg());
}
