import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';

async function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1213-'));
  const project = path.join(base, 'project'), sd = path.join(base, 'state');
  fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'app.txt'), 'isolated readout');
  process.env.LONGRUN_STATE_DIR = sd;
  process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
  const run = JSON.parse(fs.readFileSync(new URL('./fixtures/presets-readout-run.json', import.meta.url)));
  run.directory = project;
  const store = new C.Store(sd), key = C.stateKey(C.projectIdentity(project), run.runId);
  store.writeJSON(key, 'run.json', run);
  fs.writeFileSync(path.join(sd, 'runs.json'), JSON.stringify({ offline: { runKey: key, directory: project, runId: run.runId } }));
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'offline', directory: project, worktree: project };
  return { run, project, store, key, hooks, ctx, call: args => hooks.tool.longrun.execute({ runId: run.runId, ...args }, ctx) };
}

test('observed 13-receipt readout stays usable without hiding stale or failed evidence', async () => {
  const s = await setup(), before = fs.readFileSync(s.store._file(s.key, 'run.json'));
  const full = C.deriveRunView(s.run, { currentFingerprint: C.sourceFingerprint(s.project) });
  const raw = await s.call({ action: 'status' }), status = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) < 24000, `status was ${Buffer.byteLength(raw)} bytes`);
  assert.ok(Math.max(...raw.split('\n').map(x => Buffer.byteLength(x))) < 8192);
  for (const k of ['state', 'currentLoss', 'bestLoss', 'remaining', 'candidateCount', 'historicalReceiptCount', 'completionBlocked', 'hardGateBlockers']) assert.deepEqual(status[k], full[k]);
  assert.deepEqual(status.checks.map(c => [c.checkId, c.effectiveStatus, c.selectedReceiptId, c.staleReason, c.historicalReceiptCount]),
    full.checks.map(c => [c.checkId, c.effectiveStatus, c.selectedReceiptId, c.staleReason, c.historicalReceiptCount]));
  assert.equal(status.receiptDetails.action, 'receipts');
  assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
});

test('receipt pages cover all genuine history once; individual retrieval retains actual failure output', async () => {
  const s = await setup(), before = fs.readFileSync(s.store._file(s.key, 'run.json'));
  const seen = []; let offset = 0;
  do {
    const page = JSON.parse(await s.call({ action: 'receipts', offset, limit: 4 }));
    assert.equal(page.ok, true); assert.equal(page.total, 13);
    assert.ok(page.receipts.length <= 4);
    seen.push(...page.receipts); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(seen.length, 13); assert.equal(new Set(seen.map(r => r.receiptId)).size, 13);
  const failure = seen.find(r => r.historicalStatus === 'FAIL' && r.checkId === 'c-presets-e2e'); assert.ok(failure);
  const detail = JSON.parse(await s.call({ action: 'receipts', receiptId: failure.receiptId }));
  assert.equal(detail.receipt.exitCode, 1);
  assert.equal(detail.receipt.outputTail, s.run.receipts[failure.order - 1].outputTail.slice(-6000));
  assert.equal(detail.receipt.classification, 'SOURCE_FINGERPRINT_MISMATCH');
  assert.equal(detail.receipt.historicalStatus, 'FAIL');
  assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
});

test('receipt selection and pagination fail clearly; detailed reads remain allowed while paused', async () => {
  const s = await setup();
  for (const args of [{ offset: -1 }, { limit: 0 }, { limit: 21 }, { offset: 0.5 }])
    assert.equal(JSON.parse(await s.call({ action: 'receipts', ...args })).error, 'INVALID_RECEIPT_PAGE');
  assert.equal(JSON.parse(await s.call({ action: 'receipts', receiptId: 'missing' })).error, 'RECEIPT_NOT_FOUND');
  const page = JSON.parse(await s.call({ action: 'receipts', checkId: 'c-presets-server' }));
  assert.equal(page.total, 2); assert.equal(page.receipts.length, 2);
  const before = s.store.readJSON(s.key, 'run.json'); before.status = 'PAUSED'; s.store.writeJSON(s.key, 'run.json', before);
  await s.hooks['tool.execute.before']({ tool: 'longrun', sessionID: s.ctx.sessionID }, { args: { action: 'receipts', runId: s.run.runId } });
  assert.equal(JSON.parse(await s.call({ action: 'receipts' })).ok, true);
  assert.equal(s.store.readJSON(s.key, 'run.json').status, 'PAUSED');
});

test('paging reaches history older than twenty receipts and never invents missing legacy fields', () => {
  // Synthetic offline ledger exercises pagination, not application acceptance.
  const run = { runId: 'offline-pages', sourceFingerprint: 'now', receipts: Array.from({ length: 47 }, (_, i) => ({
    checkId: 'legacy', status: 'FAIL', finishedAt: i + 1, command: 'offline fixture', exitCode: 1,
  })) };
  const before = JSON.stringify(run), ids = [];
  for (let offset = 0; offset < 47; offset += 20) ids.push(...C.receiptReadout(run, { offset, limit: 20 }).receipts.map(r => r.receiptId));
  assert.equal(ids.length, 47); assert.equal(new Set(ids).size, 47);
  const oldest = C.receiptReadout(run, { receiptId: ids[0] }).receipt;
  assert.equal(oldest.classification, 'LEGACY_STALE_MISSING_FINGERPRINT');
  assert.equal(oldest.receiptFingerprint, null); assert.equal(oldest.outputTail, null);
  assert.equal(JSON.stringify(run), before);
});
