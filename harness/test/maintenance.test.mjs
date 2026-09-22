import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { install, VERSION } from "../src/install.mjs";
import * as C from "../src/controller.js";

// resolve the maintenance entry point from the ACTUAL installed current pointer, so this test
// never hard-codes a version string (avoids stale-path failures across releases).
function maintBin(cfgRoot) {
  const cfg = path.join(cfgRoot, "opencode");
  const ver = fs.readFileSync(path.join(cfg, "longrun-harness", "current"), "utf8").trim();
  return { cfg, bin: path.join(cfg, "longrun-harness", "releases", ver, "bin", "longrun.mjs") };
}
function seedConfig(base) {
  const cfg = path.join(base, "config");
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "plugins", "mtplx-session-headers.js"), "// existing plugin\nexport default async()=>({});\n");
  fs.writeFileSync(path.join(cfg, "opencode.json"), JSON.stringify({ model: "mtplx/x", plugin: ["/abs/mtplx-session-headers.js"], provider: { mtplx: { options: { baseURL: "http://127.0.0.1:8000/v1" } } } }));
  return cfg;
}

test("installed status drains large JSON through a pipe before exiting", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "status-pipe-"));
  const cfg = seedConfig(base), project = path.join(base, "project"), state = path.join(base, "state");
  fs.mkdirSync(project); install({ configDir: cfg });
  const criterionId = "large-required-criterion-" + "x".repeat(256 * 1024);
  const run = { runId: "large", status: "PAUSED", state: {}, receipts: [],
    contract: { criteria: [{ id: criterionId, required: true, checks: ["missing"] }], gates: [], lossTarget: 0 } };
  new C.Store(state).writeJSON(C.stateKey(C.projectIdentity(project), run.runId), "run.json", run);
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "status", "--project", project, "--run", run.runId, "--json"], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: state, LONGRUN_TEST: "1" },
    maxBuffer: 8 * 1024 * 1024, timeout: 10000,
  });
  assert.equal(r.status, 0, String(r.stderr));
  const result = JSON.parse(r.stdout);
  assert.equal(result.criterionStates[0].id, criterionId);
  assert.equal(result.currentLoss, 1);
  assert.equal(result.completionBlocked, true);
});

// 1 + 2: dry-run writes nothing; install preserves unrelated config + no competing config.
test("install: dry-run is inert", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m0-")));
  const r = install({ configDir: cfg, dryRun: true });
  assert.ok(r.actions.every((a) => a.action === "would_create"));
  assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false, "dry-run must not create the plugin");
});

// maintenance entry point runs from ANY cwd and resolves copied libs (no source repo needed).
test("maintenance doctor runs from an unrelated cwd and resolves copied libs (source-independent)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m1-")));
  install({ configDir: cfg });
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  assert.ok(fs.existsSync(bin), "maintenance entry point installed");
  const r = spawnSync(process.execPath, [bin, "doctor", "--json"], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "cwd-")), env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "st-")) } });
  assert.equal(r.status, 0, "doctor install-mode exit 0:\n" + r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.mode, "install"); assert.equal(j.ok, true);
});

// independence: run maintenance from a COPY of the install that has NO source tree.
test("maintenance works in a copied, standalone install (source repo unavailable)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m2-")));
  install({ configDir: cfg });
  const standalone = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-"));
  const cfgCopy = path.join(standalone, "opencode");
  fs.cpSync(cfg, cfgCopy, { recursive: true });
  const bin = path.join(cfgCopy, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "doctor", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfgCopy, LONGRUN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "st2-")) } });
  assert.equal(r.status, 0, "standalone doctor ok:\n" + r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

// 1: LIVE-READINESS must NOT report success while awaiting restart (no observed load).
test("doctor --live refuses success when no runtime load record exists (awaiting restart)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m3-")));
  install({ configDir: cfg });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "state-empty-"));
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "doctor", "--live", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: state } });
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, "AWAITING_RESTART", "no load record -> not verified");
  assert.equal(j.ok, false, "live mode must not claim success while unverified");
  assert.equal(r.status, 2, "exit code non-zero so automation can gate");
});

// 1: a GENUINE host-shaped load record (nonce + toolsBuilt + live pid + fresh + hook activity)
// is required; the stand-in live pid is a spawned sleeper, not a probe artifact.
test("doctor --live detects a current genuine load (host-shaped record)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m4-")));
  install({ configDir: cfg });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "state-hot-"));
  fs.mkdirSync(path.join(state, "load"), { recursive: true });
  const sleeper = spawn("node", ["-e", "setTimeout(()=>{},120000)"]); // stand-in for a live backend pid
  try {
    fs.writeFileSync(path.join(state, "load", "host-genuine.json"), JSON.stringify({
      at: Date.now(), nonce: "live-nonce-1", toolsBuilt: true, test: false, hookActivity: 3,
      pid: sleeper.pid, runtime: process.version, exec: "/Applications/OpenCode.app/Contents/Frameworks/OpenCode Helper.app/Contents/MacOS/OpenCode Helper", client: "desktop", project: "someProject",
    }));
    const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
    const r = spawnSync(process.execPath, [bin, "doctor", "--live", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: state } });
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "LIVE_DETECTED", "genuine record must be observed:\n" + r.stdout + r.stderr);
    assert.equal(j.live, "OBSERVED"); assert.equal(j.ok, true);
  } finally { sleeper.kill(); }
});

