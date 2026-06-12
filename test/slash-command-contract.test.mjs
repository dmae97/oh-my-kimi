import test from "node:test";
import assert from "node:assert/strict";

const { parseSlashArgs, parseSlashInput, tokenizeSlashArgs } =
  await import("../dist/commands/chat/slash/parser.js");
const { SlashCommandRegistry, createSlashCommandRegistry } =
  await import("../dist/commands/chat/slash/registry.js");
const { errorSlashResult, okSlashResult } =
  await import("../dist/commands/chat/slash/result.js");
const { buildNativeChatSlashCommands } =
  await import("../dist/commands/chat/slash/commands/index.js");
const { buildUiSlashCommands } =
  await import("../dist/commands/chat/slash/commands/ui.js");
const { readFileSync } = await import("node:fs");

test("slash parser handles quoted args and flags without shell evaluation", () => {
  assert.deepEqual(
    tokenizeSlashArgs('"refactor harness tests" --json --limit=20 plain'),
    ["refactor harness tests", "--json", "--limit=20", "plain"],
  );

  const parsed = parseSlashInput(
    '/parallel "refactor harness tests" --json --tag=ui --tag=harness',
  );
  assert.equal(parsed?.command, "/parallel");
  assert.equal(
    parsed?.args.raw,
    '"refactor harness tests" --json --tag=ui --tag=harness',
  );
  assert.deepEqual(parsed?.args.positional, ["refactor harness tests"]);
  assert.deepEqual(parsed?.args.flags, { json: true, tag: ["ui", "harness"] });
});

test("slash parser ignores ordinary chat input", () => {
  assert.equal(parseSlashInput("please review the repo"), undefined);
  assert.deepEqual(parseSlashArgs("").argv, []);
});

test("slash registry resolves primary names and aliases", () => {
  const command = {
    name: "/theme",
    aliases: ["/th", ":theme"],
    group: "ui",
    summary: "Change chat theme",
    usage: "/theme <name>",
    examples: ["/theme green-rain"],
    handler: () => okSlashResult({ text: "theme updated" }),
  };
  const registry = createSlashCommandRegistry([command]);

  assert.equal(registry.find("/theme"), command);
  assert.equal(registry.find("/th"), command);
  assert.equal(registry.resolve(parseSlashInput(":theme green-rain")), command);
  assert.deepEqual(
    registry.list().map((spec) => spec.name),
    ["/theme"],
  );
});

test("slash registry rejects duplicate or non-command names", () => {
  assert.throws(
    () =>
      new SlashCommandRegistry([
        {
          name: "theme",
          aliases: [],
          group: "ui",
          summary: "bad",
          usage: "theme",
          examples: [],
          handler: () => okSlashResult(),
        },
      ]),
    /Invalid slash command name/,
  );

  assert.throws(
    () =>
      new SlashCommandRegistry([
        {
          name: "/theme",
          aliases: ["/th"],
          group: "ui",
          summary: "one",
          usage: "/theme",
          examples: [],
          handler: () => okSlashResult(),
        },
        {
          name: "/other",
          aliases: ["/th"],
          group: "ui",
          summary: "two",
          usage: "/other",
          examples: [],
          handler: () => errorSlashResult("duplicate"),
        },
      ]),
    /Duplicate slash command name/,
  );
});

test("native chat slash command registry exposes modular control-plane commands", () => {
  const commands = buildNativeChatSlashCommands();
  const names = new Set(commands.map((command) => command.name));

  for (const expected of [
    "/help",
    "/status",
    "/provider",
    "/route",
    "/mcp",
    "/tools",
    "/theme",
    "/view",
    "/animation",
    "/parallel",
  ]) {
    assert.equal(names.has(expected), true, `${expected} should be registered`);
  }
  assert.equal(
    commands.every((command) => typeof command.handler === "function"),
    true,
  );
  assert.equal(
    commands.every((command) => !("help" in command)),
    true,
  );
});

