// v1.2.20 — audited operator-only budget amendment (finite candidate allowance + new absolute
// deadline). Reproduced BEFORE implementation: every test below uses the amendment API that did
// not exist yet, so the pre-change run failed rather than silently passing.
//
// Trust boundary: the amendment is reachable ONLY through the installed maintenance CLI, never
// through the native model tool surface (RUN_ACTIONS/ACTION_PARAMS). Like the completion review it
// is an auditable workflow boundary, not an OS sandbox against arbitrary state-file access.
//
// These are offline deterministic tests. They are NOT native OpenCode host evidence and they never
// touch production source, config, model routing, permissions or the protected run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as C from '../src/controller.js';
import { install, VERSION } from '../src/install.mjs';
import { approveStoredFixtureReview, F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');

// The grant that was actually applied to the annotations run used the absolute deadline below. It is
// kept here for the historical record, but the tests must not depend on wall-clock time: a fixture
// run's own deadline is computed from the moment it is created, so once real time passed the real
// grant's deadline the amendment correctly reported AMENDMENT_DEADLINE_NOT_EXTENDING and these tests
// failed for a reason that had nothing to do with the code under test. The deadline exercised below
// is therefore a fixed date far in the future, so "a grant extends the deadline and becomes the
// effective one" stays deterministic whenever the suite runs. Every assertion is unchanged.
const GRANT_DEADLINE_AS_APPLIED = Date.parse('2026-09-22T23:30:00.000Z'); // historical, not used for timing
const TEST_GRANT_DEADLINE = Date.parse('2099-01-01T00:00:00.000Z');

const GRANT = {
  amendmentId: 'grant-example-20260921-01',
  additionalCandidates: 12,
  newDeadlineAt: TEST_GRANT_DEADLINE,
  authorization: 'User authorized 12 additional candidates (cumulative 36) and a new absolute deadline for the same paused annotations run.',
  reason: 'The original 24-candidate allowance was exhausted and its original deadline had already expired; the remaining reviewed full scope needs a finite, audited extension.',
};
const ORIGINAL_DEADLINE = Date.parse('2026-09-21T03:59:32.883Z');

async function fixture(t, budget = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1220-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'baseline');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
  const ctx = { sessionID: 'amendment-fixture', directory: dir, worktree: dir };
  const command = [process.execPath, '-e', "require('node:assert/strict').match(require('node:fs').readFileSync('value.txt','utf8'),/^valid/)"];
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Isolated operator-amendment regression', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check: { command, kind: 'cmd', gate: true } }, ...budget }, ctx));
  assert.ok(start.runId, JSON.stringify(start));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  const read = () => { const r = store.readRun(key); assert.equal(r.error, undefined, JSON.stringify(r)); return r.run; };
  const verify = async (args = {}) => JSON.parse(await hooks.tool.longrun_verify.execute({ runId: start.runId, checkId: 'check', ...args }, ctx));
  const amend = (args) => C.operatorBudgetAmendment(store, key, { directory: dir, runId: start.runId, ...args });
  const bytes = () => fs.readFileSync(store._file(key, 'run.json'));
  return { base, dir, hooks, ctx, start, store, key, read, verify, amend, bytes };
}
const basisOf = run => C.completionReviewBasis(run, run.sourceFingerprint);
const grantArgs = run => ({ ...GRANT, expectedRevision: run.controlGeneration || 0, expectedBasis: basisOf(run) });

// Drive a run to the real v1.2.19 stop: one counted candidate, then a NEW source refused at the cap.
async function exhaust(t) {
  const s = await fixture(t, { candidateBudget: 1 });
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'valid-one');
  assert.equal((await s.verify()).status, 'PASS');
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'valid-two');
  const refused = await s.verify();
  assert.equal(refused.error, 'BUDGET_EXHAUSTED');
  assert.equal(refused.spent.candidates, true);
  assert.equal(s.read().status, 'PAUSED');
  return s;
}

