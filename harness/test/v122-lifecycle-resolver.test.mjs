import { reviewProjectFixture } from "./helper.mjs";
// v1.2.2 commissioning regression: the canonical run resolver + verify contract + resume rebind +
// cancel, driven through the REAL plugin tool factory + the REAL controller (LONGRUN_TEST armed so
// nothing can ever be written into a production state dir; nothing here touches production source,
// OpenCode config, model/sampler/context, permissions, compaction or continuation).
//
// It specifically reproduces the LIVE v1.2.1 failure: status/resume could see an IMPLEMENTING run
// but longrun_verify returned a generic `no_active_run`. The verifier must now resolve the SAME
// authoritative run as the control plane, and lifecycle verification must not inflate candidates.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../src/controller.js";

process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, "..", "src", "controller.js");
const PLUG_URL = "../plugin/longrun.js";
const { F } = await import("./helper.mjs");

function state(d) { process.env.LONGRUN_STATE_DIR = d; return d; }
function freshState() { return state(fs.mkdtempSync(path.join(os.tmpdir(), "lr122-st-"))); }
function proj(file = "x") { const d = fs.mkdtempSync(path.join(os.tmpdir(), "lr122-proj-")); fs.writeFileSync(path.join(path.join(d, "a.js")), file); return d; }
function keyFor(dir, runId) { return C.stateKey(C.projectIdentity(dir), runId); }
function store() { return new C.Store(process.env.LONGRUN_STATE_DIR); }
function ctx(sessionID, dir) { return { sessionID, agent: "longrun", directory: dir, worktree: dir }; }
async function tools() { const h = await F(PLUG_URL, { client: null }); return h.tool; } // fresh factory + state

const STATIC_CAT = { "c1": { command: ["node", "-e", "process.exit(0)"], kind: "cmd", timeoutMs: 15000 } };
function seededRun(dir, runId, status, extra = {}) {
  const s = store();
  const run = C.startRun({
    request: "commissioning lifecycle",
    contract: { criteria: [{ id: "LC-001", required: true, weight: 1, checks: ["c1"], evidenceClass: "STATIC", status: "FAIL" }], gates: [], lossTarget: 0 },
    budgets: { iterations: 3, activeSeconds: 900, deadlineSeconds: 28800, sameFailureLimit: 2, noProgressLimit: 2, autoDispatchCap: 6, toolActionCap: 200 },
    sourceFingerprint: C.sourceFingerprint(dir).hash,
    continuation: false, directory: dir, checkCatalogue: STATIC_CAT,
  }).run;
  run.runId = runId; run.status = status;
  s.writeJSON(keyFor(dir, runId), "run.json", run);
  // register the run on the canonical project identity so a NEW conversation can resolve it
  const pk = (() => { const id = C.projectIdentity(dir); return C.stateKey(id, "proj-marker").slice(0, 24); })();
  const projPath = path.join(process.env.LONGRUN_STATE_DIR, "projects.json");
  let proj = {}; try { proj = JSON.parse(fs.readFileSync(projPath, "utf8")); } catch {}
  const ck = require_keyOf(id_key(dir));
  const p = proj[ck] || { runs: [] }; if (!p.runs.includes(keyFor(dir, runId))) p.runs.push(keyFor(dir, runId)); proj[ck] = p;
  fs.writeFileSync(projPath, JSON.stringify(proj));
  return { run, key: keyFor(dir, runId) };
}
// projectKey used by the plugin: sha256(identity.id) sliced to 24 (mirrors plugin keyOf)
function id_key(dir) { return C.projectIdentity(dir).id; }
import crypto from "node:crypto";
function require_keyOf(v) { return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 24); }

