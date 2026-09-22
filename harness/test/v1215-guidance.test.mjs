import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';

process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1215-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project'); fs.mkdirSync(dir);
  process.env.LONGRUN_STATE_DIR = path.join(root, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'guidance', directory: dir, worktree: dir };
  const call = async args => hooks.tool.longrun.execute(args, ctx);
  const start = JSON.parse(await call({ action: 'start', request: 'Error guidance fixture', criteria: [{ id: 'assertion', checks: ['check'] }], checkCatalogue: { check: { command: ['node', '-e', 'process.exit(0)'] } } }));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  return { call, store, key };
}

test('actual rejected checkpoint shapes include usable correction and observed lifecycle without mutation', async t => {
  const s = await setup(t);
  for (const progress of ['recovered and paused', JSON.stringify({ summary: 'done', status: 'PAUSED' }), { nextAction: 'x'.repeat(1001) }]) {
    const before = s.store.readJSON(s.key, 'run.json');
    const result = JSON.parse(await s.call({ action: 'checkpoint', progress }));
    assert.equal(result.error, 'INVALID_PROGRESS');
    assert.equal(result.state, 'IMPLEMENTING');
    assert.equal(result.continuation, false);
    assert.equal(result.runId, before.runId);
    assert.equal(result.unchanged, true);
    assert.deepEqual(Object.keys(result.progressSchema.fields), ['currentSlice', 'nextAction', 'decisions', 'failedHypotheses', 'memoryNodes', 'artifacts']);
    assert.equal(result.progressSchema.fields.nextAction.maxLength, 1000);
    assert.equal(result.progressSchema.maxCombinedCharacters, 6000);
    assert.match(result.lifecycleGuidance, /OFF.*does not.*PAUSED/);
    assert.deepEqual(s.store.readJSON(s.key, 'run.json'), before);
    const copy = structuredClone(before);
    assert.equal(C.saveAgentProgress(copy, result.progressSchema.example).ok, true);
    assert.equal(copy.status, before.status);
  }
  await s.call({ action: 'pause' });
  const paused = JSON.parse(await s.call({ action: 'checkpoint', progress: { status: 'IMPLEMENTING' } }));
  assert.equal(paused.state, 'PAUSED');
  assert.equal(s.store.readJSON(s.key, 'run.json').status, 'PAUSED');
});

test('help points to actual paginated receipts and identifies attempt cap scope', async t => {
  const s = await setup(t), help = JSON.parse(await s.call({ action: 'help' }));
  assert.match(help.receiptInspection, /receipts/);
  assert.match(help.receiptInspection, /receiptId/);
  assert.match(help.executionLimits, /toolActionCap.*declared.check attempts/);
  assert.match(help.lifecycleGuidance, /OFF.*does not.*PAUSED/);
  const state = JSON.parse(await s.call({ action: 'status' }));
  assert.equal(state.state, 'IMPLEMENTING');
  assert.match(state.lifecycleGuidance, /OFF.*does not.*PAUSED/);
});
