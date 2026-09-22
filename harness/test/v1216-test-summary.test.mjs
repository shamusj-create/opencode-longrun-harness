import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as C from '../src/controller.js';

test('recorded failing Vitest summary is readable without replacing historical acceptance evidence', () => {
  const observed = JSON.parse(fs.readFileSync(new URL('./fixtures/vitest-failed-receipt.json', import.meta.url)));
  const r = observed.receipt;
  const run = { runId: observed.runId, contractHash: r.contractHash, receipts: [r] };
  const before = JSON.stringify(run);
  const detailed = C.receiptReadout(run, { receiptId: C.receiptReadout(run).receipts[0].receiptId }).receipt;
  assert.equal(detailed.historicalStatus, 'FAIL');
  assert.equal(detailed.testCount, 0);
  assert.deepEqual(detailed.reportedTests, {
    source: 'recorded_output_tail', runner: 'vitest', total: 15, passed: 14, failed: 1,
    skipped: null, todo: null, summary: 'Tests  1 failed | 14 passed (15)',
  });
  assert.match(detailed.testCountMeaning, /zero.*not.*zero discovered/i);
  assert.equal(JSON.stringify(run), before);
  assert.equal(C.effectiveStatus(run, r.checkId, r.sourceFingerprint), 'FAIL');
});

test('summary diagnostics decline ambiguous or incomplete output and never change acceptance', () => {
  const report = outputTail => C.receiptReadout({ receipts: [{ checkId: 'c', status: 'NOT_RUN', testCount: 0, outputTail }] }).receipts[0];
  for (const text of [undefined, '', 'Test Files  1 failed (1)', 'Error: Tests  1 failed (1)',
    'Tests  1 failed | 14 passed (16)', 'Tests  1 failed (1)\nTests  2 passed (2)',
    'Tests  1 failed | 14 unknown (15)', 'Tests  1 failed | 1 failed (2)']) {
    assert.equal(report(text).reportedTests, null);
  }
  const ansi = report('\u001b[31m      Tests  2 passed | 1 skipped (3)\u001b[0m');
  assert.equal(ansi.reportedTests.total, 3);
  assert.equal(ansi.reportedTests.passed, 2);
  assert.equal(ansi.reportedTests.failed, null);
  assert.equal(ansi.reportedTests.skipped, 1);
  assert.equal(ansi.historicalStatus, 'NOT_RUN');
  assert.equal(report('Tests  0 passed (0)').reportedTests.total, 0);
  assert.equal(C.parseTestCounts('Tests  1 failed | 14 passed (15)'), 0);
  assert.equal(C.makeReceipt({ exitCode: 0, testCount: 0, requirementKind: 'test' }).status, 'NOT_RUN');
});
