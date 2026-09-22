import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');

// Actual recorded, prematurely completed annotations trial. Read-only copied evidence;
// its real receipts are not fabricated, modified or written into a live store.
const actual = () => JSON.parse(fs.readFileSync(new URL('./fixtures/annotations-premature-complete-run.json', import.meta.url)));

test('actual all-green annotations record distinguishes check success from missing independent completion review', () => {
  const run = actual(), before = JSON.stringify(run);
  const view = C.deriveRunView(run, { currentFingerprint: run.sourceFingerprint });
  assert.equal(view.currentLoss, 0, 'retain the genuine declared-check calculation');
  assert.ok(view.checks.every(c => c.effectiveStatus === 'PASS'));
  assert.equal(view.completionBlocked, true, 'unreviewed checks cannot authorize completion');
  assert.equal(view.blockReason, 'completion_review_required');
  assert.equal(JSON.stringify(run), before, 'readouts preserve the recorded premature COMPLETE and all evidence');
});

test('offline plugin tool factory refuses premature completion after real passing command without changing lifecycle or evidence', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1218-review-'));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'app.txt'), 'fixture');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'offline-review', directory: dir, worktree: dir };
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Complete a reviewed feature; PAUSE for independent review, do not COMPLETE from checks alone.', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check: { command: [process.execPath, '-e', "require('node:assert/strict').equal(2+2,4)"], kind: 'cmd' } } }, ctx));
  assert.ok(start.runId);
  const pass = JSON.parse(await hooks.tool.longrun_verify.execute({ runId: start.runId, checkId: 'check' }, ctx));
  assert.equal(pass.status, 'PASS');
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  const before = store.readJSON(key, 'run.json');
  const completed = JSON.parse(await hooks.tool.longrun.execute({ action: 'complete', runId: start.runId }, ctx));
  assert.equal(completed.complete, false);
  assert.equal(completed.blockReason, 'completion_review_required');
  assert.deepEqual(store.readJSON(key, 'run.json'), before);
});

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1218-operator-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'app.txt'), 'valid');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'review-fixture', directory: dir, worktree: dir };
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Independent completion review fixture', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check: { command: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('app.txt','utf8'),'valid')"], kind: 'cmd' } } }, ctx));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  const read = () => store.readJSON(key, 'run.json');
  const call = async (action, extra = {}) => {
    const value = await hooks.tool.longrun.execute({ action, runId: start.runId, ...extra }, ctx);
    try { return JSON.parse(value); } catch { return value; }
  };
  const verify = async () => JSON.parse(await hooks.tool.longrun_verify.execute({ runId: start.runId, checkId: 'check' }, ctx));
  assert.equal((await verify()).status, 'PASS');
  await call('pause');
  const args = (verdict = 'accept', reviewId = 'operator-review-1') => ({ directory: dir, runId: start.runId, verdict, reviewId,
    reason: 'Independent offline fixture review', expectedBasis: C.completionReviewBasis(read(), C.sourceFingerprint(dir)) });
  return { base, dir, store, key, read, call, verify, args, hooks, ctx, start };
}

test('real checks plus paused operator approval permit completion; a model payload does not', async t => {
  const s = await fixture(t), before = s.read();
  assert.equal((await s.call('complete', { completionReview: { verdict: 'accept' } })).complete, false);
  assert.equal((await s.call('checkpoint', { progress: { completionReview: 'accepted' } })).error, 'INVALID_PROGRESS');
  assert.deepEqual(s.read(), before);
  const args = s.args();
  assert.equal((await C.operatorCompletionReview(s.store, s.key, args)).ok, true);
  assert.equal((await C.operatorCompletionReview(s.store, s.key, args)).alreadyRecorded, true);
  assert.equal(s.read().completionReviews.length, 1);
  assert.equal((await s.call('complete')).complete, true);
  assert.equal(s.read().status, 'COMPLETE');
});

