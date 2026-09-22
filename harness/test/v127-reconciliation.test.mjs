import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
async function setup({ delay = 0, negative = false, timeoutMs, executable = process.execPath } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr127-'));
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'before');
  const counter = path.join(base, 'commands.txt');
  const command = [executable, '-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)},'1');setTimeout(()=>require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'after'),${delay})`];
  const hooks = await F('../plugin/longrun.js', { client: null });
  const context = { sessionID: 'initial', directory: dir, worktree: dir };
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Real command reconciliation fixture', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check: { command, kind: 'cmd', negativeControl: true, timeoutMs } } }, context));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  fs.writeFileSync(path.join(dir, 'value.txt'), 'after');
  const call = async (action, args = {}, ctx = context) => hooks.tool.longrun.execute({ action, runId: start.runId, ...args }, ctx);
  const verify = async () => {
    const args = { checkId: 'check', runId: start.runId };
    if (negative) { args.mode = 'negative'; args.fixture = path.join(base, 'fixture'); fs.mkdirSync(args.fixture); fs.writeFileSync(path.join(args.fixture, 'value.txt'), 'broken'); }
    return JSON.parse(await hooks.tool.longrun_verify.execute(args, context));
  };
  const pending = async () => {
    const mutate = C.Store.prototype.mutate;
    C.Store.prototype.mutate = function(k, cb) {
      if (k === key && fs.readdirSync(this.keyPath(k)).some(n => /^execution-.*\.json$/.test(n))) return { error: 'STATE_BUSY' };
      return mutate.call(this, k, cb);
    };
    try { assert.equal((await verify()).error, 'RESULT_COMMIT_PENDING'); }
    finally { C.Store.prototype.mutate = mutate; }
    const token = store.readJSON(key, 'run.json').execution.inFlight.token;
    return { token, name: `execution-${token}.json`, journal: store.readJSON(key, `execution-${token}.json`) };
  };
  return { base, dir, counter, hooks, context, runId: start.runId, store, key, call, verify, pending };
}

test('a fresh session reconciles a genuine saved result once without rerunning or unpausing', async () => {
  const s = await setup(), { journal } = await s.pending();
  await s.call('checkpoint', { progress: { nextAction: 'review recovered evidence' } });
  await s.call('pause');
  const before = s.store.readJSON(s.key, 'run.json');
  const fresh = await F('../plugin/longrun.js', { client: null });
  const reconcile = () => fresh.tool.longrun.execute({ action: 'reconcile', runId: s.runId }, { ...s.context, sessionID: 'fresh' });
  const result = JSON.parse(await reconcile()); assert.equal(result.reconciled, true);
  const run = s.store.readJSON(s.key, 'run.json');
  assert.equal(run.status, 'PAUSED'); assert.equal(run.autoEnabled, false);
  assert.equal(run.agentProgress.fields.nextAction, 'review recovered evidence');
  assert.deepEqual(run.budget, before.budget); assert.equal(run.contractHash, before.contractHash);
  assert.equal(run.receipts.length, 1); assert.equal(run.receipts[0].status, 'PASS');
  assert.equal(C.candidateCount(run), 1); assert.equal(run.execution.commandAttempts, 1);
  assert.equal(run.execution.verificationMs, journal.result.finishedAt - journal.result.startedAt);
  assert.equal(run.execution.inFlight, null); assert.equal(fs.readFileSync(s.counter, 'utf8'), '1');
  const second = JSON.parse(await reconcile()); assert.equal(second.nothingPending, true);
  assert.equal(s.store.readJSON(s.key, 'run.json').receipts.length, 1);
  assert.equal(fs.readFileSync(s.counter, 'utf8'), '1');
});

test('reconciliation retains old-source evidence as stale and preserves terminal cancellation', async () => {
  const s = await setup(); await s.pending(); await s.call('cancel', { reason: 'fixture cancelled after command finished' });
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'newer source');
  assert.equal(JSON.parse(await s.call('reconcile')).reconciled, true);
  const view = JSON.parse(await s.call('status'));
  assert.equal(view.state, 'CANCELLED'); assert.equal(view.checks[0].effectiveStatus, 'STALE');
  assert.equal(view.historicalReceiptCount, 1); assert.equal(view.completionBlocked, true);
});

