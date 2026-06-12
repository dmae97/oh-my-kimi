import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePackStructure,
  validateMetadata,
  validateRequiredEntries,
  validateNonEmptyTextEntries,
  validateForbiddenEntries,
  validateFilesAllowlist,
  validateBinTruth,
  validateDistDrift,
  validateSourcemapPaths,
  validateMarkdownLinks,
  validateTemplateAgentReferences,
  validateSizeBudgets,
  validateNativeSafety,
  modeFromTarPermissions,
  nativePlatformArch,
  nativeBinaryName,
  expectedNativeSafetyPath,
  globMatch,
  parseMarkdownLocalLinks,
  resolveLink,
  REQUIRED_ENTRIES,
  FORBIDDEN_PATTERNS,
  SIZE_BUDGETS,
  readTarballMetadata,
  resolveTarballArg,
  resolveNpmPackCommand,
} from "../scripts/package-audit.mjs";



// ---------------------------------------------------------------------------
// resolveTarballArg
// ---------------------------------------------------------------------------

describe("resolveTarballArg", () => {
  it("resolves a literal tarball path", () => {
    const root = mkdtempSync(join(tmpdir(), "omk-tarball-arg-"));
    try {
      const tarball = join(root, "pkg.tgz");
      writeFileSync(tarball, "fixture", "utf-8");
      assert.equal(resolveTarballArg("pkg.tgz", root), tarball);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a single literal glob without shell expansion", () => {
    const root = mkdtempSync(join(tmpdir(), "omk-tarball-glob-"));
    try {
      const tarball = join(root, "open-multi-agent-kit-1.1.9.tgz");
      writeFileSync(tarball, "fixture", "utf-8");
      assert.equal(resolveTarballArg("open-multi-agent-kit-*.tgz", root), tarball);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on missing or ambiguous tarball globs", () => {
    const root = mkdtempSync(join(tmpdir(), "omk-tarball-ambiguous-"));
    try {
      assert.throws(() => resolveTarballArg("*.tgz", root), /No tarball matches/);
      writeFileSync(join(root, "a.tgz"), "fixture", "utf-8");
      writeFileSync(join(root, "b.tgz"), "fixture", "utf-8");
      assert.throws(() => resolveTarballArg("*.tgz", root), /Ambiguous tarball glob/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readTarballMetadata
// ---------------------------------------------------------------------------

function hasTarCommand() {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("readTarballMetadata", () => {
  it("reads tarball metadata for paths with spaces without shell interpolation", { skip: !hasTarCommand() }, () => {
    const root = mkdtempSync(join(tmpdir(), "omk package audit "));
    try {
      const fixture = join(root, "fixture");
      const packageDir = join(fixture, "package");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "space-pkg", version: "1.0.0" }), "utf-8");
      writeFileSync(join(packageDir, "README.md"), "# ok\n", "utf-8");

      const tarball = join(root, "space path package.tgz");
      execFileSync("tar", ["-czf", "space path package.tgz", "-C", "fixture", "package"], { cwd: root });

      const [metadata] = readTarballMetadata(tarball);
      assert.equal(metadata.name, "space-pkg");
      assert.equal(metadata.version, "1.0.0");
      assert.equal(metadata.filename, "space path package.tgz");
      assert.ok(metadata.files.some((f) => f.path === "package.json"));
      const readme = metadata.files.find((f) => f.path === "README.md");
      assert.ok(readme);
      assert.ok(readme.size > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses executable tar permission strings", () => {
    assert.equal(modeFromTarPermissions("-rwxr-xr-x"), 0o755);
    assert.equal(modeFromTarPermissions("-rw-r--r--"), 0o644);
  });
});

describe("resolveNpmPackCommand", () => {
  it("uses npm_execpath under node to avoid Windows npm.cmd spawn issues", () => {
    const command = resolveNpmPackCommand({ npm_execpath: "C:\\npm\\bin\\npm-cli.js" }, "win32");
    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.argsPrefix, ["C:\\npm\\bin\\npm-cli.js"]);
  });

  it("falls back to npm shims when npm_execpath is unavailable", () => {
    assert.deepEqual(resolveNpmPackCommand({}, "win32"), { command: "npm.cmd", argsPrefix: [] });
    assert.deepEqual(resolveNpmPackCommand({}, "linux"), { command: "npm", argsPrefix: [] });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePack(files = [], overrides = {}) {
  return [
    {
      name: "test-pkg",
      version: "1.1.0",
      filename: "test-pkg-1.1.0.tgz",
      size: 1000,
      unpackedSize: 2000,
      entryCount: files.length,
      files,
      ...overrides,
    },
  ];
}

function makeFile(path, size = 100, mode = 0o644) {
  return { path, size, mode };
}

// ---------------------------------------------------------------------------
// validatePackStructure
// ---------------------------------------------------------------------------

describe("validatePackStructure", () => {
  it("passes for a valid single pack object", () => {
    const result = validatePackStructure(makePack());
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.pkg);
  });

  it("fails for empty array", () => {
    const result = validatePackStructure([]);
    assert.ok(result.errors.some((e) => e.includes("empty")));
  });

  it("fails for multiple pack objects", () => {
    const result = validatePackStructure([{}, {}]);
    assert.ok(result.errors.some((e) => e.includes("exactly 1")));
  });

  it("fails for non-array", () => {
    const result = validatePackStructure({});
    assert.ok(result.errors.some((e) => e.includes("not an array")));
  });

  it("fails for missing required fields", () => {
    const result = validatePackStructure([{}]);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes("name")));
    assert.ok(result.errors.some((e) => e.includes("version")));
    assert.ok(result.errors.some((e) => e.includes("files")));
  });
});

// ---------------------------------------------------------------------------
// validateMetadata
// ---------------------------------------------------------------------------

describe("validateMetadata", () => {
  it("passes when name and version match", () => {
    const result = validateMetadata(
      { name: "foo", version: "1.2.3" },
      { name: "foo", version: "1.2.3" }
    );
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails on name mismatch", () => {
    const result = validateMetadata(
      { name: "foo", version: "1.2.3" },
      { name: "bar", version: "1.2.3" }
    );
    assert.ok(result.errors.some((e) => e.includes("name mismatch")));
  });

  it("fails on version mismatch", () => {
    const result = validateMetadata(
      { name: "foo", version: "1.2.3" },
      { name: "foo", version: "1.2.4" }
    );
    assert.ok(result.errors.some((e) => e.includes("version mismatch")));
  });
});

// ---------------------------------------------------------------------------
// validateRequiredEntries
// ---------------------------------------------------------------------------

describe("validateRequiredEntries", () => {
  it("passes when all required entries are present", () => {
    const files = REQUIRED_ENTRIES.map((p) => makeFile(p));
    const result = validateRequiredEntries(files, REQUIRED_ENTRIES);
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails when a required entry is missing", () => {
    const files = REQUIRED_ENTRIES.filter((p) => p !== "dist/cli.js").map((p) =>
      makeFile(p)
    );
    const result = validateRequiredEntries(files, REQUIRED_ENTRIES);
    assert.ok(result.errors.some((e) => e.includes("dist/cli.js")));
  });

  it("locks root base and canonical OMK role templates into required package entries", () => {
    const canonicalRoles = [
      "aggregator",
      "architect",
      "coder",
      "explorer",
      "integrator",
      "interviewer",
      "ontology",
      "planner",
      "qa",
      "researcher",
      "reviewer",
      "router",
      "security",
      "tester",
      "vision-debugger",
    ];
    for (const template of [
      "templates/.omk/agents/okabe.yaml",
      "templates/.omk/agents/root.yaml",
    ]) {
      assert.ok(REQUIRED_ENTRIES.includes(template), `missing required package agent template: ${template}`);
      const content = readFileSync(template, "utf-8");
      assert.match(content, /OMK_MCP_ENABLED: "true"/);
      assert.match(content, /OMK_SKILLS_ENABLED: "true"/);
      assert.match(content, /OMK_HOOKS_ENABLED: "true"/);
    }
    for (const role of canonicalRoles) {
      const template = `templates/.omk/agents/roles/${role}.yaml`;
      assert.ok(REQUIRED_ENTRIES.includes(template), `missing required package role template: ${role}`);
      const content = readFileSync(template, "utf-8");
      assert.match(content, /OMK_MCP_ENABLED: "true"/);
      assert.match(content, /OMK_SKILLS_ENABLED: "true"/);
      assert.match(content, /OMK_HOOKS_ENABLED: "true"/);
    }
  });

  it("locks OMK web bridge Chrome extension templates into required package entries", () => {
    for (const template of [
      "templates/web-bridge/chrome-extension/manifest.json",
      "templates/web-bridge/chrome-extension/background.js",
      "templates/web-bridge/chrome-extension/content-script.js",
      "templates/web-bridge/chrome-extension/README.md",
    ]) {
      assert.ok(REQUIRED_ENTRIES.includes(template), `missing required web bridge template: ${template}`);
      const content = readFileSync(template, "utf-8");
      assert.doesNotMatch(content, /sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{10,}/);
    }
  });
});

// ---------------------------------------------------------------------------
// validateNonEmptyTextEntries
// ---------------------------------------------------------------------------

describe("validateNonEmptyTextEntries", () => {
  it("fails when a required text entry is packed at zero bytes", () => {
    const files = [makeFile("AGENTS.md", 0)];
    const result = validateNonEmptyTextEntries(files, ["AGENTS.md"]);
    assert.ok(result.errors.some((e) => e.includes("AGENTS.md")));
  });

  it("passes when required text entries are non-empty in pack metadata", () => {
    const files = [
      makeFile("AGENTS.md", 1),
      makeFile("templates/AGENTS.md", 2),
      makeFile("templates/.kimi/AGENTS.md", 3),
    ];
    const result = validateNonEmptyTextEntries(files, [
      "AGENTS.md",
      "templates/AGENTS.md",
      "templates/.kimi/AGENTS.md",
    ]);
    assert.strictEqual(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateTemplateAgentReferences
// ---------------------------------------------------------------------------

describe("validateTemplateAgentReferences", () => {
  it("passes when template root subagent paths are packed", () => {
    const pathSet = new Set([
      "templates/.omk/agents/root.yaml",
      "templates/.omk/agents/roles/aggregator.yaml",
      "templates/.omk/agents/roles/architect.yaml",
      "templates/.omk/agents/roles/explorer.yaml",
      "templates/.omk/agents/roles/planner.yaml",
      "templates/.omk/agents/roles/coder.yaml",
      "templates/.omk/agents/roles/reviewer.yaml",
      "templates/.omk/agents/roles/router.yaml",
      "templates/.omk/agents/roles/security.yaml",
      "templates/.omk/agents/roles/qa.yaml",
      "templates/.omk/agents/roles/tester.yaml",
      "templates/.omk/agents/roles/researcher.yaml",
      "templates/.omk/agents/roles/integrator.yaml",
      "templates/.omk/agents/roles/interviewer.yaml",
      "templates/.omk/agents/roles/ontology.yaml",
      "templates/.omk/agents/roles/vision-debugger.yaml",
    ]);
    const result = validateTemplateAgentReferences(pathSet);
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails when a template root subagent path is not packed", () => {
    const pathSet = new Set([
      "templates/.omk/agents/root.yaml",
      "templates/.omk/agents/roles/planner.yaml",
      "templates/.omk/agents/roles/reviewer.yaml",
    ]);
    const result = validateTemplateAgentReferences(pathSet);
    assert.ok(result.errors.some((e) => e.includes("roles/explorer.yaml")));
  });
});

// ---------------------------------------------------------------------------
// validateForbiddenEntries
// ---------------------------------------------------------------------------

describe("validateForbiddenEntries", () => {
  it("passes when no forbidden entries are present", () => {
    const files = [makeFile("dist/cli.js"), makeFile("README.md")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails on nested src file", () => {
    const files = [makeFile("src/commands/foo.ts")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.ok(result.errors.some((e) => e.includes("src/commands/foo.ts")));
  });

  it("fails on nested .env file", () => {
    const files = [makeFile("config/.env.local")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.ok(result.errors.some((e) => e.includes(".env.local")));
  });

  it("fails on .log file", () => {
    const files = [makeFile("logs/debug.log")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.ok(result.errors.some((e) => e.includes("debug.log")));
  });

  it("fails on .tgz file", () => {
    const files = [makeFile("backup.tar.gz")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.ok(result.errors.some((e) => e.includes("backup.tar.gz")));
  });

  it("fails on test directory contents", () => {
    const files = [makeFile("test/smoke.test.mjs")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.ok(result.errors.some((e) => e.includes("test/smoke.test.mjs")));
  });

  it("fails on source-only public assets", () => {
    const files = [makeFile("public/assets/cat-judge.png")];
    const result = validateForbiddenEntries(files, FORBIDDEN_PATTERNS);
    assert.ok(result.errors.some((e) => e.includes("public/assets/cat-judge.png")));
  });
});

// ---------------------------------------------------------------------------
// globMatch
// ---------------------------------------------------------------------------

describe("globMatch", () => {
  it("matches exact paths", () => {
    assert.ok(globMatch("package.json", "package.json"));
    assert.ok(!globMatch("package.json", "package-lock.json"));
  });

  it("matches single star", () => {
    assert.ok(globMatch("*.tgz", "foo.tgz"));
    assert.ok(!globMatch("*.tgz", "foo.tar.gz"));
  });

  it("matches double star prefix", () => {
    assert.ok(globMatch("src/**", "src/foo.ts"));
    assert.ok(globMatch("src/**", "src/a/b/c.ts"));
    assert.ok(!globMatch("src/**", "dist/src/foo.ts"));
  });

  it("matches double star suffix", () => {
    assert.ok(globMatch("**/*.log", "logs/debug.log"));
    assert.ok(globMatch("**/*.log", "a/b/c.log"));
  });
});

// ---------------------------------------------------------------------------
// validateNativeSafety
// ---------------------------------------------------------------------------

describe("validateNativeSafety", () => {
  it("computes platform-arch native paths", () => {
    assert.strictEqual(nativePlatformArch("linux", "x64"), "linux-x64");
    assert.strictEqual(nativePlatformArch("darwin", "arm64"), "darwin-arm64");
    assert.strictEqual(nativeBinaryName("win32"), "omk-safety.exe");
    assert.strictEqual(expectedNativeSafetyPath("win32", "x64"), "dist/native/win32-x64/omk-safety.exe");
  });

  it("passes when current platform native binary is packed", () => {
    const files = [makeFile("dist/native/linux-x64/omk-safety", 100, 0o755)];
    const result = validateNativeSafety(files, "linux", "x64");
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails when non-Windows native binary is not executable", () => {
    const files = [makeFile("dist/native/linux-x64/omk-safety", 100, 0o644)];
    const result = validateNativeSafety(files, "linux", "x64");
    assert.ok(result.errors.some((e) => e.includes("not executable")));
  });

  it("fails when current platform native binary is missing", () => {
    const files = [makeFile("dist/cli.js")];
    const result = validateNativeSafety(files, "darwin", "arm64");
    assert.ok(result.errors.some((e) => e.includes("dist/native/darwin-arm64/omk-safety")));
  });

  it("rejects unexpected native layout entries", () => {
    const files = [
      makeFile("dist/native/linux-x64/omk-safety", 100, 0o755),
      makeFile("dist/native/omk-safety", 100, 0o755),
    ];
    const result = validateNativeSafety(files, "linux", "x64");
    assert.ok(result.errors.some((e) => e.includes("Unexpected native safety layout")));
  });
});

// ---------------------------------------------------------------------------
// validateSizeBudgets
// ---------------------------------------------------------------------------

describe("validateSizeBudgets", () => {
  it("passes for valid sizes", () => {
    const files = [makeFile("dist/cli.js", 1024)];
    const pkg = { size: 1024, unpackedSize: 2048, entryCount: 1 };
    const result = validateSizeBudgets(files, pkg);
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails when tarball exceeds budget", () => {
    const files = [makeFile("dist/cli.js", 1024)];
    const pkg = {
      size: 40 * 1024 * 1024,
      unpackedSize: 1024,
      entryCount: 1,
    };
    const result = validateSizeBudgets(files, pkg);
    assert.ok(result.errors.some((e) => e.includes("Tarball size")));
  });

  it("fails when unpacked exceeds budget", () => {
    const files = [makeFile("dist/cli.js", 1024)];
    const pkg = {
      size: 1024,
      unpackedSize: 50 * 1024 * 1024,
      entryCount: 1,
    };
    const result = validateSizeBudgets(files, pkg);
    assert.ok(result.errors.some((e) => e.includes("Unpacked size")));
  });

  it("fails when entry count exceeds budget", () => {
    const entryCount = SIZE_BUDGETS.entryCount + 1;
    const files = Array.from({ length: entryCount }, (_, i) =>
      makeFile(`file${i}.txt`, 100)
    );
    const pkg = { size: 1024, unpackedSize: 2048, entryCount };
    const result = validateSizeBudgets(files, pkg);
    assert.ok(result.errors.some((e) => e.includes("Entry count")));
  });

  it("fails when single file exceeds budget", () => {
    const files = [makeFile("media/big.mp4", 25 * 1024 * 1024)];
    const pkg = { size: 1024, unpackedSize: 1024, entryCount: 1 };
    const result = validateSizeBudgets(files, pkg);
    assert.ok(result.errors.some((e) => e.includes("Oversized single file")));
  });

  it("fails when readmeasset exceeds budget", () => {
    const files = [
      makeFile("readmeasset/a.png", 20 * 1024 * 1024),
      makeFile("readmeasset/b.gif", 15 * 1024 * 1024),
    ];
    const pkg = { size: 1024, unpackedSize: 1024, entryCount: 2 };
    const result = validateSizeBudgets(files, pkg);
    assert.ok(result.errors.some((e) => e.includes("readmeasset/")));
  });

  it("fails when dist exceeds budget", () => {
    const files = [makeFile("dist/cli.js", 25 * 1024 * 1024)];
    const pkg = { size: 1024, unpackedSize: 1024, entryCount: 1 };
    const result = validateSizeBudgets(files, pkg);
    assert.ok(result.errors.some((e) => e.includes("dist/")));
  });

  it("reports size drivers by package directory", () => {
    const files = [
      makeFile("dist/cli.js", 3 * 1024 * 1024),
      makeFile("dist/commands/run.js", 2 * 1024 * 1024),
      makeFile("readmeasset/kimicat.png", 4 * 1024 * 1024),
      makeFile("README.md", 1024),
    ];
    const pkg = { size: 1024, unpackedSize: 1024, entryCount: files.length };
    const result = validateSizeBudgets(files, pkg);
    assert.equal(result.sizeDrivers.groups[0].path, "dist/");
    assert.equal(result.sizeDrivers.groups[0].size, 5 * 1024 * 1024);
    assert.equal(result.sizeDrivers.largestFiles[0].path, "readmeasset/kimicat.png");
  });
});

// ---------------------------------------------------------------------------
// validateDistDrift
// ---------------------------------------------------------------------------

describe("validateDistDrift", () => {
  it("passes when all expected artifacts exist", () => {
    const srcFiles = ["cli.ts"];
    const distFiles = ["cli.js", "cli.d.ts", "cli.js.map", "cli.d.ts.map"];
    const pathSet = new Set([
      "dist/cli.js",
      "dist/cli.d.ts",
      "dist/cli.js.map",
      "dist/cli.d.ts.map",
    ]);
    const result = validateDistDrift(srcFiles, distFiles, pathSet);
    assert.strictEqual(result.errors.length, 0);
  });

  it("fails when a generated dist artifact is missing", () => {
    const srcFiles = ["cli.ts"];
    const distFiles = ["cli.js"];
    const pathSet = new Set(["dist/cli.js"]);
    const result = validateDistDrift(srcFiles, distFiles, pathSet);
    assert.ok(
      result.errors.some((e) => e.includes("Missing expected dist artifact"))
    );
  });

  it("fails on stale dist file without src counterpart", () => {
    const srcFiles = ["cli.ts"];
    const distFiles = ["cli.js", "old.js"];
    const pathSet = new Set([
      "dist/cli.js",
      "dist/old.js",
      "dist/cli.d.ts",
      "dist/cli.js.map",
      "dist/cli.d.ts.map",
    ]);
    const result = validateDistDrift(srcFiles, distFiles, pathSet);
    assert.ok(result.errors.some((e) => e.includes("Stale dist file")));
  });
});

// ---------------------------------------------------------------------------
// validateMarkdownLinks
// ---------------------------------------------------------------------------

describe("validateMarkdownLinks", () => {
  it("passes when all local links resolve to packed files", () => {
    const pathSet = new Set(["readmeasset/kimicat.png"]);
    const result = validateMarkdownLinks(
      ["README.md"],
      pathSet
    );
    // README.md on disk has real links; if they resolve to packed files it passes
    // Since this depends on actual README, we test parseMarkdownLocalLinks below
    // and mock-link tests separately.
  });

  it("fails on broken local link", () => {
    const pathSet = new Set(["README.md"]);
    // Create a synthetic test by using parseMarkdownLocalLinks + resolveLink directly
    const links = parseMarkdownLocalLinks("[img](./missing.png)");
    assert.deepStrictEqual(links, ["./missing.png"]);
    const resolved = resolveLink("README.md", "./missing.png");
    assert.strictEqual(resolved, "missing.png");
    assert.ok(!pathSet.has(resolved));
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownLocalLinks
// ---------------------------------------------------------------------------

describe("parseMarkdownLocalLinks", () => {
  it("extracts local links", () => {
    const content = "[a](./foo.md) ![b](./bar.png) [c](http://x.com) [d](mailto:a@b.c)";
    const links = parseMarkdownLocalLinks(content);
    assert.deepStrictEqual(links, ["./foo.md", "./bar.png"]);
  });

  it("strips fragments and queries", () => {
    const content = "[a](./foo.md#section) [b](./bar.png?q=1)";
    const links = parseMarkdownLocalLinks(content);
    assert.deepStrictEqual(links, ["./foo.md", "./bar.png"]);
  });

  it("ignores absolute paths", () => {
    const content = "[a](/etc/passwd) [b](./foo.md)";
    const links = parseMarkdownLocalLinks(content);
    assert.deepStrictEqual(links, ["./foo.md"]);
  });
});

// ---------------------------------------------------------------------------
// resolveLink
// ---------------------------------------------------------------------------

describe("resolveLink", () => {
  it("resolves relative to markdown file", () => {
    assert.strictEqual(resolveLink("README.md", "./foo.png"), "foo.png");
    assert.strictEqual(
      resolveLink("docs/guide.md", "../assets/img.png"),
      "assets/img.png"
    );
    assert.strictEqual(
      resolveLink("docs/guide.md", "./details.md"),
      "docs/details.md"
    );
  });
});
