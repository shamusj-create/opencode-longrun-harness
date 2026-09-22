import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');

async function fixture(t, budget = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1219-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'baseline');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
  const ctx = { sessionID: 'budget-fixture', directory: dir, worktree: dir };
  const command = [process.execPath, '-e', "require('node:assert/strict').match(require('node:fs').readFileSync('value.txt','utf8'),/^valid/)"];
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Isolated budget-refusal stopping regression', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check: { command, kind: 'cmd', gate: true } }, ...budget }, ctx));
  assert.ok(start.runId);
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  const read = () => store.readJSON(key, 'run.json');
  const verify = async (args = {}) => JSON.parse(await hooks.tool.longrun_verify.execute({ runId: start.runId, checkId: 'check', ...args }, ctx));
  return { base, dir, hooks, ctx, start, store, key, read, verify };
}
function preservedPause(before, after) {
  assert.equal(after.status, 'PAUSED'); assert.equal(after.autoEnabled, false);
  assert.equal(after.controlGeneration, (before.controlGeneration || 0) + 1);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!['status', 'autoEnabled', 'controlGeneration'].includes(key)) assert.deepEqual(after[key], before[key], key);
  }
}

test('actual copied annotations refusal pauses without rewriting 24 candidates, 37 receipts or missing evidence', async t => {
  const s = await fixture(t);
  const run = JSON.parse(fs.readFileSync(new URL('./fixtures/annotations-budget-exhausted-run.json', import.meta.url)));
  assert.equal(run.status, 'IMPLEMENTING'); assert.equal(C.candidateCount(run), 24); assert.equal(run.receipts.length, 37);
  // Relocation only: genuine catalogue and evidence remain historical. Budget
  // refusal prevents these application commands from running in this tiny copy.
  run.directory = s.dir; run.runId = s.start.runId;
  s.store.writeJSON(s.key, 'run.json', run);
  // A fresh factory discovers canonical catalogue instead of fixture routing.
  fs.writeFileSync(path.join(s.store.dir, 'runs.json'), '{}');
  const hooks = await F('../plugin/longrun.js', { client: null, directory: s.dir, worktree: s.dir });
  const result = JSON.parse(await hooks.tool.longrun_verify.execute({ runId: run.runId, checkId: Object.keys(run.checkCatalogue)[0] }, { ...s.ctx, sessionID: 'fresh-copy' }));
  assert.equal(result.error, 'BUDGET_EXHAUSTED'); assert.equal(result.spent.candidates, true);
  assert.equal(result.state, 'PAUSED'); assert.equal(result.cancelledContinuations, true);
  preservedPause(run, s.read());
});

test('last counted candidate can finish checks; new source refusal stops edits across stale routing and fresh hosts', async t => {
  const s = await fixture(t, { candidateBudget: 1 });
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'valid-one');
  assert.equal((await s.verify()).status, 'PASS');
  assert.equal((await s.verify()).status, 'PASS');
  assert.equal(s.read().status, 'IMPLEMENTING'); assert.equal(C.candidateCount(s.read()), 1);
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'valid-two');
  const before = s.read();
  assert.equal((await s.verify()).error, 'BUDGET_EXHAUSTED');
  preservedPause(before, s.read());
  const frozen = fs.readFileSync(s.store._file(s.key, 'run.json'));
  assert.equal((await s.verify()).error, 'RUN_PAUSED');
  assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), frozen);
  const fresh = await F('../plugin/longrun.js', { client: null, directory: s.dir, worktree: s.dir });
  for (const [hooks, sessionID] of [[s.hooks, s.ctx.sessionID], [fresh, 'fresh-unbound']]) {
    for (const tool of ['edit', 'bash', 'task']) await assert.rejects(hooks['tool.execute.before']({ tool, sessionID }, { args: {} }), /LONGRUN_RUN_PAUSED/);
    await hooks['tool.execute.before']({ tool: 'longrun', sessionID }, { args: { action: 'status' } });
  }
});