test('approval binds source, request, contract, catalogue, budgets and genuine evidence', async t => {
  const s = await fixture(t);
  await C.operatorCompletionReview(s.store, s.key, s.args());
  const run = s.read(), fp = C.sourceFingerprint(s.dir);
  assert.equal(C.canComplete(run, { currentFingerprint: fp }).complete, true);
  for (const mutate of [r => r.originalRequest += ' changed', r => r.contract.extra = true,
    r => r.checkCatalogue.check.timeoutMs = 99, r => r.budget.iterations++, r => r.createdAt--,
    r => r.receipts.push({ ...r.receipts[0], finishedAt: Date.now() }), r => r.evidence = [{ kind: 'negative_control', ok: false }]]) {
    const clone = structuredClone(run); mutate(clone);
    assert.equal(C.completionReviewStatus(clone, fp).status, 'STALE');
    assert.equal(C.canComplete(clone, { currentFingerprint: fp }).complete, false);
  }
  fs.writeFileSync(path.join(s.dir, 'app.txt'), 'changed');
  assert.equal(C.completionReviewStatus(run, C.sourceFingerprint(s.dir)).status, 'STALE');
  fs.writeFileSync(path.join(s.dir, 'app.txt'), 'valid');
  await s.call('resume'); await s.verify();
  assert.equal((await s.call('complete')).blockReason, 'completion_review_stale');
});

test('completion recomputes source under the writer lock instead of trusting its initial view', async t => {
  const s = await fixture(t); await C.operatorCompletionReview(s.store, s.key, s.args());
  const original = C.Store.prototype.mutate; let changed = false;
  C.Store.prototype.mutate = function(key, callback) {
    if (key === s.key && !changed) { changed = true; fs.writeFileSync(path.join(s.dir, 'app.txt'), 'changed'); }
    return original.call(this, key, callback);
  };
  try { assert.equal((await s.call('complete')).error, 'EVIDENCE_CHANGED'); }
  finally { C.Store.prototype.mutate = original; }
  assert.equal(s.read().status, 'PAUSED');
});

test('rejecting copied premature COMPLETE archives every field and preserves exhausted budgets', async t => {
  const s = await fixture(t), run = actual();
  run.directory = s.dir; run.runId = s.start.runId;
  run.createdAt = Date.now() - run.budget.deadlineSeconds * 1000 - 1000;
  run.budget.iterations = C.candidateCount(run);
  s.store.writeJSON(s.key, 'run.json', run);
  const before = s.read(), args = s.args('reject');
  const result = await C.operatorCompletionReview(s.store, s.key, args);
  assert.equal(result.ok, true); assert.equal(result.state, 'PAUSED');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.archivedSnapshot)), before);
  const after = s.read();
  for (const key of Object.keys(before).filter(k => !['status', 'autoEnabled', 'controlGeneration', 'completionReviews'].includes(k)))
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.autoEnabled, false); assert.equal(after.controlGeneration, before.controlGeneration + 1);
  assert.equal(after.completionReviews[0].previousState, 'COMPLETE');
  const resumed = await s.call('resume'); assert.equal(resumed.error, 'BUDGET_EXHAUSTED'); assert.equal(resumed.spent.deadline, true);
  assert.equal(s.read().receipts.length, 26);
});

test('archive conflict, cancellation, in-flight work, stale basis and unready checks fail closed', async t => {
  const s = await fixture(t);
  const check = async (mutate, expected, verdict = 'accept', adjust = x => x) => {
    const original = s.read(); const run = structuredClone(original); mutate(run); s.store.writeJSON(s.key, 'run.json', run);
    const args = adjust(s.args(verdict)); const before = fs.readFileSync(s.store._file(s.key, 'run.json'));
    assert.equal((await C.operatorCompletionReview(s.store, s.key, args)).error, expected);
    assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
    s.store.writeJSON(s.key, 'run.json', original);
  };
  await check(r => r.status = 'CANCELLED', 'RUN_CANCELLED', 'reject');
  await check(r => r.execution.inFlight = { token: 'live' }, 'VERIFY_IN_FLIGHT');
  await check(r => r.receipts = [], 'REVIEW_CHECKS_NOT_READY');
  await check(r => r.status = 'IMPLEMENTING', 'REVIEW_REQUIRES_PAUSE');
  await check(() => {}, 'REVIEW_BASIS_CHANGED', 'accept', a => ({ ...a, expectedBasis: '0'.repeat(64) }));
  await check(() => {}, 'INVALID_COMPLETION_REVIEW', 'accept', a => ({ ...a, reviewId: '../outside' }));
  const archive = s.store._file(s.key, 'completion-review-operator-review-1.json'); fs.writeFileSync(archive, 'do not overwrite');
  await check(r => r.status = 'COMPLETE', 'REVIEW_ARCHIVE_FAILED', 'reject');
  assert.equal(fs.readFileSync(archive, 'utf8'), 'do not overwrite');
});

