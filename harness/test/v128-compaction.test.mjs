import { reviewProjectFixture } from "./helper.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
async function setup({ delay = 0 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr128-'));
  const dir = path.join(base, 'project'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'source.txt'), 'real fixture');
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  const hooks = await F('../plugin/longrun.js', { client: null });
  const first = { sessionID: 'old-host', directory: dir, worktree: dir }, second = { ...first, sessionID: 'new-host' };
  const run = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Compaction control fixture', criteria: [{ id: 'c', evidenceClass: 'STATIC', checks: ['check'] }], checkCatalogue: { check: { command: [process.execPath, '-e', `setTimeout(()=>require('node:assert/strict').equal(1+1,2),${delay})`], kind: 'cmd' } } }, first));
  const store = new C.Store(process.env.LONGRUN_STATE_DIR), key = C.stateKey(C.projectIdentity(dir), run.runId);
  const call = (action, ctx = second) => hooks.tool.longrun.execute({ action, runId: run.runId }, ctx);
  await call('resume');
  return { hooks, first, second, store, key, call, runId: run.runId };
}

test('compaction cannot auto-continue an old session after another session pauses or cancels the same run', async () => {
  for (const action of ['pause', 'cancel']) {
    const s = await setup(); await s.call(action);
    const before = fs.readFileSync(s.store._file(s.key, 'run.json'));
    const output = { enabled: true };
    await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.first.sessionID }, output);
    assert.equal(output.enabled, false, `${action} must use canonical run, not stale session flags`);
    assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
  }
});

test('compaction auto-continuation refuses missing runs and exhausted execution budgets without resets', async () => {
  for (const situation of ['missing', 'deadline', 'attempts', 'legacy']) {
    const s = await setup();
    if (situation === 'missing') fs.rmSync(s.store._file(s.key, 'run.json'));
    else s.store.mutate(s.key, r => { if (situation === 'legacy') delete r.compactionSessionID; else if (situation === 'deadline') r.createdAt -= 86400000; else r.execution.commandAttempts = r.budget.toolActionCap; return { ok: true }; });
    const output = { enabled: true };
    await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, output);
    assert.equal(output.enabled, false, situation);
  }
});

test('a short concurrent writer cannot silently discard the real compacted state transition', async () => {
  const s = await setup();
  s.store.tryLock(s.key, 'checkpoint-writer');
  const release = setTimeout(() => s.store.releaseLock(s.key), 60);
  try {
    await s.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: s.second.sessionID } } });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(s.store.readJSON(s.key, 'run.json').status, 'RECOVERY_REQUIRED');
  } finally { clearTimeout(release); s.store.releaseLock(s.key); }
});

test('an older session cannot interrupt or continue the newly rebound active session', async () => {
  const s = await setup(), before = s.store.readJSON(s.key, 'run.json');
  await s.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: s.first.sessionID } } });
  const output = { enabled: true };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.first.sessionID }, output);
  assert.equal(output.enabled, false); assert.deepEqual(s.store.readJSON(s.key, 'run.json'), before);
});

test('current-session compaction preserves context and requires recovery once, without enabling the scheduler', async () => {
  const s = await setup();
  const ctx = { nextAction: 'inspect the preserved independent oracle', decisions: ['preserve acceptance'] };
  await s.hooks.tool.longrun.execute({ action: 'checkpoint', runId: s.runId, progress: ctx }, s.second);
  const before = s.store.readJSON(s.key, 'run.json');
  const compact = { context: ['host context'] };
  await s.hooks['experimental.session.compacting']({ sessionID: s.second.sessionID }, compact);
  assert.equal(compact.context[0], 'host context'); assert.match(compact.context[1], /inspect the preserved independent oracle/);
  await s.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: s.second.sessionID } } });
  const enabled = { enabled: true };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, enabled);
  assert.equal(enabled.enabled, true); // Continue the active host turn, not automatic Longrun scheduling.
  const after = s.store.readJSON(s.key, 'run.json');
  assert.equal(after.status, 'RECOVERY_REQUIRED'); assert.equal(after.controlGeneration, before.controlGeneration + 1);
  assert.equal(after.autoEnabled, false);
  for (const field of ['contract', 'contractHash', 'budget', 'receipts', 'agentProgress']) assert.deepEqual(after[field], before[field]);
  const veto = { enabled: false };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, veto);
  assert.equal(veto.enabled, false); assert.equal(s.store.readJSON(s.key, 'run.json').controlGeneration, after.controlGeneration);
});