test('deadline, attempt and active-time refusals pause normal and negative checks without spending anything', async t => {
  for (const reason of ['deadline', 'toolActions', 'activeSeconds']) {
    const s = await fixture(t), run = s.read();
    if (reason === 'deadline') run.createdAt -= run.budget.deadlineSeconds * 1000 + 1000;
    if (reason === 'toolActions') run.budget.toolActionCap = run.execution.commandAttempts;
    if (reason === 'activeSeconds') run.budget.activeSeconds = 0;
    s.store.writeJSON(s.key, 'run.json', run);
    const dir = path.join(s.base, 'negative'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'invalid');
    const result = await s.verify(reason === 'deadline' ? { mode: 'negative', fixture: dir } : {});
    assert.equal(result.error, 'BUDGET_EXHAUSTED'); assert.equal(result.spent[reason], true);
    preservedPause(run, s.read());
  }
});

test('terminal, paused and live or orphaned reservations take precedence over exhaustion', async t => {
  for (const [status, inFlight, expected] of [
    ['PAUSED', null, 'RUN_PAUSED'], ['COMPLETE', null, 'RUN_COMPLETE'], ['CANCELLED', null, 'RUN_CANCELLED'],
    ['IMPLEMENTING', { ownerPid: process.pid }, 'VERIFY_IN_FLIGHT'],
    ['IMPLEMENTING', { ownerPid: -1, childPid: null }, 'EXECUTION_RECOVERY_REQUIRED'],
  ]) {
    const s = await fixture(t), run = s.read();
    run.status = status; run.budget.activeSeconds = 0; run.execution.inFlight = inFlight;
    s.store.writeJSON(s.key, 'run.json', run);
    const before = fs.readFileSync(s.store._file(s.key, 'run.json'));
    assert.equal((await s.verify()).error, expected);
    assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
  }
});

test('refusal uses writer lock and never reports a pause if canonical write fails', async t => {
  const s = await fixture(t), run = s.read(); run.budget.activeSeconds = 0; s.store.writeJSON(s.key, 'run.json', run);
  const before = fs.readFileSync(s.store._file(s.key, 'run.json'));
  s.store.tryLock(s.key, 'concurrent-writer');
  try { assert.equal((await s.verify()).error, 'STATE_BUSY'); }
  finally { s.store.releaseLock(s.key); }
  const write = C.Store.prototype.writeJSON;
  C.Store.prototype.writeJSON = function(key, name, value) {
    if (key === s.key && name === 'run.json') throw new Error('injected canonical write failure');
    return write.call(this, key, name, value);
  };
  try { await assert.rejects(s.verify(), /injected canonical write failure/); }
  finally { C.Store.prototype.writeJSON = write; }
  assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
  assert.equal(s.store.whoHoldsLock(s.key), null);
  assert.equal((await s.verify()).state, 'PAUSED');
});

test('a concurrent cancellation wins; competing budget refusals increment pause generation only once', async t => {
  const s = await fixture(t), initial = s.read(); initial.budget.activeSeconds = 0; s.store.writeJSON(s.key, 'run.json', initial);
  const mutate = C.Store.prototype.mutate; let intercepted = false;
  C.Store.prototype.mutate = function(key, callback) {
    if (key === s.key && !intercepted) {
      intercepted = true;
      mutate.call(this, key, run => { run.status = 'CANCELLED'; return { ok: true }; });
    }
    return mutate.call(this, key, callback);
  };
  try { assert.equal((await s.verify()).error, 'RUN_CANCELLED'); }
  finally { C.Store.prototype.mutate = mutate; }
  assert.deepEqual(s.read(), { ...initial, status: 'CANCELLED' });
  s.store.writeJSON(s.key, 'run.json', initial);
  const results = await Promise.all([s.verify(), s.verify()]);
  assert.deepEqual(results.map(r => r.error).sort(), ['BUDGET_EXHAUSTED', 'RUN_PAUSED']);
  preservedPause(initial, s.read());
});
