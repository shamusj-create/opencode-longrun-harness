import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as C from "../src/controller.js";

function tmp(prefix = "lrtest") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
  return d;
}
function gitAvail() {
  const r = spawnSync("git", ["--version"]);
  return r.status === 0;
}
function git(dir, args) { return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }); }

// --- 3: two repos/worktrees and non-git projects do NOT share state (identity keying)
test("identity: git vs two non-git dirs key differently; git uses toplevel+HEAD", (t) => {
  if (!gitAvail()) { t.skip("no git"); return; }
  const g = tmp("git"); git(g, ["init", "-q"]); git(g, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
  const idG = C.projectIdentity(g);
  assert.equal(idG.kind, "git");
  assert.match(idG.id, /^git:/);
  assert.ok(idG.head && idG.head.length === 40, "git identity carries HEAD");

  const a = tmp("dira"); const b = tmp("dirb");
  const ida = C.projectIdentity(a), idb = C.projectIdentity(b);
  assert.equal(ida.kind, "dir");
  assert.notEqual(ida.id, idb.id, "two non-git dirs must not collapse to one identity");
  // subdir of a git repo maps to the repo root identity, not to itself
  const sub = path.join(g, "pkg"); fs.mkdirSync(sub);
  const idSub = C.projectIdentity(sub);
  assert.equal(idSub.root, C.projectIdentity(g).root, "subdir resolves to repo root identity");
});

// --- 3: separate key per (identity, runId)
test("stateKey separates runs and identities", () => {
  const id = { kind: "dir", id: "dir:/x" };
  const k1 = C.stateKey(id, "runA");
  const k2 = C.stateKey(id, "runB");
  const k3 = C.stateKey({ kind: "dir", id: "dir:/y" }, "runA");
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});

// --- 5 + 6: loss function integrity
test("loss: empty required set rejected", () => {
  assert.deepEqual(C.defaultLoss({ criteria: [{ id: "c1", required: false, status: "PASS" }] }), { error: "empty_required_set" });
});
test("loss: zero denominator rejected", () => {
  const r = C.defaultLoss({ criteria: [{ id: "c1", required: true, weight: 0, status: "FAIL" }] });
  assert.equal(r.error, "zero_denominator");
});
test("loss: unverified required counts as unsatisfied; weighted fraction", () => {
  const c = { criteria: [
    { id: "a", required: true, weight: 1, status: "PASS" },
    { id: "b", required: true, weight: 1, status: "FAIL" }, // missing/stale => unsatisfied
    { id: "c", required: true, weight: 2, status: "STALE" },
  ] };
  const r = C.defaultLoss(c);
  assert.equal(r.denom, 4);
  assert.equal(r.num, 3);
  assert.ok(Math.abs(r.loss - 0.75) < 1e-9);
});
test("loss: non-finite evaluator value is an error, never a score", () => {
  assert.equal(C.evaluateEvaluatorResult({ value: NaN }).error, "non_finite_or_missing_value");
  assert.equal(C.evaluateEvaluatorResult({ value: Infinity }).error, "non_finite_or_missing_value");
  assert.equal(C.evaluateEvaluatorResult(null).error, "invalid_evaluator_output");
});

// --- 6 + 15: a reduced soft loss cannot outweigh a failed hard gate / required check
test("completion: soft loss cannot beat hard gate or required failure", () => {
  const runNoGate = { contract: { lossTarget: 0, criteria: [{ id: "a", required: true, status: "PASS", weight: 1 }], gates: [] }, state: {}, status: "VERIFYING" };
  assert.equal(C.canComplete(runNoGate).complete, true, "all pass + loss met -> complete");

  const gateFail = structuredClone(runNoGate);
  gateFail.contract.gates = [{ id: "build", required: true, status: "FAIL" }];
  const r1 = C.canComplete(gateFail);
  assert.equal(r1.complete, false);
  assert.equal(r1.reason, "hard_gates_failed");

  const ctrlFault = structuredClone(runNoGate);
  ctrlFault.faults = ["evaluator_crashed"];
  const r2 = C.canComplete(ctrlFault);
  assert.equal(r2.complete, false);
  assert.equal(r2.reason, "controller_fault");
});

// --- 4 + 5: receipts; only PASS satisfies; 0 tests cannot pass; console optimism ignored
test("receipt: exit code decides, not console text", () => {
  const bad = C.makeReceipt({ checkId: "t", command: "npm test", exitCode: 1, output: "ALL TESTS PASSED", testCount: 5, startedAt: 1, finishedAt: 2, sourceFingerprint: "fp1" });
  assert.equal(bad.status, "FAIL");
  assert.ok(!C.statusSatisfies(bad.status));
});
test("receipt: zero discovered tests is NOT_RUN (cannot satisfy coverage)", () => {
  const zero = C.makeReceipt({ checkId: "t", command: "jest", exitCode: 0, testCount: 0, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: "fp1" });
  assert.equal(zero.status, "NOT_RUN");
});
test("receipt: stale when source fingerprint changed (tracked/untracked/shell edits)", () => {
  const r = C.makeReceipt({ checkId: "t", command: "true", exitCode: 0, testCount: 3, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: "fpA" });
  assert.equal(C.resolveReceiptStatus(r, "fpA"), "PASS");
  assert.equal(C.resolveReceiptStatus(r, "fpB"), "STALE");
});

// --- 7: source fingerprint catches untracked + deletions and self-excludes controller output
test("sourceFingerprint: untracked changes hash; deletion changes hash; deletions listed", (t) => {
  if (!gitAvail()) { t.skip("no git"); return; }
  const g = tmp("fp"); git(g, ["init", "-q"]); git(g, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "i"]);
  fs.writeFileSync(path.join(g, "a.js"), "1");
  git(g, ["add", "a.js"]); git(g, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "add a"]);
  const fp0 = C.sourceFingerprint(g).hash;
  // modify tracked
  fs.writeFileSync(path.join(g, "a.js"), "2");
  const fp1 = C.sourceFingerprint(g).hash;
  assert.notEqual(fp0, fp1, "tracked modification invalidates");
  // add untracked
  fs.writeFileSync(path.join(g, "note.txt"), "untracked");
  const fp2 = C.sourceFingerprint(g).hash;
  assert.notEqual(fp1, fp2, "untracked addition invalidates (git HEAD alone is insufficient)");
  // delete tracked
  fs.rmSync(path.join(g, "a.js"));
  const fp3 = C.sourceFingerprint(g);
  assert.notEqual(fp2, fp3.hash, "deletion invalidates");
  // controller's own receipt/log must NOT change fingerprint (no perpetual self-invalidation)
  fs.mkdirSync(path.join(g, ".longrun"));
  fs.writeFileSync(path.join(g, ".longrun", "events.log"), "x");
  fs.writeFileSync(path.join(g, "RESUME.md"), "y");
  const fp4 = C.sourceFingerprint(g);
  assert.equal(fp4.hash, fp3.hash, "controller logs + RESUME.md are excluded -> evidence does not self-invalidate");
  // now remove RESUME/events but keep deletion -> compare to a copy where only deletion differs
  const g2 = tmp("fp2"); git(g2, ["init", "-q"]); git(g2, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "i"]);
  fs.writeFileSync(path.join(g2, "a.js"), "2"); git(g2, ["add", "a.js"]); git(g2, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "a"]);
  fs.writeFileSync(path.join(g2, "note.txt"), "untracked");
  fs.rmSync(path.join(g2, "a.js"));
  const g3 = tmp("fp3"); git(g3, ["init", "-q"]); git(g3, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "i"]);
  fs.writeFileSync(path.join(g3, "a.js"), "2"); git(g3, ["add", "a.js"]); git(g3, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "a"]);
  fs.writeFileSync(path.join(g3, "note.txt"), "untracked");
  fs.rmSync(path.join(g3, "a.js"));
  fs.mkdirSync(path.join(g3, ".longrun")); fs.writeFileSync(path.join(g3, ".longrun", "events.log"), "x"); fs.writeFileSync(path.join(g3, "RESUME.md"), "y");
  assert.equal(C.sourceFingerprint(g2).hash, C.sourceFingerprint(g3).hash, "self logs/RESUME excluded so evidence does not self-invalidate");
});

