import { reviewProjectFixture } from "./helper.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `lr126-${name}-`));
const command = ['node', '-e', "require('node:assert/strict').match(require('node:fs').readFileSync('value.txt','utf8'),/^good/)"];
async function setup(options = {}, check = { command, kind: 'cmd' }) {
  process.env.LONGRUN_STATE_DIR = tmp('state');
  const dir = tmp('project'); fs.writeFileSync(path.join(dir, 'value.txt'), 'baseline');
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'first', directory: dir, worktree: dir };
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Isolated execution regression', criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check }, ...options }, ctx));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = start.runId && C.stateKey(C.projectIdentity(dir), start.runId);
  const call = async (action, args = {}, context = ctx) => hooks.tool.longrun.execute({ action, runId: start.runId, ...args }, context);
  const verify = async (args = {}, context = ctx) => JSON.parse(await hooks.tool.longrun_verify.execute({ checkId: 'check', runId: start.runId, ...args }, context));
  return { dir, hooks, ctx, start, store, key, call, verify };
}

test('candidate cap blocks only a new source evaluation and survives a session rebind', async () => {
  const s = await setup({ candidateBudget: 1 });
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'good-one');
  assert.equal((await s.verify()).status, 'PASS');
  assert.equal((await s.verify()).candidateCounted, false);
  await s.call('pause'); await s.call('resume', {}, { ...s.ctx, sessionID: 'fresh' });
  fs.writeFileSync(path.join(s.dir, 'value.txt'), 'good-two');
  const refused = await s.verify({}, { ...s.ctx, sessionID: 'fresh' });
  assert.equal(refused.error, 'BUDGET_EXHAUSTED');
  assert.ok(refused.spent.candidates);
  const run = s.store.readJSON(s.key, 'run.json');
  assert.equal(C.candidateCount(run), 1); assert.equal(run.receipts.length, 2);
  assert.equal(run.budget.iterations, 1);
});

test('the real tool schema exposes finite budget and hard-gate inputs; invalid limits do not silently default', async () => {
  const s = await setup();
  for (const key of ['candidateBudget', 'timeBudgetHours', 'deadlineHours', 'toolActionCap', 'sameFailureThreshold', 'noProgressThreshold', 'hardGates', 'autoContinue']) assert.ok(s.hooks.tool.longrun.args[key], key);
  for (const options of [{ candidateBudget: 0 }, { candidateBudget: 1.5 }, { timeBudgetHours: 'garbage' }, { toolActionCap: -1 }]) {
    const bad = await setup(options); assert.equal(bad.start.error, 'INVALID_BUDGET');
  }
  const auto = await setup({ autoContinue: true }); assert.equal(auto.start.error, 'AUTO_CONTINUATION_UNAVAILABLE');
});

test('read-only receipt diagnostics expose exact command, exit and timestamps without making up absent legacy fields', async () => {
  const s = await setup(); fs.writeFileSync(path.join(s.dir, 'value.txt'), 'good');
  const result = await s.verify(); assert.equal(result.status, 'PASS');
  const view = JSON.parse(await s.call('status'));
  const receipt = JSON.parse(await s.call('receipts', { receiptId: view.checks[0].effectiveReceiptId })).receipt;
  assert.deepEqual(receipt.argv, command); assert.equal(receipt.exitCode, 0);
  assert.ok(receipt.finishedAt >= receipt.startedAt); assert.equal(receipt.outputTail, '');
  const run = s.store.readJSON(s.key, 'run.json');
  delete run.receipts[0].exitCode; delete run.receipts[0].command; delete run.receipts[0].argv;
  s.store.writeJSON(s.key, 'run.json', run);
  const legacyView = JSON.parse(await s.call('verify'));
  const legacy = JSON.parse(await s.call('receipts', { receiptId: legacyView.checks[0].effectiveReceiptId })).receipt;
  assert.equal(legacy.exitCode, null); assert.equal(legacy.command, null); assert.equal(legacy.argv, null);
});

test('deadline and command-attempt caps refuse execution, including a negative control', async () => {
  const s = await setup({ toolActionCap: 1 }); fs.writeFileSync(path.join(s.dir, 'value.txt'), 'good');
  assert.equal((await s.verify()).status, 'PASS');
  assert.equal((await s.verify()).error, 'BUDGET_EXHAUSTED');
  assert.equal(s.store.readJSON(s.key, 'run.json').receipts.length, 1);
  const d = await setup({}, { command, gate: true });
  const run = d.store.readJSON(d.key, 'run.json'); run.createdAt = Date.now() - run.budget.deadlineSeconds * 1000 - 1; d.store.writeJSON(d.key, 'run.json', run);
  const fixture = tmp('negative'); fs.writeFileSync(path.join(fixture, 'value.txt'), 'broken');
  const result = await d.verify({ mode: 'negative', fixture });
  assert.equal(result.error, 'BUDGET_EXHAUSTED'); assert.ok(result.spent.deadline);
  assert.equal((d.store.readJSON(d.key, 'run.json').evidence || []).length, 0);
});

test('active execution allowance caps a subprocess and records measured usage across reloads', async () => {
  const s = await setup({ timeBudgetHours: 0.00008 }, { command: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 5000, kind: 'cmd' });
  const start = Date.now(), result = await s.verify();
  assert.equal(result.status, 'TIMEOUT'); assert.ok(Date.now() - start < 2000);
  const run = s.store.readJSON(s.key, 'run.json');
  assert.ok(run.execution.verificationMs >= 200);
  assert.equal(run.execution.commandAttempts, 1);
  assert.equal((await s.verify()).error, 'BUDGET_EXHAUSTED');
  assert.equal(run.receipts[0].terminationReason, 'active_time_budget');
});