test('pre-amendment: cap and expired deadline refuse, and the native model tool surface cannot amend', async t => {
  const s = await exhaust(t);
  assert.ok(!C.RUN_ACTIONS.includes('amend'), 'no native amend action exists');
  assert.ok(!Object.keys(C.ACTION_PARAMS).some(a => /amend|allowance|grant/i.test(a)), 'no native amendment parameters');
  const native = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'amend', runId: s.start.runId }, s.ctx));
  assert.equal(native.error, 'unknown_action');

  const d = await fixture(t);
  const run = d.read();
  run.createdAt = ORIGINAL_DEADLINE - run.budget.deadlineSeconds * 1000; // deadline already passed
  d.store.writeJSON(d.key, 'run.json', run);
  const expired = await d.verify();
  assert.equal(expired.error, 'BUDGET_EXHAUSTED');
  assert.equal(expired.spent.deadline, true);
});

test('operator amendment preserves original budget and history and exposes original vs effective limits', async t => {
  const s = await exhaust(t);
  const before = s.read();
  const frozen = { budget: JSON.parse(JSON.stringify(before.budget)), receipts: before.receipts.length,
    candidateCount: C.candidateCount(before), createdAt: before.createdAt, contractHash: before.contractHash,
    verificationMs: before.execution?.verificationMs };

  const result = await s.amend(grantArgs(before));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.state, 'PAUSED', 'a grant never resumes a run');
  assert.ok(!result.alreadyApplied);

  const after = s.read();
  assert.deepEqual(after.budget, frozen.budget, 'original budget fields are untouched');
  assert.equal(after.receipts.length, frozen.receipts, 'receipt history retained');
  assert.equal(C.candidateCount(after), frozen.candidateCount, 'usage counters never reset');
  assert.equal(after.createdAt, frozen.createdAt, 'creation timestamp never rewritten');
  assert.equal(after.contractHash, frozen.contractHash, 'contract untouched');
  assert.equal(after.execution?.verificationMs, frozen.verificationMs, 'measured usage untouched');
  assert.equal(after.status, 'PAUSED'); assert.equal(after.autoEnabled, false);
  assert.equal(after.controlGeneration, (before.controlGeneration || 0) + 1, 'audited mutation advances generation');

  assert.equal(after.budgetAmendments.length, 1);
  const rec = after.budgetAmendments[0];
  assert.equal(rec.schemaVersion, C.AMENDMENT_SCHEMA_VERSION);
  assert.equal(rec.id, GRANT.amendmentId); assert.equal(rec.source, 'operator_cli');
  assert.equal(rec.additionalCandidates, 12); assert.equal(rec.newDeadlineAt, GRANT.newDeadlineAt);
  assert.equal(rec.authorization, GRANT.authorization.trim(), 'authorization recorded verbatim');
  assert.equal(rec.reason, GRANT.reason.trim());
  assert.equal(rec.originalDeadlineAt, after.createdAt + after.budget.deadlineSeconds * 1000);
  assert.equal(rec.previousEffectiveCandidates, 1);
  assert.match(rec.priorRunHash, /^[a-f0-9]{64}$/);

  const view = C.deriveRunView(after, { currentFingerprint: after.sourceFingerprint });
  assert.equal(view.candidates, `${frozen.candidateCount}/13`, 'effective candidate limit shown');
  assert.equal(view.budgetLimit.original.iterations, 1, 'original limit reported separately');
  assert.equal(view.budgetLimit.additionalCandidates, 12);
  assert.equal(view.budgetLimit.effective.iterations, 13);
  assert.equal(view.controlRevision, after.controlGeneration);
  assert.match(view.amendmentBasis, /^[a-f0-9]{64}$/);

  const timing = C.execution.timing(after);
  assert.equal(timing.deadlineAt, GRANT.newDeadlineAt, 'effective deadline is the granted one');
  assert.equal(timing.originalDeadlineAt, rec.originalDeadlineAt, 'original deadline still reported');
  const guard = C.execution.budgetGuard(after, { fingerprint: 'brand-new-source-fingerprint' });
  assert.equal(guard.ok, true, JSON.stringify(guard.spent));
  assert.equal(guard.spent.candidates, false); assert.equal(guard.spent.deadline, false);
});

test('after a grant a new source candidate is admitted and ordinary tool admission is restored', async t => {
  const s = await exhaust(t);
  assert.equal((await s.amend(grantArgs(s.read()))).ok, true);
  const resumed = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'resume', runId: s.start.runId }, s.ctx));
  assert.equal(resumed.state, 'IMPLEMENTING', JSON.stringify(resumed));
  await s.hooks['tool.execute.before']({ tool: 'bash', sessionID: s.ctx.sessionID }, { args: {} });
  const verified = await s.verify();
  assert.equal(verified.status, 'PASS', JSON.stringify(verified));
  const after = s.read();
  assert.equal(C.candidateCount(after), 2, 'the newly admitted source counts as a candidate');
  assert.equal(after.budget.iterations, 1, 'the original declared limit is still 1');
});

