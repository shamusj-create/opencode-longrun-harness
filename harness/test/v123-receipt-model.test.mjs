import { approveFixtureReview } from "./helper.mjs";
// v1.2.3 reliability regression: the authoritative effective-receipt model + hard-gate recomputation.
// Reproduces the class of the live failure (a passing build/typecheck/tests still
// reported ENG incomplete / hard_gates_failed) using COPIED run/receipt state, then shows the
// upgraded logic completes. Nothing here touches production source, OpenCode config, or any live run.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/controller.js";

const CUR = "curnt"; // the current, correct project fingerprint
function rc(checkId, status, fp, finishedAt, extra = {}) {
  return C.makeReceipt({
    checkId, command: "x", exitCode: status === "PASS" ? 0 : 1, output: "",
    requirementKind: extra.kind || "cmd", sourceFingerprint: fp,
    startedAt: finishedAt - 1, finishedAt, fpScope: extra.scope || "project", evidenceClass: extra.ec,
  });
}
function mkRun({ criteria, gates, receipts }) {
  return { status: "VERIFYING", sourceFingerprint: CUR, faults: [], contract: { criteria, gates, lossTarget: 0 }, receipts, state: {} };
}

// ---- anti-masking: a NEWER project failure is not hidden behind an older PASS ----------------
test("effective receipt: a newer FAIL masks an older PASS (real regression)", () => {
  const run = mkRun({ criteria: [{ id: "ENG", required: true, checks: ["c-build"], status: "PASS" }], gates: [], receipts: [rc("c-build", "PASS", CUR, 10), rc("c-build", "FAIL", CUR, 20)] });
  assert.equal(C.effectiveStatus(run, "c-build", CUR), "FAIL", "the most recent result governs, not 'any PASS'");
});
test("effective receipt: a restore PASS supersedes an earlier FAIL (sabotage then repair)", () => {
  const run = mkRun({ criteria: [{ id: "ENG", required: true, checks: ["c-build"], status: "PASS" }], gates: [], receipts: [rc("c-build", "FAIL", CUR, 10), rc("c-build", "PASS", CUR, 20)] });
  assert.equal(C.effectiveStatus(run, "c-build", CUR), "PASS", "the repaired (most recent) state governs");
});

// ---- fingerprint authority: fixture/copy results never decide a project check ------------------
test("a copied/fixture FAIL does not invalidate a current project PASS", () => {
  const run = mkRun({
    criteria: [{ id: "ENG", required: true, checks: ["c-verify-all"], status: "PASS" }], gates: [],
    receipts: [rc("c-verify-all", "PASS", CUR, 10, { ec: "INTEGRATION" }), rc("c-verify-all", "FAIL", "copiesab", 20, { scope: "copy" })],
  });
  assert.equal(C.effectiveStatus(run, "c-verify-all", CUR), "PASS", "the copied sabotage is not project evidence and cannot turn it red");
});
test("an OLD project PASS is STALE on changed source, never trusted", () => {
  const run = mkRun({ criteria: [{ id: "ENG", required: true, checks: ["c-build"], status: "PASS" }], gates: [], receipts: [rc("c-build", "PASS", "oldfp", 10)] });
  assert.equal(C.effectiveStatus(run, "c-build", CUR), "STALE", "a pass from a different source state is not a current pass");
});

// ---- hard-gate readout / completion: independent of test count, recomputed from evidence ------
test("a build (non-test) hard gate completes on its own clean cmd receipt, no test receipt needed", () => {
  const run = mkRun({
    criteria: [{ id: "ENG", required: true, checks: ["c-typecheck", "c-build"], status: "PASS" }],
    gates: [{ id: "c-typecheck", required: true, status: "FAIL" }, { id: "c-build", required: true, status: "FAIL" }],
    receipts: [rc("c-typecheck", "PASS", CUR, 1), rc("c-build", "PASS", CUR, 2)],
  });
  approveFixtureReview(run, CUR);
  const cc = C.canComplete(run, { currentFingerprint: CUR });
  assert.equal(cc.complete, true, "both gates now read PASS from current evidence, despite a cached FAIL status");
});
test("a gate whose only evidence is a STALE pass blocks as stale_evidence (not trusting old PASS)", () => {
  const run = mkRun({
    criteria: [{ id: "ENG", required: true, checks: ["c-build"], status: "PASS" }],
    gates: [{ id: "c-build", required: true, status: "FAIL" }],
    receipts: [rc("c-build", "PASS", "oldfp", 1)], // stale: recorded on a different source state
  });
  const cc = C.canComplete(run, { currentFingerprint: CUR });
  assert.equal(cc.complete, false);
  assert.equal(cc.reason, "stale_evidence", "stale evidence is reported distinctly, not as a plain pass");
});
test("a gate with no project evidence is unverified (a copy sabotage is not a green light either)", () => {
  const run = mkRun({
    criteria: [{ id: "ENG", required: true, checks: ["c-verify-all"], status: "PASS" }],
    gates: [{ id: "c-verify-all", required: true, status: "FAIL" }],
    receipts: [rc("c-verify-all", "FAIL", "copiesab", 1, { scope: "copy" })], // only a copied-data failure, no project run
  });
  const cc = C.canComplete(run, { currentFingerprint: CUR });
  assert.equal(cc.complete, false);
  assert.match(cc.reason, /hard_gates_failed/, "no real project verification => the gate stays failed");
});