test('a recovered negative control remains separate from product receipts and candidates', async () => {
  const s = await setup({ negative: true }); await s.pending();
  assert.equal(JSON.parse(await s.call('reconcile')).reconciled, true);
  const run = s.store.readJSON(s.key, 'run.json');
  assert.equal(run.receipts.length, 0); assert.equal(C.candidateCount(run), 0);
  assert.equal(run.evidence.length, 1); assert.equal(run.evidence[0].observed, 'FAIL');
  assert.equal(run.execution.commandAttempts, 1); assert.equal(run.execution.inFlight, null);
  await s.call('reconcile'); assert.equal(s.store.readJSON(s.key, 'run.json').evidence.length, 1);
});

test('missing or inconsistent journals cannot release the reservation or manufacture a receipt', async () => {
  for (const corruption of ['missing', 'fingerprint', 'command', 'cleanup', 'exit']) {
    const s = await setup(), { name, journal } = await s.pending();
    if (corruption === 'missing') fs.rmSync(s.store._file(s.key, name));
    else {
      if (corruption === 'fingerprint') delete journal.receipt.sourceFingerprint;
      if (corruption === 'command') journal.receipt.argv = ['arbitrary'];
      if (corruption === 'cleanup') journal.result.cleanupComplete = false;
      if (corruption === 'exit') journal.result.status = 1;
      s.store.writeJSON(s.key, name, journal);
    }
    const before = fs.readFileSync(s.store._file(s.key, 'run.json'));
    const result = JSON.parse(await s.call('reconcile'));
    assert.match(result.error, /EXECUTION_RECORD|EXECUTION_CLEANUP/);
    assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
    assert.equal(fs.readFileSync(s.counter, 'utf8'), '1');
  }
});

test('live checks and a busy writer cannot be bypassed by reconciliation', async () => {
  const s = await setup({ delay: 600 }); const pending = s.verify();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.parse(await s.call('reconcile')).error, 'VERIFY_IN_FLIGHT');
  assert.equal((await pending).status, 'PASS');
  const p = await setup(); await p.pending(); p.store.tryLock(p.key, 'fixture-owner');
  try { assert.equal(JSON.parse(await p.call('reconcile')).error, 'STATE_BUSY'); }
  finally { p.store.releaseLock(p.key); }
  assert.equal(JSON.parse(await p.call('reconcile')).reconciled, true);
  assert.equal(p.store.readJSON(p.key, 'run.json').receipts.length, 1);
});

test('real timeouts and launch failures retain their status without fabricating successful work', async () => {
  for (const [options, expected] of [[{ delay: 5000, timeoutMs: 150 }, 'TIMEOUT'], [{ executable: '/longrun-no-such-executable' }, 'ERROR']]) {
    const s = await setup(options); await s.pending();
    const result = JSON.parse(await s.call('reconcile')); assert.equal(result.reconciled, true);
    const run = s.store.readJSON(s.key, 'run.json');
    assert.equal(run.receipts[0].status, expected); assert.equal(run.execution.commandAttempts, 1);
    if (expected === 'ERROR') { assert.equal(C.candidateCount(run), 0); assert.equal(fs.existsSync(s.counter), false); }
  }
});

test('legacy v1.2.6 result journals recover under an expired budget without restarting the run', async () => {
  const s = await setup(), { name, journal } = await s.pending();
  delete journal.runId; s.store.writeJSON(s.key, name, journal);
  s.store.mutate(s.key, run => { run.createdAt -= 86400000; run.status = 'RECOVERY_REQUIRED'; return { ok: true }; });
  const before = s.store.readJSON(s.key, 'run.json');
  assert.equal(JSON.parse(await s.call('reconcile')).reconciled, true);
  const run = s.store.readJSON(s.key, 'run.json');
  assert.equal(run.createdAt, before.createdAt); assert.deepEqual(run.budget, before.budget);
  assert.equal(run.status, 'RECOVERY_REQUIRED'); assert.equal(run.receipts.length, 1);
  assert.equal(JSON.parse(await s.call('resume')).error, 'BUDGET_EXHAUSTED');
});

test('an executor retry after reconciliation cannot charge or append the same result again', async () => {
  const s = await setup(), { journal } = await s.pending(); await s.call('reconcile');
  const before = s.store.readJSON(s.key, 'run.json');
  const retry = s.store.mutate(s.key, run => C.commitExecutionResult(run, journal));
  assert.equal(retry.alreadyRecorded, true); assert.equal(retry.apply.candidate.counted, false);
  assert.deepEqual(s.store.readJSON(s.key, 'run.json'), before);
});
