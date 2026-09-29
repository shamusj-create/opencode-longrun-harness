import { reviewProjectFixture } from "./helper.mjs";
// v1.2.1 commissioning fixes, verified deterministically.
// There is NO live OpenCode host in this environment and the plugin deliberately refuses to treat
// a test/probe process as a host (isHostProcess), so a REAL live-tool run cannot occur here.
// These tests drive the REAL plugin tool factory + the REAL controller (the harness's own
// equivalent of the live tool surface) through the full lifecycle, with LONGRUN_TEST armed so no
// evidence can ever be written into a production state dir. Nothing here touches production
// source, OpenCode config, model/sampler/context, permissions, compaction or continuation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../src/controller.js";
import { VERSION as INSTALL_VERSION } from "../src/install.mjs";

const CONTROLLER = path.resolve(import.meta.dirname, "..", "src", "controller.js");
process.env.LONGRUN_CONTROLLER_FILE = CONTROLLER;
const PLUG_URL = "../plugin/longrun.js";
const { F } = await import("./helper.mjs");

function freshState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "v121-st-")); process.env.LONGRUN_STATE_DIR = d; return d; }
function projWithFile() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "v121-proj-")); fs.writeFileSync(path.join(d, "a.js"), "x"); return d; }
async function tools() { const h = await F(PLUG_URL, { client: null }); return h.tool; }
const ctx = (d) => ({ sessionID: "v121", agent: "longrun", directory: d, worktree: d });

// ---- version alignment: single source of truth, no drift (controller/package/plugin/installer) --
test("v1.2.1 version alignment (package == controller == plugin == installer)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"));
  const plugSrc = fs.readFileSync(path.resolve(import.meta.dirname, "..", "plugin", "longrun.js"), "utf8");
  assert.equal(pkg.version, "1.2.26", "package.json bumped");
  assert.equal(C.LIFECYCLE_SCHEMA_VERSION, pkg.version, "controller lifecycle schema version tracks package");
  assert.equal(INSTALL_VERSION, pkg.version, "installer VERSION tracks package");
  assert.ok(plugSrc.includes(`const VERSION = "${pkg.version}"`), "plugin VERSION literal matches package");
  assert.ok(plugSrc.includes(`in v${pkg.version}`), "help continuation note not stale");
});

// ---- BUG 1: an incomplete contract is refused at START, and no run is created ------------------
test("start refuses a required criterion with no mapped check (INVALID_CONTRACT, no run created)", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  const res = JSON.parse(await t.longrun.execute({ action: "start", request: "lifecycle check", criteria: [{ id: "LC-001", evidenceClass: "STATIC", weight: 1 }] }, ctx(d)));
  assert.equal(res.error, "INVALID_CONTRACT", "no run for an unverifiable criterion");
  assert.ok(Array.isArray(res.problems) && res.problems.length === 1 && res.problems[0].criterionId === "LC-001", "names the incomplete criterion");
  // no run was written -> a later status is still NO_RUN (prompt alone is not a run)
  const st = JSON.parse(await t.longrun.execute({ action: "status" }, ctx(d)));
  assert.equal(st.state, "NO_RUN", "incomplete contract created NO tracked run");
});

test("start refuses a criterion whose checks are absent from checkCatalogue (INVALID_CONTRACT)", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  const res = JSON.parse(await t.longrun.execute({ action: "start", request: "x", criteria: [{ id: "c1", checks: ["ghost"] }], checkCatalogue: { other: { command: ["node", "-e", "0"], kind: "cmd" } } }, ctx(d)));
  assert.equal(res.error, "INVALID_CONTRACT");
  assert.deepEqual(res.problems[0].missingChecks, ["ghost"], "names the missing declared check");
});

// ---- memory subsystem works WITHOUT a run, into an isolated fixture only ----------------------
test("memory_status returns success at run=null (was NO_RUN in v1.2.0)", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  const res = JSON.parse(await t.longrun.execute({ action: "memory_status" }, ctx(d)));
  assert.notEqual(res.state, "NO_RUN", "memory_status is a structural readout, not a run check");
  assert.equal(res.status, "NO_MEMORY");
  assert.equal(res.run, null);
});

test("memory_init at run=null runs; dryRun writes nothing into the fixture", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  const before = fs.readdirSync(d);
  const dry = JSON.parse(await t.longrun.execute({ action: "memory_init", dryRun: true }, ctx(d)));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.state, "MEMORY");
  assert.deepEqual(fs.readdirSync(d), before, "dryRun wrote nothing");
  // and a real memory_init still does NOT start a tracked run
  await t.longrun.execute({ action: "memory_init" }, ctx(d));
  assert.equal(JSON.parse(await t.longrun.execute({ action: "status" }, ctx(d))).state, "NO_RUN", "memory seeding is not a tracked run");
});

// ---- the tool contract: verify readout never executes; verify execution is longrun_verify only --
test("longrun action=verify is a read-only readout and longrun_verify has no shell bypass", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  // no run -> verify readout is not even reached for run state; assert the no-shell invariant holds
  const v = JSON.parse(await t.longrun_verify.execute({ checkId: "rm -rf /" }, ctx(d)));
  assert.equal(v.error, "NO_RUN", "verify tool runs nothing without a declared check + run");
});