test("a multi-check criterion is not pinned 'unverified' by a stale marker when its checks pass", () => {
  // Mirrors the 2nd-verify STALE flip: the criterion status is STALE but every mapped check has a
  // current PASS. Completion must read the evidence, not the marker (the live 'ENG incomplete'
  // symptom that sat alongside a passing build).
  const run = mkRun({
    criteria: [{ id: "ENG", required: true, checks: ["c-typecheck", "c-build"], evidenceClass: null, status: "STALE" }],
    gates: [],
    receipts: [rc("c-typecheck", "PASS", CUR, 1), rc("c-build", "PASS", CUR, 2)],
  });
  assert.deepEqual(C.effectiveRemaining(run, CUR), [], "criterion reports satisfied from current evidence");
  approveFixtureReview(run, CUR);
  assert.equal(C.canComplete(run, { currentFingerprint: CUR }).complete, true, "completion follows evidence, not the stale marker");
});
test("class awareness is preserved: a UNIT-only proof cannot satisfy a BROWSER criterion", () => {
  const run = mkRun({
    criteria: [{ id: "VIS", required: true, checks: ["c-vis"], evidenceClass: "BROWSER", status: "FAIL" }],
    gates: [],
    receipts: [rc("c-vis", "PASS", CUR, 1, { ec: "UNIT" })], // class too weak for a BROWSER requirement
  });
  const cc = C.canComplete(run, { currentFingerprint: CUR });
  assert.equal(cc.complete, false);
  assert.equal(cc.reason, "required_unverified", "a weak proof is an evidence gap, not a completion");
});

// ---- THE REPRODUCTION: a faithful copy of the run shape -------------------------
// Gates c-typecheck / c-build / c-verify-all are cached FAIL; every underlying check has a PASS on
// current source; a build sabotage was recorded against COPIED data (a negative control). The OLD
// logic (trust cached gate FAIL, or "any PASS") would keep ENG incomplete / hard_gates_failed; the
// v1.2.3 logic reads the effective receipt and completes.
function exampleRun() {
  const receipts = [
    rc("c-fog-unit", "PASS", CUR, 1, { ec: "UNIT" }),
    rc("c-detect-unit", "PASS", CUR, 2, { ec: "UNIT" }),
    rc("c-ui-e2e", "PASS", CUR, 3, { ec: "SYSTEM" }),
    rc("c-verify-all", "FAIL", "copsab", 4, { scope: "copy" }), // sabotage against a copied workspace
    rc("c-typecheck", "PASS", CUR, 5),
    rc("c-build", "PASS", CUR, 6),
    rc("c-verify-all", "PASS", CUR, 7, { ec: "INTEGRATION" }), // restore, on current source
  ];
  const gates = ["c-typecheck", "c-build", "c-verify-all"].map((id) => ({ id, required: true, status: "FAIL" }));
  const criteria = [
    { id: "DETERM", required: true, checks: ["c-fog-unit", "c-detect-unit"], evidenceClass: null, status: "PASS" },
    { id: "ENG", required: true, checks: ["c-typecheck", "c-build", "c-verify-all"], evidenceClass: "INTEGRATION", status: "PASS" },
  ];
  return mkRun({ criteria, gates, receipts });
}