// --- 4: one writer per worktree (lock not double-acquired)
test("store: writer lock is exclusive and released", () => {
  const dir = tmp("store");
  const s = new C.Store(dir);
  const key = "k1";
  assert.equal(s.tryLock(key, "t1"), true);
  assert.equal(s.tryLock(key, "t2"), false, "second writer rejected");
  s.releaseLock(key);
  assert.equal(s.tryLock(key, "t3"), true, "reacquire after release");
});

// --- 4: append-only event log dedups duplicate/reordered events (no double-dispatch)
test("event log: dedup duplicate events; distinct events append", () => {
  const dir = tmp("store");
  const s = new C.Store(dir);
  const key = "k1";
  assert.equal(s.appendEvent(key, { dedupeKey: "e1", type: "x" }), true);
  assert.equal(s.appendEvent(key, { dedupeKey: "e1", type: "x" }), false, "dup ignored");
  assert.equal(s.appendEvent(key, { dedupeKey: "e2", type: "x" }), true);
});

// --- 7 + 8 + 11: scheduler guards
test("scheduler: idle alone is never authorisation; helper ignored; dup/single-flight/generation", () => {
  const dir = tmp("sched");
  const s = new C.Store(dir);
  const sched = new C.Scheduler(s);
  // AUTO disabled by default
  assert.equal(sched.requestContinuation({ runKey: "r", eventId: "1", sessionID: "s1", generation: 1, state: "IMPLEMENTING", autoEnabled: false, messageAuthorised: true }).reason, "auto_disabled");
  // helper session ignored even if auto on
  assert.equal(sched.requestContinuation({ runKey: "r", eventId: "2", sessionID: "child", isHelper: true, state: "IMPLEMENTING", autoEnabled: true, messageAuthorised: true }).reason, "helper_session");
  // idle-only (not authorised) blocked
  assert.equal(sched.requestContinuation({ runKey: "r", eventId: "3", sessionID: "s1", generation: 1, state: "IMPLEMENTING", autoEnabled: true, messageAuthorised: false }).reason, "idle_not_authorisation");
  // first authorised dispatch passes
  const first = sched.requestContinuation({ runKey: "r", eventId: "4", sessionID: "s1", generation: 1, state: "IMPLEMENTING", autoEnabled: true, messageAuthorised: true });
  assert.equal(first.dispatch, true, "first dispatch");
  // duplicate event (same id) does not double-dispatch
  const dup = sched.requestContinuation({ runKey: "r", eventId: "4", sessionID: "s1", generation: 1, state: "IMPLEMENTING", autoEnabled: true, messageAuthorised: true });
  assert.equal(dup.reason, "duplicate_event");
  // complete, then single-flight clears
  sched.completeDispatch("r");
  const second = sched.requestContinuation({ runKey: "r", eventId: "5", sessionID: "s1", generation: 2, pendingGeneration: 1, state: "IMPLEMENTING", autoEnabled: true, messageAuthorised: true });
  assert.equal(second.reason, "generation_guard", "stale generation blocked");
});

