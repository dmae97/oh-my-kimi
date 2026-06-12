import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SESSION_MODULE = pathToFileURL(
  join(process.cwd(), "dist", "browser", "browser-session.js")
).href;
const OBSERVER_MODULE = pathToFileURL(
  join(process.cwd(), "dist", "browser", "browser-observer.js")
).href;

test("createBrowserSession throws helpful error when playwright import fails", async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), "omk-browser-test-"));
  const fakePlaywrightDir = join(tmpDir, "node_modules", "playwright");
  await mkdir(fakePlaywrightDir, { recursive: true });
  await writeFile(
    join(fakePlaywrightDir, "package.json"),
    JSON.stringify({ name: "playwright", type: "module", exports: { ".": "./index.mjs" } })
  );
  await writeFile(
    join(fakePlaywrightDir, "index.mjs"),
    `throw new Error("Mock playwright not installed");`
  );

  const scriptPath = join(tmpDir, "test-script.mjs");
  await writeFile(
    scriptPath,
    `import { createBrowserSession } from "${SESSION_MODULE}";
try {
  await createBrowserSession({ url: "http://example.com" });
  console.log("PASS: no error");
} catch (err) {
  console.log("ERROR:", err.message);
}`
  );

  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf-8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      OMK_PLAYWRIGHT_MODULE: pathToFileURL(join(fakePlaywrightDir, "index.mjs")).href,
    },
  });

  await rm(tmpDir, { recursive: true, force: true });

  assert.match(
    result.stdout,
    /Playwright is not installed/,
    `Expected helpful error, got stdout: ${result.stdout} stderr: ${result.stderr}`
  );
});

test("getBrowserSessionDir generates correct path", async () => {
  const { getBrowserSessionDir } = await import(SESSION_MODULE);
  const dir = getBrowserSessionDir("/fake/project", "abc123");
  assert.equal(dir, join("/fake/project", ".omk", "browser", "abc123"));

  const dirNoSession = getBrowserSessionDir("/fake/project");
  assert.equal(dirNoSession, join("/fake/project", ".omk", "browser"));
});

test("writeBrowserFeedback appends to feedback.md", async () => {
  const { writeBrowserFeedback } = await import(OBSERVER_MODULE);
  const { getBrowserSessionDir } = await import(SESSION_MODULE);

  const tmpDir = await mkdtemp(join(tmpdir(), "omk-browser-feedback-"));
  const sessionDir = getBrowserSessionDir(tmpDir, "test-session");
  await mkdir(sessionDir, { recursive: true });

  try {
    await writeBrowserFeedback("test-session", "First feedback", tmpDir);
    await writeBrowserFeedback("test-session", "Second feedback", tmpDir);

    const content = await readFile(join(sessionDir, "feedback.md"), "utf-8");
    assert.match(content, /First feedback/);
    assert.match(content, /Second feedback/);
    assert.ok(content.includes("## Feedback —"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("saveBrowserObservation round-trips through readBrowserObservation", async () => {
  const { saveBrowserObservation, readBrowserObservation } = await import(OBSERVER_MODULE);

  const tmpDir = await mkdtemp(join(tmpdir(), "omk-browser-obs-"));
  const sessionDir = join(tmpDir, ".omk", "browser", "sess-2");
  await mkdir(sessionDir, { recursive: true });

  const obs = {
    sessionId: "sess-2",
    url: "http://localhost:3000",
    title: "Test",
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    screenshotPath: "/tmp/sc.png",
    domSnapshotPath: "/tmp/dom.html",
    consoleEventsPath: "/tmp/console.jsonl",
    networkEventsPath: "/tmp/network.jsonl",
    capturedAt: new Date().toISOString(),
  };

  try {
    await saveBrowserObservation(obs, tmpDir);
    const read = await readBrowserObservation("sess-2", tmpDir);
    assert.ok(read);
    assert.strictEqual(read.url, obs.url);
    assert.strictEqual(read.title, obs.title);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
