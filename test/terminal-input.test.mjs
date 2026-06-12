import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  captureTerminalInputState,
  enableRawTerminalInput,
  restoreTerminalInputState,
} from "../dist/util/terminal-input.js";

const { TerminalOwner } = await import("../dist/util/terminal-owner.js");

class FakeInput extends EventEmitter {
  constructor({ isTTY = true, isRaw = false, readableFlowing = null } = {}) {
    super();
    this.isTTY = isTTY;
    this.isRaw = isRaw;
    this.readableFlowing = readableFlowing;
    this.rawCalls = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }

  setRawMode(mode) {
    this.rawCalls.push(mode);
    this.isRaw = mode;
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    this.readableFlowing = true;
    return this;
  }

  pause() {
    this.pauseCalls += 1;
    this.readableFlowing = false;
    return this;
  }
}

test("enableRawTerminalInput captures and restores raw mode ownership", () => {
  const input = new FakeInput({ isTTY: true, isRaw: false, readableFlowing: null });
  const state = enableRawTerminalInput(input);

  assert.deepEqual(state, { wasTTY: true, rawMode: false, readableFlowing: null, dataListenerCount: 0 });
  assert.deepEqual(input.rawCalls, [true]);
  assert.equal(input.resumeCalls, 1);

  restoreTerminalInputState(input, state);

  assert.deepEqual(input.rawCalls, [true, false]);
  assert.equal(input.pauseCalls, 1);
});

test("restoreTerminalInputState does not pause or reset raw mode owned by another listener", () => {
  const input = new FakeInput({ isTTY: true, isRaw: false, readableFlowing: null });
  const state = enableRawTerminalInput(input);
  input.on("data", () => undefined);

  restoreTerminalInputState(input, state);

  assert.deepEqual(input.rawCalls, [true]);
  assert.equal(input.pauseCalls, 0);
});

test("restoreTerminalInputState preserves originally flowing input", () => {
  const input = new FakeInput({ isTTY: true, isRaw: true, readableFlowing: true });
  const state = captureTerminalInputState(input);

  restoreTerminalInputState(input, state);

  assert.deepEqual(input.rawCalls, [true]);
  assert.equal(input.pauseCalls, 0);
});

test("enableRawTerminalInput skips raw mode for non-TTY input", () => {
  const input = new FakeInput({ isTTY: false, isRaw: false, readableFlowing: null });
  const state = enableRawTerminalInput(input);

  assert.deepEqual(state, { wasTTY: false, rawMode: undefined, readableFlowing: null, dataListenerCount: 0 });
  assert.deepEqual(input.rawCalls, []);
  assert.equal(input.resumeCalls, 1);
});

test("TerminalOwner pauses readline while a child process owns the terminal", async () => {
  const input = new FakeInput({ isTTY: true, isRaw: false, readableFlowing: true });
  const readline = {
    pauseCalls: 0,
    resumeCalls: 0,
    pause() {
      this.pauseCalls += 1;
    },
    resume() {
      this.resumeCalls += 1;
    },
  };
  const owner = new TerminalOwner(input);
  const releaseReadline = owner.claimReadline();

  await owner.withChildProcess(readline, async () => {
    assert.equal(owner.state, "child");
    assert.equal(readline.pauseCalls, 1);
    assert.equal(input.pauseCalls, 1);
  });

  assert.equal(owner.state, "readline");
  assert.equal(readline.resumeCalls, 1);
  assert.equal(input.resumeCalls, 1);
  releaseReadline();
  assert.equal(owner.state, "idle");
});
