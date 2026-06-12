import test from "node:test";
import assert from "node:assert/strict";

const { createRuntimeSandboxProfile } = await import("../dist/runtime/sandbox-profile.js");

test("runtime sandbox profile defaults to env-only intent without OS enforcement claims", () => {
  const profile = createRuntimeSandboxProfile({ cwd: "/repo" });

  assert.deepEqual(profile, {
    mode: "read-only",
    enforcement: "env-only",
    cwd: "/repo",
    writableRoots: [],
    readableRoots: ["/repo"],
    network: "unspecified",
    secretEnvPolicy: "drop-by-default",
    notes: [
      "Child runtime env is sanitized.",
      "OS-level sandboxing is future work.",
    ],
  });
});

test("provider-native workspace-write profile records intent and provider boundary", () => {
  const profile = createRuntimeSandboxProfile({
    cwd: "/repo",
    mode: "workspace-write",
    enforcement: "provider-native",
  });

  assert.equal(profile.mode, "workspace-write");
  assert.equal(profile.enforcement, "provider-native");
  assert.deepEqual(profile.writableRoots, ["/repo"]);
  assert.deepEqual(profile.readableRoots, ["/repo"]);
  assert.equal(profile.network, "unspecified");
  assert.match(profile.notes.join(" "), /does not yet enforce OS-level/);
});

test("env-only workspace-write profile does not claim writable root enforcement", () => {
  const profile = createRuntimeSandboxProfile({
    cwd: "/repo",
    mode: "workspace-write",
    enforcement: "env-only",
  });

  assert.deepEqual(profile.writableRoots, []);
  assert.equal(profile.secretEnvPolicy, "drop-by-default");
  assert.match(profile.notes.join(" "), /future work/);
});