test('amendment refuses invalid, stale, conflicting, non-paused and in-flight requests without mutation', async t => {
  const s = await fixture(t, { candidateBudget: 5 });
  s.store.mutate(s.key, C.pauseRun);
  const paused = s.read();
  const good = grantArgs(paused);
  const cases = [
    [{ ...good, expectedBasis: 'f'.repeat(64) }, 'AMENDMENT_BASIS_CHANGED'],
    [{ ...good, expectedRevision: (paused.controlGeneration || 0) + 7 }, 'AMENDMENT_REVISION_CHANGED'],
    [{ ...good, amendmentId: 'short' }, 'INVALID_AMENDMENT'],
    [{ ...good, additionalCandidates: 0 }, 'INVALID_AMENDMENT'],
    [{ ...good, additionalCandidates: 1.5 }, 'INVALID_AMENDMENT'],
    [{ ...good, additionalCandidates: 1e6 }, 'INVALID_AMENDMENT'],
    [{ ...good, newDeadlineAt: Date.now() - 1000 }, 'AMENDMENT_DEADLINE_NOT_FUTURE'],
    [{ ...good, newDeadlineAt: paused.createdAt + paused.budget.deadlineSeconds * 1000 - 1000 }, 'AMENDMENT_DEADLINE_NOT_EXTENDING'],
    [{ ...good, authorization: '   ' }, 'INVALID_AMENDMENT'],
    [{ ...good, reason: '' }, 'INVALID_AMENDMENT'],
  ];
  for (const [args, expected] of cases) {
    const before = s.bytes();
    const result = await s.amend(args);
    assert.equal(result.error, expected, JSON.stringify({ args, result }));
    assert.deepEqual(s.bytes(), before, `refusal ${expected} must not mutate canonical state`);
  }
  for (const [mutate, expected] of [
    [run => { run.status = 'IMPLEMENTING'; }, 'AMENDMENT_REQUIRES_PAUSE'],
    [run => { run.status = 'COMPLETE'; }, 'RUN_COMPLETE'],
    [run => { run.status = 'CANCELLED'; }, 'RUN_CANCELLED'],
    [run => { run.status = 'PAUSED'; run.execution.inFlight = { ownerPid: process.pid, token: 'live' }; }, 'VERIFY_IN_FLIGHT'],
  ]) {
    const run = s.read(); mutate(run); s.store.writeJSON(s.key, 'run.json', run);
    const before = s.bytes();
    assert.equal((await s.amend(grantArgs(s.read()))).error, expected);
    assert.deepEqual(s.bytes(), before, `refusal ${expected} must not mutate canonical state`);
  }
  const run = s.read(); run.status = 'PAUSED'; run.execution.inFlight = null; s.store.writeJSON(s.key, 'run.json', run);
  const before = s.bytes();
  const mismatch = await C.operatorBudgetAmendment(s.store, s.key, { directory: s.dir, runId: 'someone-else', ...grantArgs(s.read()) });
  assert.equal(mismatch.error, 'AMENDMENT_RUN_MISMATCH');
  assert.deepEqual(s.bytes(), before);
});