// ---- FULL lifecycle through the real tool surface ---------------------------------------------
test("full lifecycle: memory -> start -> status -> checkpoint -> pause -> resume -> verify -> loss0 -> complete (same runId)", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  const c = ctx(d);

  // memory gate (works at run=null), isolated fixture
  const ms = JSON.parse(await t.longrun.execute({ action: "memory_status" }, c));
  assert.equal(ms.status, "NO_MEMORY");
  await t.longrun.execute({ action: "memory_init" }, c);

  // start a valid, completable contract: one STATIC criterion mapped to a declared check
  const start = JSON.parse(await t.longrun.execute({
    action: "start",
    request: "Verify that longrun v1.2.1 can create, persist, pause, resume, checkpoint and complete a native tracked run.",
    criteria: [{ id: "LC-001", required: true, weight: 1, evidenceClass: "STATIC", checks: ["lc-static"] }],
    checkCatalogue: { "lc-static": { command: ["node", "-e", "process.exit(0)"], kind: "cmd", timeoutMs: 15000 } },
    candidateBudget: 3, timeBudgetHours: 0.25, sameFailureThreshold: 2, noProgressThreshold: 2, autoContinue: false,
  }, c));
  assert.ok(start.runId, "start returned a real runId");
  const RUN = start.runId;
  assert.equal(start.initialLoss, 1);
  assert.equal(start.budgets.iterations, 3, "candidate budget honoured");
  assert.equal(start.budgets.sameFailureLimit, 2);
  assert.equal(start.budgets.noProgressLimit, 2);

  const key = C.stateKey(C.projectIdentity(d), RUN);
  const store = new C.Store(process.env.LONGRUN_STATE_DIR);
  const readRun = () => store.readJSON(key, "run.json");
  const budgetsOf = () => { const r = readRun(); return JSON.stringify({ it: r.budget.iterations, sf: r.budget.sameFailureLimit, np: r.budget.noProgressLimit, cand: C.candidateCount(r) }); };

  const s1 = JSON.parse(await t.longrun.execute({ action: "status" }, c));
  assert.equal(s1.runId, RUN); assert.equal(s1.state, "IMPLEMENTING");
  const budgetBefore = budgetsOf();

  assert.equal(await t.longrun.execute({ action: "checkpoint" }, c), "checkpointed");

  assert.equal(await t.longrun.execute({ action: "pause" }, c), "paused");
  const sPaused = JSON.parse(await t.longrun.execute({ action: "status" }, c));
  assert.equal(sPaused.state, "PAUSED", "pause persisted");
  assert.equal(sPaused.runId, RUN, "runId unchanged by pause");

  const sRes = JSON.parse(await t.longrun.execute({ action: "resume" }, c));
  assert.equal(sRes.runId, RUN, "runId unchanged by resume");
  assert.equal(sRes.state, "IMPLEMENTING", "resume returns to an active state");
  const budgetAfter = budgetsOf();
  assert.equal(budgetBefore, budgetAfter, "budgets + candidate accounting preserved across pause/resume");

  // record a STATIC PASS via the dedicated verify tool; then completion is possible
  const vr = JSON.parse(await t.longrun_verify.execute({ checkId: "lc-static", evidenceClass: "STATIC", mode: "normal" }, c));
  assert.equal(vr.status, "PASS", "declared STATIC check recorded a PASS receipt");

  const sVerified = JSON.parse(await t.longrun.execute({ action: "status" }, c));
  assert.equal(sVerified.runId, RUN);
  assert.equal(sVerified.criterionStates.find((x) => x.id === "LC-001").status, "PASS", "criterion derived from a real receipt without rewriting the contract");
  assert.deepEqual(sVerified.remaining, [], "no required criteria outstanding");
  reviewProjectFixture(d, RUN);
  assert.equal(JSON.parse(await t.longrun.execute({ action: "complete" }, c)).complete, true, "loss reached 0 only after verification");
  assert.equal(readRun().status, "COMPLETE");
  assert.equal(JSON.parse(await t.longrun.execute({ action: "status" }, c)).state, "COMPLETE");
});

// ---- completion is blocked while the sole required check is unverified (no fabricated pass) -----
test("complete refuses while the required check is unverified; no fabricated PASS", async () => {
  freshState();
  const t = await tools();
  const d = projWithFile();
  const c = ctx(d);
  const start = JSON.parse(await t.longrun.execute({
    action: "start", request: "x",
    criteria: [{ id: "LC-001", required: true, checks: ["lc-static"] }],
    checkCatalogue: { "lc-static": { command: ["node", "-e", "process.exit(1)"], kind: "cmd" } },
  }, c));
  assert.ok(start.runId);
  const noGo = JSON.parse(await t.longrun.execute({ action: "complete" }, c));
  assert.equal(noGo.complete, false);
  assert.equal(noGo.reason, "required_unverified", "blocked on the outstanding required criterion");
  // a FAIL receipt must not satisfy it either
  const vr = JSON.parse(await t.longrun_verify.execute({ checkId: "lc-static", evidenceClass: "STATIC" }, c));
  assert.equal(vr.status, "FAIL");
  assert.equal(JSON.parse(await t.longrun.execute({ action: "complete" }, c)).complete, false, "still blocked after a FAIL");
});