test('operator review uses the existing writer lock and cannot reopen beside a newer task', async t => {
  const s = await fixture(t), before = s.read();
  assert.equal(s.store.tryLock(s.key, 'held'), true);
  try { assert.equal((await C.operatorCompletionReview(s.store, s.key, s.args())).error, 'STATE_BUSY'); }
  finally { s.store.releaseLock(s.key); }
  assert.deepEqual(s.read(), before);
  const run = s.read(); run.status = 'COMPLETE'; s.store.writeJSON(s.key, 'run.json', run);
  const other = structuredClone(run); other.runId = 'another-active-run'; other.status = 'IMPLEMENTING';
  s.store.writeJSON(C.stateKey(C.projectIdentity(s.dir), other.runId), 'run.json', other);
  assert.equal((await C.operatorCompletionReview(s.store, s.key, s.args('reject'))).error, 'EXISTING_RUN');
  assert.deepEqual(s.read(), run);
});

test('failed canonical write preserves the archive but grants no review or lifecycle change', async t => {
  const s = await fixture(t), run = s.read(); run.status = 'COMPLETE'; s.store.writeJSON(s.key, 'run.json', run);
  const args = s.args('reject'), before = fs.readFileSync(s.store._file(s.key, 'run.json'));
  const write = s.store.writeJSON.bind(s.store);
  s.store.writeJSON = (key, name, value) => { if (name === 'run.json') throw new Error('injected write failure'); return write(key, name, value); };
  await assert.rejects(C.operatorCompletionReview(s.store, s.key, args), /injected write failure/);
  assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
  const archive = s.store._file(s.key, 'completion-review-operator-review-1.json');
  assert.deepEqual(fs.readFileSync(archive), before);
  s.store.writeJSON = write;
  assert.equal((await C.operatorCompletionReview(s.store, s.key, args)).ok, true);
  assert.deepEqual(fs.readFileSync(archive), before, 'retry never overwrites a different historical snapshot');
});

test('concurrent native new-task admission and operator rejection share one project slot', async t => {
  const s = await fixture(t), run = s.read(); run.status = 'COMPLETE'; s.store.writeJSON(s.key, 'run.json', run);
  const args = s.args('reject');
  const [review, started] = await Promise.all([
    C.operatorCompletionReview(s.store, s.key, args),
    s.hooks.tool.longrun.execute({ action: 'start', request: 'different task', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: run.checkCatalogue }, { ...s.ctx, sessionID: 'different-task' }).then(JSON.parse),
  ]);
  const runs = fs.readdirSync(path.join(s.store.dir, 'state')).filter(x => /^[a-f0-9]{32}$/.test(x)).map(key => s.store.readRun(key).run);
  assert.equal(runs.filter(r => !C.RUN_TERMINAL_STATES.includes(r.status)).length, 1);
  assert.ok(review.ok ? started.error === 'EXISTING_RUN' : review.error === 'EXISTING_RUN' && started.runId);
});

test('reviewed completion can be explicitly rejected and resumed with original identity and limits', async t => {
  const s = await fixture(t);
  await C.operatorCompletionReview(s.store, s.key, s.args());
  assert.equal((await s.call('complete')).complete, true);
  const before = s.read();
  assert.equal((await s.call('resume')).error, 'RUN_COMPLETE');
  const rejected = await C.operatorCompletionReview(s.store, s.key, { ...s.args('reject', 'operator-review-2'), reason: 'Independent review discovered an unmet requirement.' });
  assert.equal(rejected.ok, true); assert.deepEqual(JSON.parse(fs.readFileSync(rejected.archivedSnapshot)), before);
  assert.equal((await s.call('complete')).blockReason, 'completion_review_rejected');
  assert.equal((await s.call('resume')).resumed, true);
  assert.equal((await s.verify()).status, 'PASS');
  const after = s.read();
  for (const key of ['runId','originalRequest','contract','contractHash','budget','createdAt']) assert.deepEqual(after[key], before[key]);
  assert.equal(after.receipts.length, before.receipts.length + 1);
  assert.deepEqual(after.receipts.slice(0, -1), before.receipts);
  assert.equal(after.completionReviews.length, 2); assert.equal(after.autoEnabled, false);
  assert.equal((await s.call('complete')).complete, false);
});