// --- 4 + 8: resume authorization
test("resume: assistant prose / repo file text / stray event cannot resume", () => {
  const run = { status: "PAUSED" };
  assert.equal(C.canResume(run, "user_cli").ok, true);
  assert.equal(C.canResume(run, "assistant_text").ok, false);
  assert.equal(C.canResume(run, "repo_file_text").ok, false, "text in a repository file must not resume a cancelled run");
  assert.equal(C.canResume(run, "event").ok, false);
});

// --- 8 + 9: same-failure / no-progress => bounded replan then pause; counters persist
test("afterEvaluation: 3x same failure -> replan; 5x no-progress -> replan then pause", () => {
  const mk = () => ({ status: "REPAIRING", budget: C.defaultBudget(), state: {} });
  let run = mk();
  let res;
  for (let i = 0; i < 3; i++) res = C.afterEvaluation(run, { progress: true, failureSignature: "boom" });
  assert.equal(res.next, "NEEDS_REPLAN", "3x same failure requires replan");
  run = mk();
  let r2;
  for (let i = 0; i < 5; i++) r2 = C.afterEvaluation(run, { progress: false });
  assert.equal(r2.next, "NEEDS_REPLAN", "5x no-progress -> one bounded replan");
  const r3 = C.afterEvaluation(run, { progress: false });
  assert.equal(r3.next, "PAUSED", "still stalled -> pause (no infinite loop)");
});

// --- 9: recovery packet bounded + from authoritative records
test("recovery packet: includes contract refs, remaining ids, budgets; word-capped", () => {
  const run = {
    status: "REPAIRING", contractHash: "abc", evaluatorHash: "def",
    originalRequest: "Build X feature",
    contract: { criteria: [{ id: "c1", required: true, status: "PASS" }, { id: "c2", required: true, status: "FAIL" }] },
    state: { iterations: 7, noProgressStreak: 2, sameFailureStreak: 1, currentSlice: "sliceA", nextAction: "verify c2", verifiedRefs: ["r1"], decisions: ["use existing stack"], relevantPaths: ["src/x"], failedHypotheses: ["h1"] },
  };
  const { packet, words } = C.buildRecoveryPacket(run);
  assert.match(packet, /REMAINING CRITERIA: c2/);
  assert.match(packet, /Build X feature/);
  assert.match(packet, /iters=7/);
  assert.ok(words < 1500);
  // big packet truncates
  run.originalRequest = "word ".repeat(2000);
  const big = C.buildRecoveryPacket(run, 1500);
  assert.ok(big.words <= 1500, "bounded under limit");
});