test("REPRODUCE + FIX: passing build/tests no longer pin the hard gates shut", () => {
  const run = exampleRun();
  // (old behaviour) a cached FAIL that nothing ever recomputed => permanent block:
  const oldBlock = run.contract.gates.some((g) => g.required && g.status !== "PASS");
  assert.equal(oldBlock, true, "the run still carries stale cached gate FAIL values (the reported symptom)");
  // the sabotage must not be counted as the project's c-verify-all state:
  assert.equal(C.effectiveStatus(run, "c-verify-all", CUR), "PASS", "copied sabotage excluded; restore PASS governs");
  for (const id of ["c-typecheck", "c-build", "c-verify-all"]) assert.equal(C.effectiveStatus(run, id, CUR), "PASS", `${id} reads PASS on current source`);
  assert.deepEqual(C.gateStatuses(run, CUR).filter((g) => !g.satisfied).map((g) => g.id), [], "no hard gate stays stuck FAIL");
  // (new behaviour) completion follows the effective receipt:
  approveFixtureReview(run, CUR);
  const cc = C.canComplete(run, { currentFingerprint: CUR });
  assert.equal(cc.complete, true, "all hard gates + criteria evaluate PASS from current evidence -> completion allowed");
});

test("SABOTAGE ISOLATION: a copied failure alone does not make a previously-good gate passable", () => {
  // If the ONLY evidence for a gate check is the copied sabotage, there is no real project proof.
  const run = mkRun({
    criteria: [{ id: "ENG", required: true, checks: ["c-verify-all"], status: "PASS" }],
    gates: [{ id: "c-verify-all", required: true, status: "FAIL" }],
    receipts: [rc("c-verify-all", "FAIL", "copiesab", 1, { scope: "copy" })],
  });
  const readout = C.gateStatuses(run, CUR);
  assert.equal(readout[0].status, "NOT_RUN", "a copied result is not project evidence; the gate shows no project proof");
});

// ---- parseTestCounts: discover real counts; zero is a coverage gap ----------------------------
test("parseTestCounts discovers vitest/playwright/node:test counts and treats zero as a gap", () => {
  assert.equal(C.parseTestCounts("Tests  12 passed (12)"), 12);
  assert.equal(C.parseTestCounts("18 passed (18)"), 18);
  assert.equal(C.parseTestCounts("ℹ tests 5\nℹ pass 5"), 5);
  assert.equal(C.parseTestCounts("RESULT pass=4 fail=0 total=4"), 4);
  assert.equal(C.parseTestCounts("Tests  1 failed (1)\nTests  0 passed"), 0);
});
test("a NON-test hard gate (kind cmd) is never forced into NOT_RUN by the zero-test rule", () => {
  const build = C.makeReceipt({ checkId: "c-build", command: "npm run build", exitCode: 0, testCount: undefined, requirementKind: "cmd", sourceFingerprint: CUR, startedAt: 1, finishedAt: 2 });
  assert.equal(build.status, "PASS", "build/typecheck pass on exit code; a test receipt is not required");
});

// ---- normalizeStartArgs: stringified structured params + string budgets/booleans -------------
test("normalizeStartArgs parses JSON-string criteria/catalogue/hardGates and numeric/bool params", () => {
  const raw = {
    request: "x",
    criteria: '[{"id":"ENG","checks":["c-build"]}]',
    checkCatalogue: '{"c-build":{"command":["npm","run","build"],"kind":"cmd"}}',
    hardGates: '["c-build"]',
    candidateBudget: "6", timeBudgetHours: "0.5", autoContinue: "false",
  };
  const n = C.normalizeStartArgs(raw);
  assert.ok(Array.isArray(n.criteria) && n.criteria[0].id === "ENG", "criteria stringified array parsed");
  assert.ok(!Array.isArray(n.checkCatalogue) && n.checkCatalogue["c-build"], "catalogue object parsed");
  assert.deepEqual(n.hardGates, ["c-build"], "hardGates string parsed");
  assert.equal(n.candidateBudget, 6, "budget coerced to number");
  assert.equal(n.timeBudgetHours, 0.5);
  assert.equal(n.autoContinue, false, "string 'false' is not truthy");
});
test("normalizeStartArgs never fabricates: malformed JSON -> empty, real arrays untouched", () => {
  const n = C.normalizeStartArgs({ criteria: "not-json", checkCatalogue: "{bad", candidateBudget: "abc" });
  assert.deepEqual(n.criteria, [], "malformed criteria becomes empty (=> start refuses, no fake run)");
  assert.deepEqual(n.checkCatalogue, {}, "malformed catalogue becomes empty");
  assert.equal(n.candidateBudget, undefined, "non-numeric budget dropped to a safe default");
});