// ---- A. same-session flow with an EXPLICIT runId ----
test("A: start -> status -> verify(explicit runId) -> loss 0 -> complete (same session)", async () => {
  freshState(); const t = await tools(); const d = proj();
  const c = ctx("sessA", d);
  const start = JSON.parse(await t.longrun.execute({ action: "start", request: "r", criteria: [{ id: "LC-001", required: true, evidenceClass: "STATIC", checks: ["c1"] }], checkCatalogue: STATIC_CAT }, c));
  assert.ok(start.runId, "start returned a runId");
  const RUN = start.runId;
  assert.equal(JSON.parse(await t.longrun.execute({ action: "status", runId: RUN }, c)).state, "IMPLEMENTING");
  const v = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, c));
  assert.equal(v.status, "PASS", "explicit runId resolves the active run and records a real PASS");
  assert.equal(v.candidateCount, 0, "lifecycle verify on unchanged source creates NO candidate");
  const s = JSON.parse(await t.longrun.execute({ action: "status", runId: RUN }, c));
  assert.deepEqual(s.remaining, [], "criterion satisfied by the receipt");
  assert.equal(s.candidates.split("/")[0], "0", "candidate count still 0 (never inflated by verify)");
  reviewProjectFixture(d, RUN);
  assert.equal(JSON.parse(await t.longrun.execute({ action: "complete", runId: RUN }, c)).complete, true);
});

// ---- B. pause/resume: verify is RUN_PAUSED while paused, succeeds after resume ----
test("B: pause -> verify=RUN_PAUSED -> resume -> verify(runId) succeeds -> loss 0 -> complete", async () => {
  freshState(); const t = await tools(); const d = proj();
  const c = ctx("sessB", d);
  const RUN = "lr-paused01";
  seededRun(d, RUN, "PAUSED");
  // bound to this session for the auto-resolution path
  fs.writeFileSync(path.join(process.env.LONGRUN_STATE_DIR, "runs.json"), JSON.stringify({ sessB: { runKey: keyFor(d, RUN), directory: d, checkCatalogue: STATIC_CAT } }));
  const paused = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, c));
  assert.equal(paused.error, "RUN_PAUSED", "a paused run is resolvable but not eligible for verification");
  const rs = JSON.parse(await t.longrun.execute({ action: "resume", runId: RUN }, c));
  assert.equal(rs.resumed, true); assert.equal(rs.state, "IMPLEMENTING");
  const v = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, c));
  assert.equal(v.status, "PASS", "after resume the same run verifies normally");
  reviewProjectFixture(d, RUN);
  assert.equal(JSON.parse(await t.longrun.execute({ action: "complete", runId: RUN }, c)).complete, true);
});

// ---- C. cross-session: session A primes the run; a NEW session (no binding) resumes + verifies ----
test("C: session A -> new session B resumes by runId + verifies (run/budgets persist)", async () => {
  freshState();
  // Session A
  const tA = await tools(); const d = proj(); const A = ctx("sessA", d);
  const start = JSON.parse(await tA.longrun.execute({ action: "start", request: "r", criteria: [{ id: "LC-001", required: true, evidenceClass: "STATIC", checks: ["c1"] }], checkCatalogue: STATIC_CAT }, A));
  const RUN = start.runId;
  await tA.longrun.execute({ action: "checkpoint", runId: RUN }, A);
  assert.equal(await tA.longrun.execute({ action: "pause", runId: RUN }, A), "paused");
  // Session B: brand-new sessionID, same project/worktree, NO session binding seeded
  const tB = await tools(); const B = ctx("sessB-brand-new", d);
  const sBefore = JSON.parse(await tB.longrun.execute({ action: "status", runId: RUN }, B));
  assert.equal(sBefore.state, "PAUSED", "a new conversation re-attaches to the same run via project identity");
  assert.equal(sBefore.runId, RUN, "same run ID across the session boundary");
  const rs = JSON.parse(await tB.longrun.execute({ action: "resume", runId: RUN }, B));
  assert.equal(rs.rebound, true, "resume re-binds the current session + worktree");
  const v = JSON.parse(await tB.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, B));
  assert.equal(v.status, "PASS", "the new conversation can verify the same authoritative run");
  const sDone = JSON.parse(await tB.longrun.execute({ action: "status", runId: RUN }, B));
  assert.equal(sDone.candidates.split("/")[0], "0", "candidate count unchanged across the boundary");
  reviewProjectFixture(d, RUN);
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "complete", runId: RUN }, B)).complete, true);
});

