import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/controller.js";

function mkRun(fp = "fpA") {
  return C.startRun({
    request: "task",
    contract: { criteria: [{ id: "c1", required: true, checks: ["t"], status: "FAIL", weight: 1 }, { id: "c2", required: true, checks: ["t"], status: "FAIL", weight: 1 }], gates: [], lossTarget: 0 },
    budgets: C.defaultBudget(), sourceFingerprint: fp,
  }).run;
}
function receipt(fp, status = "PASS", testCount = 2) {
  return C.makeReceipt({ checkId: "t", command: "node run.mjs", exitCode: status === "PASS" ? 0 : 1, testCount, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: fp });
}

// ---- unchanged source + repeated test does NOT create a new candidate ----------------------
test("unchanged-source retries are not candidates (only the first real eval counts)", () => {
  const run = mkRun("fpA");
  // first evaluation at a NEW state (lastEvalFingerprint was seeded to the start fingerprint)
  const first = C.applyVerification(run, { receipt: receipt("fpZ"), canChangeAcceptance: true });
  assert.equal(first.candidate.counted, true, "first evaluated new source counts");
  const second = C.applyVerification(run, { receipt: receipt("fpZ"), canChangeAcceptance: true });
  assert.equal(second.candidate.counted, false);
  assert.equal(second.candidate.reason, "unchanged_source_retry");
  assert.equal(C.candidateCount(run), 1, "exactly one candidate after a repeat");
});

// ---- evaluated CHANGED source creates exactly ONE candidate --------------------------------
test("each distinct changed source yields exactly one candidate", () => {
  const run = mkRun("fpA");
  C.applyVerification(run, { receipt: receipt("fpB"), canChangeAcceptance: true });
  const two = C.applyVerification(run, { receipt: receipt("fpC"), canChangeAcceptance: true });
  assert.equal(two.candidate.counted, true);
  assert.equal(C.candidateCount(run), 2);
});

// ---- pure inspection / diagnostic-only are not candidates ----------------------------------
test("pure inspection and diagnostic-only runs are not candidates", () => {
  const run = mkRun("fpA");
  const insp = C.evidence.considerCandidate(run, { fingerprint: "fpX", evaluated: false });
  assert.equal(insp.counted, false); assert.equal(insp.reason, "inspection_not_evaluation");
  const diag = C.evidence.considerCandidate(run, { fingerprint: "fpY", evaluated: true, diagnosticOnly: true });
  assert.equal(diag.counted, false); assert.equal(diag.reason, "diagnostic_only");
  assert.equal(C.candidateCount(run), 0);
});

// ---- counters survive compaction/restart/resume (serialized state round-trips) -------------
test("candidate count + state survive a serialize -> reload (compaction/session boundary)", () => {
  const run = mkRun("fpA");
  C.applyVerification(run, { receipt: receipt("fpB"), canChangeAcceptance: true });
  C.applyVerification(run, { receipt: receipt("fpC"), canChangeAcceptance: true });
  const countBefore = C.candidateCount(run);
  const serialized = JSON.parse(JSON.stringify(run)); // survive a persistence round-trip
  assert.equal(C.candidateCount(serialized), countBefore, "count persists across reload");
  assert.equal(countBefore, 2);
});

// ---- loss/current/best stay associated with the correct candidate --------------------------
test("best/current loss is associated with the right candidate and not mixed up", () => {
  const run = mkRun("fpA");
  const a = C.applyVerification(run, { receipt: receipt("fpB", "FAIL"), canChangeAcceptance: true });
  assert.equal(a.candidate.lossAfter, 1, "nothing passed yet -> full loss");
  assert.equal(a.candidate.result, "FAIL");
  // two more real evals (each a distinct candidate) improving loss
  const b = C.applyVerification(run, { receipt: receipt("fpC", "PASS"), canChangeAcceptance: true });
  const c = C.applyVerification(run, { receipt: receipt("fpD", "PASS"), canChangeAcceptance: true });
  assert.ok(c.candidate.n > b.candidate.n, "candidate numbering is monotonic");
  assert.ok(run.state.best, "a best candidate was tracked");
  assert.equal(run.state.best.result, "PASS", "best is a PASS, never the FAIL");
  assert.ok(run.state.best.lossAfter <= run.state.current.lossAfter, "best is not worse than current");
  // candidate count must equal distinct counted states, never tool-call count
  assert.equal(C.candidateCount(run), 3);
});