test('pause is responsive during a check; abort cannot overwrite pause or a concurrent checkpoint', async () => {
  const s = await setup({}, { command: ['node', '-e', 'setTimeout(()=>process.exit(0),1000)'], kind: 'cmd' });
  const pending = s.verify();
  await new Promise(resolve => setTimeout(resolve, 80));
  await s.call('checkpoint', { progress: { nextAction: 'inspect interrupted check' } });
  await s.call('pause');
  const result = await pending;
  assert.equal(result.status, 'ERROR');
  const run = s.store.readJSON(s.key, 'run.json');
  assert.equal(run.status, 'PAUSED'); assert.equal(run.agentProgress.fields.nextAction, 'inspect interrupted check');
  assert.equal(run.receipts[0].terminationReason, 'run_paused');
  assert.equal(run.receipts.length, 1);
});

test('concurrent verifier calls cannot both execute, and context cancellation terminates the owned child', async () => {
  const s = await setup({}, { command: ['node', '-e', 'setTimeout(()=>process.exit(0),600)'], kind: 'cmd' });
  const abort = new AbortController(); const pending = s.verify({}, { ...s.ctx, abort: abort.signal });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await s.verify()).error, 'VERIFY_IN_FLIGHT');
  abort.abort(); const result = await pending; assert.equal(result.status, 'ERROR');
  const run = s.store.readJSON(s.key, 'run.json'); assert.equal(run.receipts[0].terminationReason, 'aborted');
  assert.equal(run.execution.inFlight, null);
});

test('unlaunched and pre-aborted checks retain errors without spending a source candidate', async () => {
  for (const abortFirst of [false, true]) {
    const s = await setup({}, { command: [path.join(tmp('missing'), 'absent')], kind: 'cmd' });
    fs.writeFileSync(path.join(s.dir, 'value.txt'), 'new source');
    const controller = new AbortController(); if (abortFirst) controller.abort();
    const result = await s.verify({}, { ...s.ctx, abort: controller.signal });
    assert.equal(result.status, 'ERROR'); assert.equal(result.candidateCounted, false);
    const run = s.store.readJSON(s.key, 'run.json');
    assert.equal(run.receipts.length, 1); assert.equal(run.execution.commandAttempts, 1);
    assert.equal(C.candidateCount(run), 0); assert.equal(run.execution.inFlight, null);
  }
});

test('root exit cleans up its stubborn descendant and preserves the actual root result', async () => {
  const dir = tmp('child-cleanup'), pidFile = path.join(dir, 'child.pid');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),150)`;
  const before = Date.now();
  const result = await C.execution.runCommand([process.execPath, '-e', parent], { cwd: dir, timeoutMs: 3000 });
  assert.equal(result.status, 0); assert.equal(result.terminationReason, null);
  assert.ok(Date.now() - before < 2000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && C.execution.alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(C.execution.alive(pid), false, 'owned descendant exited');
});

test('closed descendant stdio cannot return PASS before a late source mutation and group cleanup', async () => {
  const pidFile = path.join(tmp('silent-child'), 'pid');
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync('value.txt','late mutation'),250);setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),100)`;
  const s = await setup({}, { command: [process.execPath, '-e', parent], kind: 'cmd' });
  const result = await s.verify();
  assert.equal(result.status, 'STALE', 'fingerprint comparison happens after owned descendants exit');
  assert.equal(C.execution.alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
  assert.equal(s.store.readJSON(s.key, 'run.json').execution.inFlight, null);
});

test('terminal state committed by another writer cannot be overwritten by stale lifecycle actions', async () => {
  for (const action of ['pause', 'resume', 'cancel', 'checkpoint', 'complete']) {
    const s = await setup(); fs.writeFileSync(path.join(s.dir, 'value.txt'), 'good');
    await s.verify();
    if (action === "complete") reviewProjectFixture(s.dir, s.start.runId);
    const mutate = C.Store.prototype.mutate; let intercepted = false;
    C.Store.prototype.mutate = function(key, callback) {
      if (!intercepted && key === s.key) {
        intercepted = true;
        mutate.call(this, key, run => { run.status = 'CANCELLED'; return { ok: true }; });
      }
      return mutate.call(this, key, callback);
    };
    try {
      const result = JSON.parse(await s.call(action, { progress: { nextAction: 'must not persist' } }));
      assert.equal(result.error, 'RUN_CANCELLED', action);
      const run = s.store.readJSON(s.key, 'run.json');
      assert.equal(run.status, 'CANCELLED'); assert.equal(run.agentProgress?.fields?.nextAction, undefined);
    } finally { C.Store.prototype.mutate = mutate; }
  }
});

test('legacy usage is a labelled lower bound and orphaned reservations fail closed without invented receipts', async () => {
  const s = await setup(); const run = s.store.readJSON(s.key, 'run.json');
  delete run.execution;
  run.receipts = [{ startedAt: 100, finishedAt: 180 }, { startedAt: 150, finishedAt: 200 }, {}];
  const usage = C.execution.usage(run);
  assert.equal(usage.verificationMs, 100); assert.equal(usage.commandAttempts, 3);
  assert.equal(usage.historicalUsageUnknown, true);
  C.execution.initialize(run);
  run.execution.inFlight = { token: 'interrupted-fixture', ownerPid: -1, childPid: null };
  s.store.writeJSON(s.key, 'run.json', run);
  const before = fs.readFileSync(s.store._file(s.key, 'run.json'));
  assert.equal((await s.verify()).error, 'EXECUTION_RECOVERY_REQUIRED');
  assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
});