test('an exact repeat is idempotent, a conflicting repeat is refused, and a stale grant cannot be applied', async t => {
  const s = await exhaust(t);
  const first = s.read();
  const staleBasis = basisOf(first), staleRevision = first.controlGeneration || 0;
  assert.equal((await s.amend({ ...GRANT, expectedRevision: staleRevision, expectedBasis: staleBasis })).ok, true);
  const afterFirst = s.read();
  assert.equal(afterFirst.budgetAmendments.length, 1);

  const repeat = await s.amend({ ...GRANT, expectedRevision: staleRevision, expectedBasis: staleBasis });
  assert.equal(repeat.ok, true); assert.equal(repeat.alreadyApplied, true);
  assert.equal(s.read().budgetAmendments.length, 1, 'an exact repeat does not double-count');
  assert.equal(C.execution.effectiveIterations(s.read()), 13);

  const conflict = await s.amend({ ...GRANT, additionalCandidates: 99, expectedRevision: staleRevision, expectedBasis: staleBasis });
  assert.equal(conflict.error, 'AMENDMENT_ID_CONFLICT');
  assert.equal(s.read().budgetAmendments.length, 1);

  const stale = await s.amend({ ...GRANT, amendmentId: 'grant-second-stale-0001', additionalCandidates: 4, expectedRevision: staleRevision, expectedBasis: staleBasis });
  assert.equal(stale.error, 'AMENDMENT_BASIS_CHANGED', 'a grant bound to a superseded state is refused');

  const current = s.read();
  const second = await s.amend({ ...GRANT, amendmentId: 'grant-example-20260921-02', additionalCandidates: 4, newDeadlineAt: GRANT.newDeadlineAt + 3600000, expectedRevision: current.controlGeneration || 0, expectedBasis: basisOf(current) });
  assert.equal(second.ok, true, JSON.stringify(second));
  const after = s.read();
  assert.equal(after.budgetAmendments.length, 2);
  assert.equal(C.execution.effectiveIterations(after), 1 + 12 + 4, 'finite allowances accumulate');
  assert.equal(C.execution.timing(after).deadlineAt, GRANT.newDeadlineAt + 3600000);
});

test('a grant invalidates a prior completion acceptance and never resumes or self-approves', async t => {
  const s = await fixture(t, { candidateBudget: 5 });
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'valid-one');
  assert.equal((await s.verify()).status, 'PASS');
  s.store.mutate(s.key, C.pauseRun);
  approveStoredFixtureReview(s.store, s.key);
  const accepted = s.read();
  const fp = accepted.sourceFingerprint;
  assert.equal(C.completionReviewStatus(accepted, fp).status, 'ACCEPTED');
  assert.equal(C.canComplete(accepted, { currentFingerprint: fp }).complete, true);

  const result = await s.amend(grantArgs(accepted));
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = s.read();
  assert.equal(after.status, 'PAUSED', 'the grant itself never resumes');
  assert.equal(after.autoEnabled, false);
  assert.equal(C.completionReviewStatus(after, fp).status, 'STALE', 'prior acceptance is invalidated by the budget change');
  const completion = C.canComplete(after, { currentFingerprint: fp });
  assert.equal(completion.complete, false);
  assert.equal(completion.reason, 'completion_review_stale');
});

test('the real exhausted annotations run gains exactly a finite allowance without rewriting history', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1220-copy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir);
  const state = path.join(base, 'state');
  const run = JSON.parse(fs.readFileSync(new URL('./fixtures/notes-budget-exhausted-run.json', import.meta.url)));
  const runId = run.runId;
  run.status = 'PAUSED'; run.autoEnabled = false; run.controlGeneration = (run.controlGeneration || 0) + 1;
  run.directory = dir;
  const store = new C.Store(state), key = C.stateKey(C.projectIdentity(dir), runId);
  store.writeJSON(key, 'run.json', run);
  const before = store.readRun(key).run;
  assert.equal(C.candidateCount(before), 24);
  assert.equal(before.receipts.length, 37);
  assert.equal(before.budget.iterations, 24);

  const result = await C.operatorBudgetAmendment(store, key, { directory: dir, runId,
    amendmentId: 'grant-example-real-0001', additionalCandidates: 12,
    newDeadlineAt: TEST_GRANT_DEADLINE,
    authorization: GRANT.authorization, reason: GRANT.reason,
    expectedRevision: before.controlGeneration || 0, expectedBasis: basisOf(before) });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = store.readRun(key).run;
  assert.deepEqual(after.budget, before.budget, 'original 24/7200/140 limit preserved');
  assert.equal(C.candidateCount(after), 24, '24 used candidates preserved');
  assert.equal(after.receipts.length, 37, '37 receipts preserved');
  assert.equal(after.execution.verificationMs, before.execution.verificationMs);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.contractHash, before.contractHash);
  assert.equal(C.execution.effectiveIterations(after), 36, 'cumulative effective limit is 36');
  assert.equal(C.execution.timing(after).deadlineAt, TEST_GRANT_DEADLINE);
  assert.equal(C.execution.budgetGuard(after, { fingerprint: 'post-grant-unverified-source' }).ok, true);

  const view = C.deriveRunView(after, { currentFingerprint: 'post-grant-unverified-source' });
  assert.equal(view.historicalReceiptCount, 37);
  assert.equal(view.candidates, '24/36');
  assert.equal(view.checks.length, 6, 'all six declared checks still reported');
  assert.equal(view.checks.every(c => c.effectiveStatus === 'STALE'), true, 'no historical PASS is promoted to current');
});

