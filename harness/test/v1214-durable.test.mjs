import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('actual host death cleans the stubborn owned check and leaves genuine recoverable ERROR evidence', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1214-crash-')), dir = path.join(base, 'project');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'fixture');
  const host = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/durable-host.mjs'), base], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; host.stderr.on('data', d => diagnostics += d);
  const exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({ code, signal })));
  let childPid;
  try {
    for (let i = 0; i < 500 && !fs.existsSync(path.join(base, 'child')); i++) await sleep(10);
    assert.ok(fs.existsSync(path.join(base, 'child')), diagnostics);
    childPid = Number(fs.readFileSync(path.join(base, 'child'), 'utf8'));
    const runId = fs.readFileSync(path.join(base, 'run-id'), 'utf8');
    process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
    process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
    const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), runId);
    const reserved = store.readJSON(key, 'run.json');
    assert.equal(reserved.execution.inFlight.ownerPid, host.pid);
    assert.equal(reserved.execution.inFlight.childPid, childPid);
    host.kill('SIGKILL'); // Only our directly spawned offline host, never OpenCode/MTPLX.
    assert.equal((await exited).signal, 'SIGKILL');
    const token = reserved.execution.inFlight.token;
    let journal;
    for (let i = 0; i < 400; i++) {
      journal = store.readJSON(key, `execution-${token}.json`);
      if (journal && !C.execution.ownedWorkAlive(childPid)) break;
      await sleep(10);
    }
    assert.ok(journal, 'worker must persist real execution evidence after owner death');
    assert.equal(C.execution.ownedWorkAlive(childPid), false);
    assert.equal(journal.result.terminationReason, 'owner_lost');
    assert.equal(journal.receipt.status, 'ERROR');
    assert.equal(store.readJSON(key, 'run.json').receipts.length, 0, 'worker journals; explicit reconciliation owns ledger commit');
    const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
    const ctx = { sessionID: 'fresh-recovery', directory: dir, worktree: dir };
    const call = async action => JSON.parse(await hooks.tool.longrun.execute({ action, runId }, ctx));
    assert.equal((await call('reconcile')).reconciled, true);
    const after = store.readJSON(key, 'run.json');
    assert.equal(after.receipts.length, 1); assert.equal(after.receipts[0].status, 'ERROR');
    assert.equal(after.execution.commandAttempts, 1); assert.equal(after.execution.inFlight, null);
    assert.equal(after.execution.verificationMs, journal.result.finishedAt - journal.result.startedAt);
    assert.deepEqual(after.budget, reserved.budget); assert.deepEqual(after.contract, reserved.contract);
    assert.equal(after.createdAt, reserved.createdAt); assert.equal(after.autoEnabled, false);
    assert.equal((await call('reconcile')).nothingPending, true);
    assert.equal(store.readJSON(key, 'run.json').receipts.length, 1);
  } finally {
    // Baseline failure must not strand the deliberately stubborn fixture.
    if (childPid && C.execution.ownedWorkAlive(childPid)) { try { process.kill(-childPid, 'SIGKILL'); } catch {} }
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await exited;
  }
});

test('host killed after actual completion preserves PASS and commits exactly once without rerunning', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1214-finished-')), dir = path.join(base, 'project');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'fixture');
  const host = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/durable-host.mjs'), base, 'complete'], { stdio: 'ignore' });
  const exited = new Promise(resolve => host.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    for (let i = 0; i < 500 && !fs.existsSync(path.join(base, 'run-id')); i++) await sleep(10);
    const runId = fs.readFileSync(path.join(base, 'run-id'), 'utf8');
    process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
    process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
    const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), runId);
    let journal;
    for (let i = 0; i < 500 && !journal; i++) {
      const token = store.readJSON(key, 'run.json').execution.inFlight?.token;
      if (token) journal = store.readJSON(key, `execution-${token}.json`);
      if (!journal) await sleep(10);
    }
    assert.ok(journal); assert.equal(journal.receipt.status, 'PASS');
    assert.equal(journal.result.status, 0); assert.match(journal.receipt.outputTail, /actual assertion passed/);
    host.kill('SIGKILL'); assert.equal((await exited).signal, 'SIGKILL');
    const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
    const ctx = { sessionID: 'after-crash', directory: dir, worktree: dir };
    const reconcile = async () => JSON.parse(await hooks.tool.longrun.execute({ action: 'reconcile', runId }, ctx));
    assert.equal((await reconcile()).reconciled, true);
    const before = fs.readFileSync(store._file(key, 'run.json'));
    assert.equal((await reconcile()).nothingPending, true);
    assert.deepEqual(fs.readFileSync(store._file(key, 'run.json')), before);
    const run = store.readJSON(key, 'run.json');
    assert.equal(run.receipts.length, 1); assert.equal(run.execution.commandAttempts, 1);
    assert.equal(run.execution.verificationMs, journal.result.finishedAt - journal.result.startedAt);
    assert.equal(run.receipts[0].status, 'PASS');
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await exited;
  }
});

test('a live executor reservation cannot be bypassed before it records a child PID', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1214-reservation-')), dir = path.join(base, 'project');
  fs.mkdirSync(dir);
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
  const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
  const ctx = { sessionID: 'reservation-test', directory: dir, worktree: dir };
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Offline executor reservation fixture',
    criteria: [{ id: 'c', checks: ['check'] }], checkCatalogue: { check: { command: [process.execPath, '-e', 'throw Error("must not launch")'] } } }, ctx));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  const worker = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  try {
    store.mutate(key, run => { run.execution.commandAttempts = 1;
      run.execution.inFlight = { token: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', ownerPid: -1, executorPid: worker.pid, childPid: null,
        checkId: 'check', mode: 'normal', startedAt: Date.now(), generation: 0 }; return { ok: true }; });
    const before = fs.readFileSync(store._file(key, 'run.json'));
    assert.equal(JSON.parse(await hooks.tool.longrun_verify.execute({ checkId: 'check', runId: start.runId }, ctx)).error, 'VERIFY_IN_FLIGHT');
    assert.equal(JSON.parse(await hooks.tool.longrun.execute({ action: 'reconcile', runId: start.runId }, ctx)).error, 'VERIFY_IN_FLIGHT');
    assert.deepEqual(fs.readFileSync(store._file(key, 'run.json')), before);
  } finally { worker.kill('SIGTERM'); await exited; }
});
