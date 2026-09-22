import { reviewProjectFixture } from "./helper.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../src/controller.js";

const CONTROLLER = path.resolve(import.meta.dirname, "..", "src", "controller.js");
process.env.LONGRUN_CONTROLLER_FILE = CONTROLLER;
const PLUG_URL = "../plugin/longrun.js";
const { F, readRuns, writeRuns } = await import("./helper.mjs");

function freshState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "lrstate-")); process.env.LONGRUN_STATE_DIR = d; return d; }
function proj(name = "proj") { const d = fs.mkdtempSync(path.join(os.tmpdir(), name + "-")); fs.writeFileSync(path.join(d, "a.js"), "x"); return d; }

async function hooks() { freshState(); return (await F(PLUG_URL, { client: null })); }

const START_ARGS = { action: "start", request: "do the thing", criteria: [{ id: "c1", required: true, checks: ["t"] }], hardGates: ["build"], checkCatalogue: { t: { command: ["node", "-e", "process.exit(0)"], kind: "test" } } };

// ---- help enumerates EXACT actions (no ellipsis) -------------------------------------------
test("help enumerates the exact action set + schema", async () => {
  const h = await hooks();
  const r = JSON.parse(await h.tool.longrun.execute({ action: "help" }, { sessionID: "s", directory: proj(), worktree: proj() }));
  assert.deepEqual(r.actions, ["help", "start", "status", "receipts", "next", "checkpoint", "verify", "pause", "resume", "cancel", "complete", "reconcile", "memory_init", "memory_refresh", "memory_status", "resume-context"]);
  assert.ok(r.actions.every((a) => !a.includes("...")), "no ellipsis in action list");
  assert.equal(r.harnessVersion, C.LIFECYCLE_SCHEMA_VERSION, "help reports the harness lifecycle version");
  assert.equal(r.continuation.enabled, false, "continuation default OFF");
  assert.ok(r.memoryStatus, "memory status reported");
});

// ---- invalid action returns the schema, never encourages guessing --------------------------
test("an invalid action returns the supported-action schema (no guessing)", async () => {
  const h = await hooks();
  const r = JSON.parse(await h.tool.longrun.execute({ action: "doom" }, { sessionID: "s", directory: proj(), worktree: proj() }));
  assert.equal(r.error, "unknown_action");
  assert.ok(Array.isArray(r.actions) && r.actions.includes("start"), "reply carries the exact actions");
  assert.ok(r.params, "reply carries params");
});

// ---- start creates a REAL run (authoritative run.json) ------------------------------------
test("start creates a real run and status returns the same run", async () => {
  const h = await hooks();
  const dir = proj();
  const start = JSON.parse(await h.tool.longrun.execute({ ...START_ARGS, action: "start" }, { sessionID: "sess-A", directory: dir, worktree: dir }));
  assert.ok(start.runId, "start returned a runId");
  assert.equal(start.initialLoss, 1, "initial loss full (nothing verified)");
  // the run actually exists in the store
  const key = C.stateKey(C.projectIdentity(dir), start.runId);
  const store = new C.Store(process.env.LONGRUN_STATE_DIR);
  assert.ok(store.readJSON(key, "run.json"), "authoritative run.json written");
  const status = JSON.parse(await h.tool.longrun.execute({ action: "status" }, { sessionID: "sess-A", directory: dir, worktree: dir }));
  assert.equal(status.state, "IMPLEMENTING");
  assert.equal(status.runId, start.runId, "status resolves the same run");
});

// ---- status/next cannot report tracked mode without a real run -----------------------------
test("a prompt alone is NOT a tracked run (status reports NO_RUN)", async () => {
  const h = await hooks();
  const dir = proj();
  const r = JSON.parse(await h.tool.longrun.execute({ action: "status" }, { sessionID: "sess-X", directory: dir, worktree: dir }));
  assert.equal(r.state, "NO_RUN");
});

// ---- resume survives a simulated session boundary (new conversation) -----------------------
test("resume attaches to the known run across a new session (candidate state persists)", async () => {
  const h = await hooks();
  const dir = proj();
  const start = JSON.parse(await h.tool.longrun.execute({ ...START_ARGS, action: "start" }, { sessionID: "sess-A", directory: dir, worktree: dir }));
  // simulate a session boundary: a brand-new sessionID, same project directory
  const status = JSON.parse(await h.tool.longrun.execute({ action: "status" }, { sessionID: "sess-B-brand-new", directory: dir, worktree: dir }));
  assert.notEqual(status.state, "NO_RUN", "new session re-attaches to the existing project run");
  assert.equal(status.runId, start.runId);
});

// ---- completion closes only when all required pass + loss met ------------------------------
test("complete only closes when every required criterion/gate passes; else refuses", async () => {
  const h = await hooks();
  const dir = proj();
  const start = JSON.parse(await h.tool.longrun.execute({ ...START_ARGS, action: "start" }, { sessionID: "sess-A", directory: dir, worktree: dir }));
  // incomplete: gate still FAIL -> cannot complete
  const noGo = JSON.parse(await h.tool.longrun.execute({ action: "complete" }, { sessionID: "sess-A", directory: dir, worktree: dir }));
  assert.equal(noGo.complete, false);
  assert.ok(noGo.reason, "reason given");
  // Cached PASS flags alone cannot complete a tracked run in v1.2.4.
  const key = C.stateKey(C.projectIdentity(dir), start.runId);
  const store = new C.Store(process.env.LONGRUN_STATE_DIR);
  const run = store.readJSON(key, "run.json");
  for (const c of run.contract.criteria) c.status = "PASS";
  for (const g of run.contract.gates) g.status = "PASS";
  store.writeJSON(key, "run.json", run);
  assert.equal(JSON.parse(await h.tool.longrun.execute({ action: "complete" }, { sessionID: "sess-A", directory: dir })).complete, false);
  // Exercise the real declared verifier for both the criterion and the gate.
  run.checkCatalogue = Object.fromEntries(["t", "build"].map(id => [id, { kind: "cmd", command: ["node", "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('a.js','utf8'), 'x')"] }]));
  store.writeJSON(key, "run.json", run);
  const bindings = readRuns(); bindings["sess-A"].checkCatalogue = run.checkCatalogue; writeRuns(bindings);
  for (const checkId of ["t", "build"]) assert.equal(JSON.parse(await h.tool.longrun_verify.execute({ checkId, runId: start.runId }, { sessionID: "sess-A", directory: dir })).status, "PASS");
  reviewProjectFixture(dir, start.runId);
  const done = JSON.parse(await h.tool.longrun.execute({ action: "complete" }, { sessionID: "sess-A", directory: dir, worktree: dir }));
  assert.equal(done.complete, true);
  assert.equal(store.readJSON(key, "run.json").status, "COMPLETE");
});