// ---- D. explicit-ID isolation: verify(runId=A) verifies ONLY A; no cross-project contamination ----
test("D: explicit runId verifies only the named run; a foreign-project runId is NO_RUN", async () => {
  freshState(); const t = await tools();
  const p1 = proj(), p2 = proj();
  const A = "lr-runA", B = "lr-runB";
  seededRun(p1, A, "IMPLEMENTING");
  seededRun(p2, B, "IMPLEMENTING");
  // from project P2, runId A is NOT resolvable here -> NO_RUN (never cross-project)
  const foreign = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: A }, ctx("s", p2)));
  assert.equal(foreign.error, "NO_RUN", "an explicit id outside this project does NOT resolve here");
  // verify B only; A's record must be byte-unchanged (no cross-run contamination)
  const beforeA = JSON.stringify(store().readJSON(keyFor(p1, A), "run.json"));
  const vB = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: B }, ctx("s", p2)));
  assert.equal(vB.status, "PASS", "the named run verifies");
  assert.equal(vB.runId, B);
  assert.equal(JSON.stringify(store().readJSON(keyFor(p1, A), "run.json")), beforeA, "run A was not touched");
});

// ---- E. ambiguity: no runId + multiple eligible runs -> AMBIGUOUS_RUN, never a guess ----
test("E: omitted runId with multiple eligible runs returns AMBIGUOUS_RUN; explicit id resolves one", async () => {
  freshState(); const t = await tools(); const d = proj();
  const A = "lr-dup1", B = "lr-dup2";
  seededRun(d, A, "IMPLEMENTING");
  seededRun(d, B, "IMPLEMENTING");
  const amb = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC" }, ctx("s", d)));
  assert.equal(amb.error, "AMBIGUOUS_RUN", "never guesses between multiple runs");
  assert.deepEqual(amb.ids.sort(), [A, B].sort());
  const one = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: A }, ctx("s", d)));
  assert.equal(one.status, "PASS", "explicit runId disambiguates and verifies exactly one");
});

// ---- F. cancel lifecycle: terminal CANCELLED, verify rejected, continuation impossible, new start allowed + different id ----
test("F: start -> pause -> cancel -> status CANCELLED -> verify rejected -> new start gets a different id", async () => {
  freshState(); const t = await tools(); const d = proj(); const c = ctx("sessF", d);
  const start = JSON.parse(await t.longrun.execute({ action: "start", request: "r", criteria: [{ id: "LC-001", required: true, evidenceClass: "STATIC", checks: ["c1"] }], checkCatalogue: STATIC_CAT }, c));
  const RUN = start.runId;
  assert.equal(await t.longrun.execute({ action: "pause", runId: RUN }, c), "paused");
  const cancel = JSON.parse(await t.longrun.execute({ action: "cancel", runId: RUN, reason: "abandoned" }, c));
  assert.equal(cancel.cancelled, true); assert.equal(cancel.state, "CANCELLED");
  const st = JSON.parse(await t.longrun.execute({ action: "status", runId: RUN }, c));
  assert.equal(st.state, "CANCELLED", "status reports the terminal CANCELLED state (not deleted, not COMPLETE)");
  const v = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, c));
  assert.equal(v.error, "RUN_CANCELLED", "a cancelled run rejects further verification");
  // continuation impossible: autocontinue hook suppresses on a cancelled/disabled run
  const hooks = await F(PLUG_URL, { client: {} });
  const out = { enabled: true };
  await hooks["experimental.compaction.autocontinue"]({ sessionID: "sessF" }, out);
  assert.equal(out.enabled, false, "a cancelled run cannot be auto-revived");
  // a NEW run is allowed for the same project and receives a DIFFERENT run id
  const again = JSON.parse(await t.longrun.execute({ action: "start", request: "r2", criteria: [{ id: "LC-002", required: true, evidenceClass: "STATIC", checks: ["c2"] }], checkCatalogue: { c2: STATIC_CAT.c1 } }, c));
  assert.ok(again.runId, "a cancelled (terminal) run does not block a new run");
  assert.notEqual(again.runId, RUN, "the new run has a different run id");
});

