import test from "node:test";
import assert from "node:assert/strict";

test("HUD renders Neon Grid control copy without broken ANSI or emoji branding", async () => {
  const previousNoColor = process.env.NO_COLOR;
  const previousForceColor = process.env.FORCE_COLOR;
  try {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    const { renderHudDashboard } = await import("../dist/hud/render.js");
    const output = await renderHudDashboard({
      compact: true,
      fetchQuota: false,
      terminalWidth: 92,
      showDisk: false,
      showHeap: false,
      showUptime: false,
    });

    assert.match(output, /OMK\/\/HUD/);
    assert.match(output, /NEON GRID ONLINE/);
    assert.match(output, /Route agents\. Verify evidence\. Control the loop\./);
    assert.match(output, /RUNTIME/);
    assert.match(output, /LATEST RUN/);
    assert.doesNotMatch(output, /GREEN\s+RAIN\s+MODE|THE\s+MATRIX/i);
    assert.doesNotMatch(output, /\[(?:38|48);2;|\[0m/);
    assert.doesNotMatch(output, /🤖|⚡|📜|🌿|📁|📝|🎨|💬/u);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor;
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previousForceColor;
  }
});