// 4 + 5: probe-shaped, hook-only, dead-pid, stale and test-flagged records NEVER satisfy --live.
test("doctor --live rejects probe-shaped, hook-only, dead-pid, stale and test records", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m4b-")));
  install({ configDir: cfg });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "state-bad-"));
  const load = path.join(state, "load"); fs.mkdirSync(load, { recursive: true });
  const bad = {
    "probe-shape.json": { at: Date.now(), hookActivity: 5, loads: 1, runtime: "v24", project: "x" }, // old probe style
    "hook-only.json": { hookActivity: 14530, at: Date.now() }, // hook record with NO load nonce
    "dead-pid.json": { at: Date.now(), nonce: "n1", toolsBuilt: true, hookActivity: 2, pid: 99999999 },
    "stale.json": { at: Date.now() - 20 * 60 * 1000, nonce: "n2", toolsBuilt: true, hookActivity: 2, pid: process.pid },
    "test-flag.json": { at: Date.now(), nonce: "n3", toolsBuilt: true, hookActivity: 2, test: true, pid: process.pid },
    // even a COMPLETE host-shaped record written by a probe (checker's own runtime, runner pid) is rejected
    "probe-live.json": { at: Date.now(), nonce: "n4", toolsBuilt: true, test: false, hookActivity: 2, pid: process.pid, runtime: process.version, exec: process.execPath, client: "desktop" },
  };
  for (const [k, v] of Object.entries(bad)) fs.writeFileSync(path.join(load, k), JSON.stringify(v));
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "doctor", "--live", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: state } });
  assert.equal(r.status, 2, "must exit non-zero (not verified)");
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false); assert.equal(j.live, "NOT_VERIFIED");
  assert.equal(j.status, "STALE_LOAD_RECORD");
  assert.equal(j.liveEvidence.loadRecords, 6);
  assert.equal(j.liveEvidence.rejectedUntrusted.length, 6, "every probe-shaped record rejected:\n" + r.stdout);
  for (const x of j.liveEvidence.rejectedUntrusted) assert.ok(x.why, "rejection carries a reason: " + JSON.stringify(x));
});

// 2: uninstall via installed entry point is reversible + preserves unrelated config.
test("installed maintenance uninstall removes only owned files, preserves provider + foreign", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m5-")));
  fs.mkdirSync(path.join(cfg, "skills", "longrun-ui"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "skills", "longrun-ui", "SKILL.md"), "foreign\n");
  install({ configDir: cfg });
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "uninstall", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg } });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false, "plugin removed");
  assert.equal(fs.existsSync(path.join(cfg, "longrun-harness")), false, "release tree removed");
  assert.ok(fs.existsSync(path.join(cfg, "plugins", "mtplx-session-headers.js")), "unrelated plugin preserved");
  assert.ok(fs.existsSync(path.join(cfg, "skills", "longrun-ui", "SKILL.md")), "foreign skill preserved");
});

// 2: emergency disable via installed entry point removes the loadable plugin.
test("installed maintenance disable removes the loadable plugin (emergency)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m6-")));
  install({ configDir: cfg });
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "disable", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg } });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false);
});

// v1.2.0 §16: the STRUCTURAL doctor must surface the new subsystems, and the copied libs must
// load source-independently (controller importing memory/evidence from the release lib dir).
test("structural doctor reports the v1.2.0 subsystems (lifecycle/memory/evidence/continuation)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m7-")));
  install({ configDir: cfg });
  // memory/evidence copied beside the controller
  assert.ok(fs.existsSync(path.join(cfg, "longrun-harness", "releases", VERSION, "lib", "memory.mjs")));
  assert.ok(fs.existsSync(path.join(cfg, "longrun-harness", "releases", VERSION, "lib", "evidence.mjs")));
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "doctor", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "st7-")) } });
  assert.equal(r.status, 0, "structural doctor ok:\n" + r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.pluginShape, "v1-server-plugin", "plugin shape detected (single server-plugin export)");
  assert.equal(j.runLifecycleSchema.version, VERSION, "doctor lifecycle schema version == installer VERSION");
  assert.ok(j.runLifecycleSchema.actions.includes("start") && j.runLifecycleSchema.actions.includes("memory_init"), "full action schema surfaced");
  assert.ok(j.runLifecycleSchema.actions.every((a) => !a.includes("...")), "no ellipsis in the documented action schema");
  assert.equal(j.memorySubsystem.present, true, "hierarchical-memory subsystem present");
  assert.equal(j.memorySubsystem.maxDepth, 3);
  assert.equal(j.evidenceSchema.verifyRejectsWeakerClass, true);
  assert.equal(j.continuationDefault, "OFF", "automatic continuation remains disabled by default");
  assert.equal(j.compactionIntegration.realCompactionVerified, false, "never claim real compaction is verified");
});

// v1.2.3: the STRUCTURAL doctor must actively self-test the authoritative receipt model — a single
// resolver, copied/fixture sabotage cannot invalidate a project check, and a hard gate is recomputed
// from evidence (so a passing build can complete) — rather than only checking that files exist.
test("doctor self-tests the v1.2.3 receipt model (single resolver + gate recomputation)", () => {
  const cfg = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "m8-")));
  install({ configDir: cfg });
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "doctor", "--json"], { cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "st8-")) } });
  assert.equal(r.status, 0, "receipt-model doctor ok:\n" + r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true, "healthy install still reports ok");
  assert.ok(j.receiptModel, "receipt model section present");
  assert.equal(j.receiptModel.singleSource, true, "one effective-receipt definition, no duplicate resolver");
  assert.equal(j.receiptModel.singleResolver, true);
  assert.equal(j.receiptModel.copySabotageIgnored, true, "a copied/fixture result cannot turn a project check red");
  assert.equal(j.receiptModel.gateRecomputedToComplete, true, "a passing build lets the gate complete");
  assert.equal(j.receiptModel.failMasksOldPass, true, "a newer failure is not hidden behind an older pass");
});