test("/route previews route policy, evidence gates, and assigned agent lanes", async () => {
  const commands = new Map(
    buildNativeChatSlashCommands().map((command) => [command.name, command]),
  );
  const route = commands.get("/route");
  assert.ok(route, "/route should be registered");

  const ctx = {
    input: {
      root: process.cwd(),
      runId: "slash-route-test",
      layout: "plain",
      mcpAllowlist: ["omk-project"],
      skillNames: ["omk-repo-explorer", "omk-security-review", "omk-quality-gate"],
      hookNames: ["protect-secrets.sh"],
      executionPrompt: "parallel",
    },
    state: {
      bootstrap: { provider: "codex", selectedRuntimeId: "codex-cli" },
      provider: "codex",
    },
    env: {},
  };

  const jsonResult = await route.handler(
    ctx,
    parseSlashArgs('"크리티컬 이슈좀 찾아줘" --json'),
  );
  assert.equal(jsonResult.ok, true);
  assert.equal(jsonResult.json.schema, "omk.slash.route-preview.v1");
  assert.equal(jsonResult.json.route.intent, "critical_issue_scan");
  assert.equal(jsonResult.json.route.mode, "read-only");
  assert.deepEqual(jsonResult.json.route.requiredEvidence.map((item) => item.kind), [
    "diff",
    "test",
    "diagnostic",
  ]);
  const securityLane = jsonResult.json.assignments.find(
    (assignment) => assignment.agent === "security_reviewer",
  );
  assert.ok(securityLane);
  assert.deepEqual(securityLane.skills, ["omk-security-review", "omk-secret-guard"]);
  assert.deepEqual(securityLane.mcpServers, ["omk-project"]);
  assert.deepEqual(securityLane.hooks, ["protect-secrets.sh"]);

  const textResult = await route.handler(
    ctx,
    parseSlashArgs('"크리티컬 이슈좀 찾아줘"'),
  );
  assert.equal(textResult.ok, true);
  assert.match(textResult.text, /Route Policy Preview/);
  assert.match(textResult.text, /Evidence Gates/);
  assert.match(textResult.text, /security_reviewer/);
});

test("slash UI commands patch theme view and animation session state", async () => {
  const commands = new Map(
    buildUiSlashCommands().map((command) => [command.name, command]),
  );
  const ctx = {
    input: { root: process.cwd(), runId: "slash-ui-test", layout: "plain" },
    state: {
      bootstrap: { provider: "codex", selectedRuntimeId: "codex-cli" },
      provider: "codex",
    },
    env: {},
  };

  const theme = await commands
    .get("/theme")
    .handler(ctx, parseSlashArgs("control"));
  assert.equal(theme.ok, true);
  assert.equal(theme.statePatch.theme, "neon-grid");
  assert.match(theme.text, /OMK\/\/CONTROL/);
  Object.assign(ctx.state, theme.statePatch);

  const view = await commands
    .get("/view")
    .handler(ctx, parseSlashArgs("toolplane"));
  assert.equal(view.ok, true);
  assert.equal(view.statePatch.view, "tool-plane");
  assert.equal(ctx.env.OMK_TUI_VIEW, "tool-plane");
  Object.assign(ctx.state, view.statePatch);

  const animation = await commands
    .get("/animation")
    .handler(ctx, parseSlashArgs("low"));
  assert.equal(animation.ok, true);
  assert.equal(animation.statePatch.animation, "low");
  assert.equal(ctx.env.OMK_ANIMATION, "low");
});

test("native root loop slash handler emits structured results without console hijack", () => {
  const source = readFileSync(
    new URL("../src/commands/chat/native-root-loop.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /console\.log\s*=|console\.warn\s*=|console\.error\s*=/,
  );
  assert.match(source, /emitSlashResult\(normalized, ctx\.renderer\)/);
  assert.match(source, /printSlashResult\(normalized\)/);
  assert.match(source, /buildNativeChatSlashCommands\(\)/);
});