test('persistent writer contention vetoes compaction continuation and permits later recovery without state fabrication', async () => {
  const s = await setup(), before = fs.readFileSync(s.store._file(s.key, 'run.json'));
  s.store.tryLock(s.key, 'long-writer');
  try {
    const output = { enabled: true };
    await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, output);
    assert.equal(output.enabled, false); assert.deepEqual(fs.readFileSync(s.store._file(s.key, 'run.json')), before);
  } finally { s.store.releaseLock(s.key); }
  await s.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: s.second.sessionID } } });
  assert.equal(s.store.readJSON(s.key, 'run.json').status, 'RECOVERY_REQUIRED');
  assert.equal(s.store.readJSON(s.key, 'run.json').receipts.length, 0);
});

test('completed runs stay terminal and untracked sessions remain outside Longrun control', async () => {
  const s = await setup();
  const checked = JSON.parse(await s.hooks.tool.longrun_verify.execute({ runId: s.runId, checkId: 'check', evidenceClass: 'STATIC' }, s.second));
  assert.equal(checked.status, 'PASS'); reviewProjectFixture(s.second.directory, s.runId); assert.equal(JSON.parse(await s.call('complete')).complete, true);
  const before = s.store.readJSON(s.key, 'run.json');
  const output = { enabled: true };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, output);
  assert.equal(output.enabled, false); assert.deepEqual(s.store.readJSON(s.key, 'run.json'), before);
  const unrelated = { enabled: true };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: 'untracked' }, unrelated);
  assert.equal(unrelated.enabled, true); assert.deepEqual(s.store.readJSON(s.key, 'run.json'), before);
});

test('compaction while an owned check is running cancels it honestly and refuses another host turn', async () => {
  const s = await setup({ delay: 5000 });
  const pending = s.hooks.tool.longrun_verify.execute({ runId: s.runId, checkId: 'check', evidenceClass: 'STATIC' }, s.second);
  for (let i = 0; i < 100 && !s.store.readJSON(s.key, 'run.json').execution.inFlight?.childPid; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(s.store.readJSON(s.key, 'run.json').execution.inFlight?.childPid);
  const output = { enabled: true };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, output);
  assert.equal(output.enabled, false);
  const result = JSON.parse(await pending); assert.equal(result.status, 'ERROR');
  const run = s.store.readJSON(s.key, 'run.json');
  assert.equal(run.status, 'RECOVERY_REQUIRED'); assert.equal(run.receipts[0].terminationReason, 'recovery_required');
  assert.equal(run.execution.inFlight, null); assert.equal(run.receipts.length, 1);
});

test('a corrupt recorded binding cannot masquerade as an untracked session', async () => {
  const s = await setup();
  fs.writeFileSync(path.join(process.env.LONGRUN_STATE_DIR, 'runs.json'), JSON.stringify({ [s.second.sessionID]: { runId: s.runId } }));
  const output = { enabled: true };
  await s.hooks['experimental.compaction.autocontinue']({ sessionID: s.second.sessionID }, output);
  assert.equal(output.enabled, false); assert.equal(s.store.readJSON(s.key, 'run.json').receipts.length, 0);
});

test('post-compaction execution and edits require native recovery while reads stay available', async () => {
  const s = await setup();
  await s.hooks.event({ event: { type: 'session.compacted', properties: { sessionID: s.second.sessionID } } });
  const guard = s.hooks['tool.execute.before'];
  assert.equal(typeof guard, 'function', 'host execution requires a recovery guard, not prose alone');
  for (const tool of ['bash', 'edit', 'write', 'apply_patch', 'task', 'batch']) {
    await assert.rejects(() => guard({ tool, sessionID: s.second.sessionID }, { args: {} }), /LONGRUN_RECOVERY_REQUIRED.*resume-context/);
  }
  for (const tool of ['read', 'glob', 'grep', 'list', 'skill', 'longrun', 'longrun_verify']) {
    await guard({ tool, sessionID: s.second.sessionID }, { args: {} });
  }
  const resumed = JSON.parse(await s.call('resume')); assert.equal(resumed.resumed, true);
  await guard({ tool: 'edit', sessionID: s.second.sessionID }, { args: {} });
  await guard({ tool: 'bash', sessionID: 'untracked' }, { args: {} });
});

test('compaction context distinguishes a pre-event snapshot from the mandatory post-event recovery', async () => {
  const s = await setup(); const output = { context: ['host prompt'] };
  await s.hooks['experimental.session.compacting']({ sessionID: s.second.sessionID }, output);
  assert.equal(output.context[0], 'host prompt');
  assert.match(output.context[1], /PRE-COMPACTION SNAPSHOT/);
  assert.match(output.context[1], /resume-context/); assert.match(output.context[1], new RegExp(s.runId));
  assert.match(output.context[1], /do not infer.*IMPLEMENTING/i);
});
