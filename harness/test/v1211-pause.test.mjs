import { reviewProjectFixture } from "./helper.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');

async function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1211-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'unchanged');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
  const ctx = { sessionID: 'owner', directory: dir, worktree: dir }, other = { ...ctx, sessionID: 'other' };
  const run = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Isolated pause admission fixture',
    criteria: [{ id: 'check', evidenceClass: 'STATIC', checks: ['check'] }],
    checkCatalogue: { check: { kind: 'cmd', command: [process.execPath, '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'unchanged')"] } } }, ctx));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), run.runId), file = store._file(key, 'run.json');
  const call = (action, context = ctx) => hooks.tool.longrun.execute({ action, runId: run.runId }, context);
  const guard = (tool, args = {}, sessionID = ctx.sessionID) => hooks['tool.execute.before']({ tool, sessionID }, { args });
  return { hooks, ctx, other, call, guard, store, key, file, runId: run.runId };
}

test('pause from another host blocks ordinary execution despite the old session active flag', async t => {
  const s = await setup(t); await s.call('pause', s.other);
  const before = fs.readFileSync(s.file);
  for (const tool of ['bash', 'edit', 'write', 'apply_patch', 'task', 'batch', 'unknown_mcp_tool']) {
    await assert.rejects(s.guard(tool), /LONGRUN_RUN_PAUSED/);
  }
  assert.deepEqual(fs.readFileSync(s.file), before);
});

test('paused inspection, native checkpoint and authorized resume remain usable without resetting evidence', async t => {
  const s = await setup(t); await s.call('pause');
  const before = s.store.readJSON(s.key, 'run.json');
  for (const tool of ['read', 'glob', 'grep', 'list', 'skill', 'question', 'todowrite', 'longrun_verify']) await s.guard(tool);
  for (const action of ['help', 'status', 'next', 'resume-context', 'verify', 'checkpoint', 'pause', 'resume', 'cancel', 'reconcile']) await s.guard('longrun', { action });
  for (const action of ['memory_init', 'memory_refresh']) await assert.rejects(s.guard('longrun', { action }), /LONGRUN_RUN_PAUSED/);
  assert.equal(JSON.parse(await s.call('resume')).resumed, true);
  await s.guard('edit'); await s.guard('bash');
  const after = s.store.readJSON(s.key, 'run.json');
  for (const field of ['runId', 'createdAt', 'contract', 'contractHash', 'budget', 'state', 'receipts', 'execution']) assert.deepEqual(after[field], before[field], field);
  assert.equal(after.autoEnabled, false);
});

test('a fresh session in the paused project cannot mutate before explicit resume', async t => {
  const s = await setup(t); await s.call('pause');
  await assert.rejects(s.guard('write', {}, 'fresh'), /LONGRUN_RUN_PAUSED/);
  await s.guard('read', {}, 'fresh');
  assert.equal(JSON.parse(await s.call('resume', { ...s.ctx, sessionID: 'fresh' })).resumed, true);
  await s.guard('write', {}, 'fresh');
});

test('a tracked terminal run cannot continue ordinary implementation, but native new-task admission stays available', async t => {
  for (const action of ['cancel', 'complete']) {
    const s = await setup(t);
    if (action === 'complete') {
      const checked = JSON.parse(await s.hooks.tool.longrun_verify.execute({ runId: s.runId, checkId: 'check', evidenceClass: 'STATIC' }, s.ctx));
      assert.equal(checked.status, 'PASS');
      reviewProjectFixture(s.ctx.directory, s.runId);
    }
    const result = await s.call(action); if (action === 'complete') assert.equal(JSON.parse(result).complete, true);
    const before = fs.readFileSync(s.file);
    await assert.rejects(s.guard('bash'), action === 'complete' ? /LONGRUN_RUN_COMPLETE/ : /LONGRUN_RUN_CANCELLED/);
    await s.guard('longrun', { action: 'start' }); await s.guard('read');
    assert.deepEqual(fs.readFileSync(s.file), before);
  }
});

test('non-executing canonical states fail closed while existing compaction recovery keeps its diagnostic', async t => {
  for (const state of ['READY', 'BLOCKED', 'COMPACTING', 'RECOVERY_REQUIRED', 'INVALID_STATE']) {
    const s = await setup(t); s.store.mutate(s.key, r => { r.status = state; return { ok: true }; });
    const before = fs.readFileSync(s.file);
    await assert.rejects(s.guard('edit'), state === 'RECOVERY_REQUIRED' ? /LONGRUN_RECOVERY_REQUIRED/ : /LONGRUN_RUN_STALLED/);
    await s.guard('longrun', { action: 'status' }); await s.guard('read');
    assert.deepEqual(fs.readFileSync(s.file), before);
  }
});