// ---- G. restart persistence: serialize, then FRESH controller/tool instances resolve + verify ----
test("G: fresh controller/tool instances resolve the run from disk (no in-memory-only run state)", async () => {
  freshState();
  const d = proj(); const RUN = "lr-restart01";
  // "before restart": one factory records a PASS against a CHANGED-source candidate? No — keep 0
  // candidates; instead just prove the fresh instance resolves + verifies + completes.
  seededRun(d, RUN, "IMPLEMENTING");
  // "restart": a brand-new controller module + fresh tool factory, same serialized state dir.
  const CTRL2 = await import("../src/controller.js?r=" + Math.random());
  const plug2 = await import("../plugin/longrun.js?r=" + Math.random());
  const hooks = await plug2.default.server({ client: { app: { log: () => {} } } });
  const t = hooks.tool;
  const s0 = JSON.parse(await t.longrun.execute({ action: "status", runId: RUN }, ctx("sessG", d)));
  assert.equal(s0.state, "IMPLEMENTING", "a fresh controller resolves the same authoritative run from disk");
  assert.equal(s0.candidates, "0/3", "candidate ledger persisted (not reset by a new process)");
  const v = JSON.parse(await t.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, ctx("sessG", d)));
  assert.equal(v.status, "PASS");
  reviewProjectFixture(d, RUN);
  assert.equal(CTRL2.canComplete(store().readJSON(keyFor(d, RUN), "run.json")).complete, true, "loss reached 0 and completion is now allowed");
  assert.equal(JSON.parse(await t.longrun.execute({ action: "complete", runId: RUN }, ctx("sessG", d))).complete, true);
});

// ---- the deterministic COMMISSIONING fixture: the full lifecycle end to end, real factory+controller ----
test("COMMISSIONING: memory -> start -> status -> checkpoint -> pause -> new session -> resume -> verify(runId) -> loss0 -> complete -> new run -> cancel", async () => {
  freshState();
  const d = proj();
  // session A
  const tA = await tools(); const A = ctx("cs-A", d);
  assert.equal(JSON.parse(await tA.longrun.execute({ action: "memory_status" }, A)).status, "NO_MEMORY");
  const start = JSON.parse(await tA.longrun.execute({ action: "start", request: "Verify the v1.2.2 lifecycle", criteria: [{ id: "LC-001", required: true, evidenceClass: "STATIC", checks: ["c1"] }], checkCatalogue: STATIC_CAT }, A));
  const RUN = start.runId; assert.ok(RUN, "non-null runId");
  assert.equal(JSON.parse(await tA.longrun.execute({ action: "status", runId: RUN }, A)).state, "IMPLEMENTING");
  await tA.longrun.execute({ action: "checkpoint", runId: RUN }, A);
  assert.equal(await tA.longrun.execute({ action: "pause", runId: RUN }, A), "paused");
  // session B (new conversation / restart-equivalent)
  const tB = await tools(); const B = ctx("cs-B", d);
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "status", runId: RUN }, B)).state, "PAUSED");
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "resume", runId: RUN }, B)).state, "IMPLEMENTING");
  const v = JSON.parse(await tB.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: RUN }, B));
  assert.equal(v.status, "PASS"); assert.equal(v.candidateCount, 0, "lifecycle-only: 0 candidates");
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "status", runId: RUN }, B)).remaining.length, 0);
  reviewProjectFixture(d, RUN);
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "complete", runId: RUN }, B)).complete, true);
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "status", runId: RUN }, B)).state, "COMPLETE");
  // second run + cancel
  const start2 = JSON.parse(await tB.longrun.execute({ action: "start", request: "second", criteria: [{ id: "LC-002", required: true, evidenceClass: "STATIC", checks: ["c1"] }], checkCatalogue: STATIC_CAT }, B));
  assert.ok(start2.runId && start2.runId !== RUN, "a second run starts after the first completed");
  assert.equal(JSON.parse(await tB.longrun.execute({ action: "cancel", runId: start2.runId }, B)).cancelled, true);
  assert.equal(JSON.parse(await tB.longrun_verify.execute({ checkId: "c1", evidenceClass: "STATIC", runId: start2.runId }, B)).error, "RUN_CANCELLED");
});
