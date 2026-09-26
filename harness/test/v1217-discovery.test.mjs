import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';

const observed = JSON.parse(fs.readFileSync(new URL('./fixtures/notes-recovery-run.json', import.meta.url)));
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');

async function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1217-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir);
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const ctx = { sessionID: 'recovery', directory: dir, worktree: dir };
  const hooks = await F('../plugin/longrun.js', ctx), store = new C.Store(process.env.LONGRUN_STATE_DIR);
  // Actual failed-recovery record; only the fixture's project identity is relocated.
  const run = structuredClone(observed); run.directory = dir;
  const add = value => {
    const key = C.stateKey(C.projectIdentity(value.directory), value.runId);
    store.writeJSON(key, 'run.json', value); return key;
  };
  const key = add(run), bytes = () => fs.readFileSync(store._file(key, 'run.json'));
  return { hooks, ctx, run, add, bytes, dir, base };
}

test('copied native wrong-ID reads expose exact canonical recovery identity without changing the run', async t => {
  const s = await setup(t), before = s.bytes();
  for (const action of ['status', 'receipts', 'resume-context', 'resume', 'pause', 'cancel', 'complete']) {
    const out = JSON.parse(await s.hooks.tool.longrun.execute({ action, runId: 'lr-20260920T195102Z' }, s.ctx));
    assert.equal(out.state, 'NO_RUN'); assert.equal(out.runId, 'lr-20260920T195102Z');
    assert.deepEqual(out.discovery.suggestedRead, { action: 'resume-context', runId: observed.runId });
    assert.deepEqual(out.discovery.availableRuns, [{ runId: observed.runId, state: 'RECOVERY_REQUIRED' }]);
    assert.match(out.discovery.detail, /never.*replacement/i);
    assert.deepEqual(s.bytes(), before, action);
  }
  assert.equal(s.run.receipts.length, 6); assert.equal(s.run.state.candidates.length, 5);
});

test('wrong-ID verification remains NO_RUN and only offers project-local discovery', async t => {
  const s = await setup(t), before = s.bytes();
  const foreign = path.join(s.base, 'foreign'); fs.mkdirSync(foreign);
  s.add({ ...s.run, runId: 'lr-foreign-private', directory: foreign });
  const out = JSON.parse(await s.hooks.tool.longrun_verify.execute({ runId: 'lr-foreign-private', checkId: 'c-notes-server' }, s.ctx));
  assert.equal(out.error, 'NO_RUN'); assert.equal(out.ok, false);
  assert.deepEqual(out.discovery.availableRuns, [{ runId: observed.runId, state: 'RECOVERY_REQUIRED' }]);
  assert.deepEqual(out.discovery.suggestedRead, { action: 'resume-context', runId: observed.runId });
  assert.deepEqual(s.bytes(), before);
});

test('ambiguous recovery discovery is bounded and never recommends an arbitrary run', async t => {
  const s = await setup(t), before = s.bytes();
  for (let i = 0; i < 8; i++) s.add({ ...s.run, runId: `lr-extra-${i}` });
  const out = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'status', runId: 'wrong' }, s.ctx));
  assert.equal(out.discovery.totalRuns, 9); assert.equal(out.discovery.truncated, true);
  assert.equal(out.discovery.availableRuns.length, 5); assert.equal(out.discovery.suggestedRead, null);
  assert.match(out.discovery.detail, /multiple/i); assert.ok(JSON.stringify(out).length < 2200);
  assert.deepEqual(s.bytes(), before);
});

test('terminal-only and empty discovery do not invent resumable work', async t => {
  const s = await setup(t);
  s.add({ ...s.run, status: 'COMPLETE' });
  let out = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'status', runId: 'wrong' }, s.ctx));
  assert.deepEqual(out.discovery.suggestedRead, { action: 'status', runId: s.run.runId });
  assert.match(out.discovery.detail, /terminal/i);
  const empty = path.join(s.base, 'empty'); fs.mkdirSync(empty);
  out = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'status', runId: 'wrong' }, { ...s.ctx, directory: empty, worktree: empty }));
  assert.equal(out.discovery.totalRuns, 0); assert.equal(out.discovery.suggestedRead, null);
  assert.deepEqual(out.discovery.availableRuns, []);
});
