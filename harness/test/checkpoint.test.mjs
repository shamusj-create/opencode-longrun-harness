import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/controller.js";

function mkRun() {
  const run = C.startRun({
    request: "Build the feature",
    contract: { criteria: [{ id: "c1", required: true, checks: ["t"], status: "FAIL" }, { id: "c2", required: true, checks: ["t"], status: "FAIL", evidenceClass: "BROWSER", visual: true }], gates: [], lossTarget: 0 },
    budgets: C.defaultBudget(), sourceFingerprint: "fpA",
  }).run;
  C.applyVerification(run, { receipt: C.makeReceipt({ checkId: "t", command: "x", exitCode: 0, testCount: 2, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: "fpB" }) });
  C.applyVerification(run, { receipt: C.makeReceipt({ checkId: "t", command: "x", exitCode: 0, testCount: 2, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: "fpC", evidenceClass: "UNIT" }) });
  run.state.failedHypotheses = ["assumed the in-memory store was enough"];
  run.state.nextAction = "add real persistence then re-run c1";
  run.state.currentSlice = "persistence";
  run.state.memoryNodes = ["AGENTS.md", "packages/core/AGENTS.md"];
  return run;
}

// ---- recovery reconstructs state from AUTHORITATIVE records --------------------------------
test("resume packet is rebuilt from authoritative state (not from prose)", () => {
  const run = mkRun();
  const { packet } = C.buildRecoveryPacket(run);
  assert.match(packet, /CANDIDATES: 2\/40/, "exact candidate count included");
  assert.match(packet, /NEXT ACTION: add real persistence/, "exact next action survives");
  assert.match(packet, /UNSUCCESSFUL APPROACHES: assumed the in-memory store/, "disproved approaches survive");
  assert.match(packet, /MEMORY NODES.*packages\/core\/AGENTS\.md/, "memory node references survive (lazy reload)");
  assert.match(packet, /BUDGETS \(persisted\): iters=/, "budget counters survive");
});

// ---- does NOT recursively summarize previous summaries -------------------------------------
test("a prior summary embedded in state is NOT echoed (no summary-of-summary)", () => {
  const run = mkRun();
  run.state.summary = "PRIOR_SUMMARY_MARKER: this old compaction summary should not be re-summarized verbatim into the packet";
  const { packet } = C.buildRecoveryPacket(run);
  assert.ok(!packet.includes("PRIOR_SUMMARY_MARKER"), "regenerates from source-of-truth, not prior summaries");
});

// ---- retains budgets + exact candidate count + best loss -----------------------------------
test("recovery retains budgets, exact candidate count and best-vs-current loss", () => {
  const run = mkRun();
  const { packet } = C.buildRecoveryPacket(run);
  assert.match(packet, /BEST LOSS:/, "best loss present");
  assert.match(packet, /CURRENT LOSS:/, "current loss present");
  assert.match(packet, /CANDIDATES: 2\/40/);
});

// ---- identifies a stale source fingerprint --------------------------------------------------
test("recovery flags a stale source fingerprint so it is re-checked, not trusted", () => {
  const run = mkRun();
  run.sourceFingerprintStale = true;
  const { packet } = C.buildRecoveryPacket(run);
  assert.match(packet, /SOURCE FINGERPRINT:.*STALE/, "stale fingerprint explicitly flagged");
});

// ---- candidate count + state persist across a serialize/reload boundary --------------------
test("recovery after a serialize->reload reconstructs the SAME exact candidate count", t => {
  const run = mkRun();
  const observedAt = Date.now(); t.mock.method(Date, "now", () => observedAt); // compare two reconstructions at the same instant
  const copy = JSON.parse(JSON.stringify(run));
  const a = C.buildRecoveryPacket(run).packet;
  const b = C.buildRecoveryPacket(copy).packet;
  assert.equal(a, b, "packet regenerates identically from reconstructed state");
  assert.equal(C.candidateCount(copy), C.candidateCount(run));
});
