import test from "node:test";
import assert from "node:assert/strict";

import { omkCliHero, panel, sanitizeTerminalText, stripBrokenAnsi } from "../dist/util/theme.js";
import { OMK_SIMPLE_ASCII_ART } from "../dist/kimi/simple-art.js";

test("OMK CLI hero uses the compact mascot theme", () => {
  const hero = omkCliHero();

  assert.match(hero, /OMK/);
  assert.match(hero, /Open Multi-agent Kit/);
  assert.match(hero, /Provider-neutral runtime for AI coding teams/);

  const artLines = OMK_SIMPLE_ASCII_ART.split("\n");

  assert.equal(artLines.length <= 5, true);
  assert.equal(artLines.every((line) => line.length <= 64), true);
  assert.match(OMK_SIMPLE_ASCII_ART, /\/_\|_______\|_\\/);
  assert.doesNotMatch(OMK_SIMPLE_ASCII_ART, /kimi❯/);
});

test("terminal text sanitizer strips control sequences from display values", () => {
  const unsafe = "safe\x1b]52;c;copied\x07\x1b[31mred\x00";

  assert.equal(sanitizeTerminalText(unsafe), "safered");
});

test("terminal text sanitizer strips broken ANSI fragments", () => {
  const unsafe = "safe[38;2;0;50;0mred[0m[38;2;0;69;4mgreen";

  assert.equal(stripBrokenAnsi(unsafe), "saferedgreen");
  assert.equal(sanitizeTerminalText(unsafe), "saferedgreen");
});

test("sanitizeTerminalText strips standalone ::code-comment directives", () => {
  const raw = "line1\n::code-comment{some note}\nline2\n::code-comment{another}\t \nline3";

  assert.equal(sanitizeTerminalText(raw), "line1\nline2\nline3");
});

test("panel sanitizes title before gradient rendering and width math", () => {
  const output = panel(["  body"], "S[38;2;0;50;0mIGNAL[0m");

  assert.match(output, /SIGNAL/);
  assert.doesNotMatch(output, /(?<!\x1b)\[(?:38|48);2;|(?<!\x1b)\[0m/);
});
