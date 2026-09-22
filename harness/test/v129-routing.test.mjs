import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { F } from './helper.mjs';
import * as C from '../src/controller.js';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
const request = { action: 'start', request: 'Routing integrity fixture', criteria: [{ id: 'c', checks: ['check'], evidenceClass: 'STATIC' }], checkCatalogue: { check: { command: [process.execPath, '-e', 'require("node:assert/strict").equal(2+2,4)'], kind: 'cmd' } } };
function base() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr129-'));
  for (const d of ['A', 'B', 'state']) fs.mkdirSync(path.join(root, d));
  for (const d of ['A', 'B']) fs.writeFileSync(path.join(root, d, 'source.txt'), d);
  return root;
}
async function setup() {
  const root = base(), state = path.join(root, 'state'), dir = path.join(root, 'A');
  process.env.LONGRUN_STATE_DIR = state;
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'A', directory: dir, worktree: dir };
  const call = async (args, context = ctx) => JSON.parse(await hooks.tool.longrun.execute(args, context));
  return { root, state, dir, hooks, ctx, call };
}
async function race(root, mode) {
  const children = [];
  function start(label) {
    let output = '', error = '';
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/routing-worker.mjs'), root, label, mode], { env: { ...process.env, LONGRUN_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output.trim().split('\n').map(JSON.parse).find(x => x.result).result) : reject(new Error(error || `child exit ${code}`)));
    });
    const critical = new Promise(resolve => child.stdout.on('data', d => { output += d; if (output.includes('"critical":true')) resolve(); }));
    child.stderr.on('data', d => error += d);
    return { done, critical };
  }
  let timeout;
  try {
    return await Promise.race([(async () => {
      const a = start('A');
      await Promise.race([a.critical, a.done.then(() => { throw new Error('race boundary not reached'); })]);
      const b = start('B');
      return await Promise.all([a.done, b.done]);
    })(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('routing race timed out')), 15000); })]);
  } finally {
    clearTimeout(timeout);
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  }
}
function canonicalRuns(root) {
  const dir = path.join(root, 'state/state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(k => { try { return [JSON.parse(fs.readFileSync(path.join(dir, k, 'run.json')))]; } catch { return []; } });
}

test('concurrent hosts starting different projects preserve both session bindings', async () => {
  const root = base();
  try {
    const results = await race(root, 'different-projects');
    assert.ok(results.every(r => r.runId), JSON.stringify(results));
    const bindings = JSON.parse(fs.readFileSync(path.join(root, 'state/runs.json')));
    assert.deepEqual(Object.keys(bindings).sort(), ['A', 'B']);
    assert.equal(canonicalRuns(root).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('concurrent start admission cannot create two active runs for one project', async () => {
  const root = base();
  try {
    const results = await race(root, 'same-project');
    assert.equal(results.filter(r => !r.error && r.runId).length, 1, JSON.stringify(results));
    assert.equal(results.filter(r => r.error === 'EXISTING_RUN').length, 1);
    assert.equal(canonicalRuns(root).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt routing indices fail explicitly without being replaced by an empty map', async () => {
  for (const filename of ['runs.json', 'projects.json']) {
    const s = await setup(), file = path.join(s.state, filename);
    try {
      fs.writeFileSync(file, '{ preserved corrupt bytes');
      const result = await s.call(request);
      assert.equal(result.error, 'ROUTING_STORE_ERROR');
      assert.equal(fs.readFileSync(file, 'utf8'), '{ preserved corrupt bytes');
      assert.equal(canonicalRuns(s.root).length, 0);
      await assert.rejects(s.hooks['tool.execute.before']({ sessionID: 'A', tool: 'bash' }), /ROUTING_STORE_ERROR/);
    } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
  }
});

test('canonical run survives missing routing indices and an authorized resume repairs the binding', async () => {
  const s = await setup();
  try {
    const started = await s.call(request), runId = started.runId;
    const before = canonicalRuns(s.root)[0];
    fs.unlinkSync(path.join(s.state, 'runs.json')); fs.unlinkSync(path.join(s.state, 'projects.json'));
    const fresh = { ...s.ctx, sessionID: 'fresh' };
    const found = await s.call({ action: 'status', runId }, fresh);
    assert.equal(found.state, 'IMPLEMENTING'); assert.equal(found.runId, runId);
    assert.equal((await s.call(request, fresh)).error, 'EXISTING_RUN');
    assert.equal((await s.call({ action: 'resume', runId }, fresh)).resumed, true);
    const after = canonicalRuns(s.root)[0];
    for (const key of ['runId', 'contract', 'contractHash', 'budget', 'receipts', 'createdAt']) assert.deepEqual(after[key], before[key]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.state, 'runs.json'))).fresh.runId, runId);
    assert.equal(canonicalRuns(s.root).length, 1);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('a session binding cannot authorize a lifecycle mutation from a foreign project', async () => {
  const s = await setup();
  try {
    const started = await s.call(request), before = canonicalRuns(s.root)[0];
    const foreign = { ...s.ctx, directory: path.join(s.root, 'B'), worktree: path.join(s.root, 'B') };
    assert.equal((await s.call({ action: 'cancel', runId: started.runId }, foreign)).state, 'NO_RUN');
    assert.deepEqual(canonicalRuns(s.root)[0], before);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('an interrupted index write reports failure and does not lose the canonical run on retry', async () => {
  const s = await setup(), original = fs.renameSync;
  try {
    fs.renameSync = function(from, to, ...rest) {
      if (String(to) === path.join(s.state, 'projects.json')) throw Object.assign(new Error('isolated index failure'), { code: 'EACCES' });
      return original.call(this, from, to, ...rest);
    };
    const first = await s.call(request);
    assert.equal(first.error, 'ROUTING_STORE_ERROR');
    fs.renameSync = original;
    const runId = canonicalRuns(s.root)[0].runId;
    const fresh = { ...s.ctx, sessionID: 'fresh' };
    assert.equal((await s.call(request, fresh)).error, 'EXISTING_RUN');
    assert.equal((await s.call({ action: 'resume', runId }, fresh)).resumed, true);
    assert.equal(canonicalRuns(s.root).length, 1);
  } finally { fs.renameSync = original; fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('a corrupt canonical record is not treated as absence and replaced by a new run', async () => {
  const s = await setup();
  try {
    const started = await s.call(request);
    const file = path.join(s.state, 'state', C.stateKey(C.projectIdentity(s.dir), started.runId), 'run.json');
    fs.writeFileSync(file, '{ preserved canonical corruption');
    const result = await s.call(request, { ...s.ctx, sessionID: 'fresh' });
    assert.equal(result.error, 'ROUTING_STORE_ERROR');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ preserved canonical corruption');
    assert.equal(fs.readdirSync(path.join(s.state, 'state')).length, 1);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('an existing routing lock is preserved on bounded contention and an exact retry succeeds after release', async () => {
  const s = await setup();
  const lock = path.join(s.state, 'ROUTING.lock'), bytes = JSON.stringify({ pid: process.pid, token: 'other-owner' });
  try {
    fs.writeFileSync(lock, bytes);
    const result = await s.call(request);
    assert.equal(result.error, 'ROUTING_BUSY');
    assert.equal(fs.readFileSync(lock, 'utf8'), bytes);
    assert.equal(canonicalRuns(s.root).length, 0);
    fs.unlinkSync(lock); // fixture owner releases its own lock, never a guessed production PID
    assert.ok((await s.call(request)).runId);
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});