test('the installed operator CLI is the only amendment path and requires the read-only basis and revision', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1220-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), config = path.join(root, 'config'), state = path.join(root, 'state');
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'value.txt'), 'fixture');
  install({ configDir: config });
  const store = new C.Store(state), runId = 'amendment-cli-fixture', key = C.stateKey(C.projectIdentity(project), runId);
  const run = { runId, directory: project, status: 'PAUSED', autoEnabled: false, controlGeneration: 2,
    createdAt: Date.now() - 3600 * 1000, sourceFingerprint: C.sourceFingerprint(project),
    budget: { iterations: 2, activeSeconds: 3600, deadlineSeconds: 60, sameFailureLimit: 3, noProgressLimit: 5, autoDispatchCap: 40, toolActionCap: 140 },
    contract: { criteria: [{ id: 'c', required: true, checks: ['check'] }], gates: [{ id: 'check', required: true }], lossTarget: 0 },
    contractHash: 'retained-mapping', checkCatalogue: { check: { command: ['true'], kind: 'cmd', gate: true } },
    state: { candidates: [], lastEvalFingerprint: null }, receipts: [],
    execution: { commandAttempts: 0, verificationMs: 0, inFlight: null } };
  store.writeJSON(key, 'run.json', run);
  const bin = path.join(config, 'longrun-harness', 'releases', VERSION, 'bin', 'longrun.mjs');
  const invoke = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [bin, ...args], {
      cwd: root, env: { ...process.env, LONGRUN_TEST: '1', LONGRUN_STATE_DIR: state, OPENCODE_CONFIG_DIR: config },
      encoding: 'utf8', timeout: 10000, ...extra });
    assert.equal(result.error, undefined);
    return { exit: result.status, output: JSON.parse(result.stdout) };
  };
  const status = invoke(['status', '--json', '--project', project, '--run', runId]);
  assert.equal(status.exit, 0, JSON.stringify(status.output));
  assert.match(status.output.amendmentBasis, /^[a-f0-9]{64}$/);
  assert.equal(status.output.controlRevision, 2);
  assert.equal(status.output.budgetLimit.effective.iterations, 2);

  const authFile = path.join(root, 'authorization.txt'), reasonFile = path.join(root, 'reason.txt');
  fs.writeFileSync(authFile, GRANT.authorization); fs.writeFileSync(reasonFile, GRANT.reason);
  const amendArgs = ['amend', '--json', '--project', project, '--run', runId,
    '--amendment-id', 'grant-cli-fixture-0001', '--additional-candidates', '12',
    '--new-deadline', new Date(TEST_GRANT_DEADLINE).toISOString(),
    '--authorization-file', authFile, '--reason-file', reasonFile,
    '--expected-basis', status.output.amendmentBasis, '--expected-revision', String(status.output.controlRevision)];

  const missing = invoke(['amend', '--json', '--project', project, '--run', runId]);
  assert.equal(missing.exit, 2); assert.equal(missing.output.error, 'AMENDMENT_ARGUMENTS_REQUIRED');

  const before = fs.readFileSync(store._file(key, 'run.json'));
  const stale = invoke(['amend', '--json', '--project', project, '--run', runId,
    '--amendment-id', 'grant-cli-fixture-stale', '--additional-candidates', '12',
    '--new-deadline', new Date(TEST_GRANT_DEADLINE).toISOString(),
    '--authorization-file', authFile, '--reason-file', reasonFile,
    '--expected-basis', 'f'.repeat(64), '--expected-revision', '2']);
  assert.equal(stale.exit, 2); assert.equal(stale.output.error, 'AMENDMENT_BASIS_CHANGED');
  assert.deepEqual(fs.readFileSync(store._file(key, 'run.json')), before);

  const applied = invoke(amendArgs);
  assert.equal(applied.exit, 0, JSON.stringify(applied.output));
  assert.equal(applied.output.state, 'PAUSED');
  const after = store.readRun(key).run;
  assert.deepEqual(after.budget, run.budget);
  assert.equal(after.budgetAmendments.length, 1);
  assert.equal(C.execution.effectiveIterations(after), 14);
  assert.equal(after.status, 'PAUSED');
  assert.equal(after.controlGeneration, 3);
});
