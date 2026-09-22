// v1.2.22 — a declared check that is mapped from a criterion with an evidenceClass should not
// silently lose its evidence class when the model omits the optional per-call argument.
//
// Reproduced twice on real runs (annotations lr-2b19ebf831af and Godot lr-9655ab9b321e): the final
// whole-suite round called longrun_verify without evidenceClass, every receipt became classless, and
// status reported loss 1 / required_unverified / UNKNOWN_CLASS even though all six checks PASSED.
//
// Fix: when args.evidenceClass is absent, derive the receipt class from the run's OWN contract when
// exactly one required criterion that maps this check declares an evidenceClass. Explicit arguments
// always win, and ambiguous mappings must NOT guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');

async function fixture(t, criteria) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1222-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'value.txt'), 'valid');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
  const ctx = { sessionID: 'evidence-class-fixture', directory: dir, worktree: dir };
  const command = [process.execPath, '-e', "require('node:assert/strict').match(require('node:fs').readFileSync('value.txt','utf8'),/^valid/)"];
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Isolated evidence-class regression', criteria, checkCatalogue: { check: { command, kind: 'cmd' }, gate: { command, kind: 'cmd', gate: true } } }, ctx));
  assert.ok(start.runId, JSON.stringify(start));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), start.runId);
  const read = () => { const r = store.readRun(key); assert.equal(r.error, undefined, JSON.stringify(r)); return r.run; };
  const verify = async (args = {}) => JSON.parse(await hooks.tool.longrun_verify.execute({ runId: start.runId, checkId: 'check', ...args }, ctx));
  return { dir, hooks, ctx, start, store, key, read, verify };
}

test('an omitted evidenceClass is derived from the criterion that maps the check', async t => {
  const s = await fixture(t, [{ id: 'c', checks: ['check'], evidenceClass: 'BROWSER' }]);
  const res = await s.verify();
  assert.equal(res.status, 'PASS', JSON.stringify(res));
  const receipt = s.read().receipts.at(-1);
  assert.equal(receipt.evidenceClass, 'BROWSER', 'derived class recorded on the receipt');
  const view = C.deriveRunView(s.read(), { currentFingerprint: s.read().sourceFingerprint });
  assert.equal(view.criterionStates.find(c => c.id === 'c').satisfied, true, 'criterion satisfied without a per-call argument');
});

test('an explicit evidenceClass still overrides the derived default', async t => {
  const s = await fixture(t, [{ id: 'c', checks: ['check'], evidenceClass: 'BROWSER' }]);
  const res = await s.verify({ evidenceClass: 'UNIT' });
  assert.equal(res.status, 'PASS', JSON.stringify(res));
  assert.equal(s.read().receipts.at(-1).evidenceClass, 'UNIT', 'explicit argument wins');
  const view = C.deriveRunView(s.read(), { currentFingerprint: s.read().sourceFingerprint });
  assert.equal(view.criterionStates.find(c => c.id === 'c').satisfied, false, 'a weaker explicit class does not satisfy a BROWSER criterion');
});

test('an ambiguous mapping is not guessed', async t => {
  const s = await fixture(t, [
    { id: 'c1', checks: ['check'], evidenceClass: 'BROWSER' },
    { id: 'c2', checks: ['check'], evidenceClass: 'UNIT' },
  ]);
  const res = await s.verify();
  assert.equal(res.status, 'PASS', JSON.stringify(res));
  assert.equal(s.read().receipts.at(-1).evidenceClass ?? null, null, 'ambiguous criteria must not auto-assign a class');
});

test('defaultEvidenceClass unit behaviour', () => {
  const run = { contract: { criteria: [
    { id: 'a', checks: ['x'], evidenceClass: 'INTEGRATION' },
    { id: 'b', checks: ['y'], evidenceClass: 'BROWSER' },
  ] } };
  assert.equal(C.defaultEvidenceClass(run, 'x'), 'INTEGRATION');
  assert.equal(C.defaultEvidenceClass(run, 'y'), 'BROWSER');
  assert.equal(C.defaultEvidenceClass(run, 'z'), null, 'unmapped check has no default');
  assert.equal(C.defaultEvidenceClass({ contract: { criteria: [{ id: 'a', checks: ['x'], evidenceClass: 'UNIT' }, { id: 'b', checks: ['x'], evidenceClass: 'BROWSER' }] } }, 'x'), null, 'conflicting classes are ambiguous');
  assert.equal(C.defaultEvidenceClass(run, 'x', 'SYSTEM'), 'SYSTEM', 'explicit argument wins');
});
