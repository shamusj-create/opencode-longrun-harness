import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as C from '../src/controller.js';
import { install, VERSION } from '../src/install.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1212-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), config = path.join(root, 'config'), state = path.join(root, 'state');
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'value.txt'), 'fixture');
  install({ configDir: config });
  const store = new C.Store(state), runId = 'maintenance-fixture', key = C.stateKey(C.projectIdentity(project), runId);
  const run = { runId, directory: project, status: 'IMPLEMENTING', autoEnabled: false, controlGeneration: 4,
    createdAt: Date.now(), budget: { iterations: 2, deadlineSeconds: 600 },
    contract: { criteria: [], gates: [], lossTarget: 0 }, contractHash: 'retained-mapping',
    state: { candidates: [] }, receipts: [], execution: { commandAttempts: 0, verificationMs: 0, inFlight: null },
    agentProgress: { fields: { nextAction: 'preserve this plan' } } };
  store.writeJSON(key, 'run.json', run);
  const file = store._file(key, 'run.json');
  const invoke = action => {
    const result = spawnSync(process.execPath, [path.join(config, 'longrun-harness', 'releases', VERSION, 'bin', 'longrun.mjs'),
      action, '--json', '--project', project, '--run', runId], {
      cwd: root, env: { ...process.env, LONGRUN_TEST: '1', LONGRUN_STATE_DIR: state, OPENCODE_CONFIG_DIR: config },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    return { exit: result.status, output: JSON.parse(result.stdout) };
  };
  return { run, store, key, file, invoke };
}

test('installed maintenance pause preserves terminal state instead of resurrecting it', t => {
  const s = fixture(t);
  for (const status of ['COMPLETE', 'CANCELLED']) {
    s.store.writeJSON(s.key, 'run.json', { ...s.run, status });
    const before = fs.readFileSync(s.file), result = s.invoke('pause');
    assert.equal(result.exit, 2);
    assert.equal(result.output.error, `RUN_${status}`);
    assert.deepEqual(fs.readFileSync(s.file), before);
  }
});

test('installed maintenance pause respects an active verifier writer lock', t => {
  const s = fixture(t); assert.equal(s.store.tryLock(s.key, 'verifier'), true);
  const before = fs.readFileSync(s.file), holder = s.store.whoHoldsLock(s.key);
  try {
    const result = s.invoke('pause');
    assert.equal(result.exit, 2); assert.equal(result.output.error, 'STATE_BUSY');
    assert.deepEqual(fs.readFileSync(s.file), before);
    assert.deepEqual(s.store.whoHoldsLock(s.key), holder);
  } finally { s.store.releaseLock(s.key); }
});

test('installed maintenance pause advances the control generation and preserves all evidence', t => {
  const s = fixture(t), result = s.invoke('pause');
  assert.equal(result.exit, 0); assert.equal(result.output.state, 'PAUSED');
  const after = s.store.readJSON(s.key, 'run.json');
  assert.equal(after.controlGeneration, 5);
  assert.deepEqual(after, { ...s.run, status: 'PAUSED', autoEnabled: false, controlGeneration: 5 });
});

test('installed maintenance cannot call corrupt canonical state an absent run', t => {
  const s = fixture(t);
  for (const bytes of ['{broken', 'null', '[]']) {
    fs.writeFileSync(s.file, bytes);
    for (const action of ['status', 'pause']) {
      const result = s.invoke(action);
      assert.equal(result.exit, 2); assert.equal(result.output.error, 'STATE_CORRUPT');
      assert.equal(fs.readFileSync(s.file, 'utf8'), bytes);
    }
  }
});
