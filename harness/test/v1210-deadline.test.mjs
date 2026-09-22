import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import { F } from './helper.mjs';

process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lr1210-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project'), state = path.join(root, 'state');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'source.txt'), 'deadline fixture');
  process.env.LONGRUN_STATE_DIR = state;
  const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
  const ctx = { sessionID: 'owner', directory: dir, worktree: dir };
  const marker = path.join(dir, 'must-not-execute');
  const started = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Offline deadline admission fixture',
    criteria: [{ id: 'c', evidenceClass: 'STATIC', checks: ['check'] }],
    checkCatalogue: { check: { kind: 'cmd', command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`] } } }, ctx));
  const store = new C.Store(state), key = C.stateKey(C.projectIdentity(dir), started.runId);
  const file = store._file(key, 'run.json');
  const guard = (tool, args = {}, sessionID = ctx.sessionID) => hooks['tool.execute.before']({ tool, sessionID }, { args });
  const expire = status => store.mutate(key, r => { r.createdAt = Date.now() - r.budget.deadlineSeconds * 1000 - 1000; if (status) r.status = status; return { ok: true }; });
  return { root, dir, state, hooks, ctx, marker, store, key, file, guard, expire, runId: started.runId };
}

test('expired ordinary tool admission blocks reads, edits, shell and delegation without changing evidence', async t => {
  const s = await setup(t); s.expire();
  const before = fs.readFileSync(s.file);
  for (const tool of ['bash', 'write', 'edit', 'apply_patch', 'task', 'batch', 'read', 'glob', 'grep', 'skill', 'some_mcp_tool']) {
    await assert.rejects(s.guard(tool), /LONGRUN_DEADLINE_EXPIRED/);
  }
  assert.deepEqual(fs.readFileSync(s.file), before);
  assert.equal(fs.existsSync(s.marker), false);
});

test('deadline admission uses canonical time at the exact boundary, not cached session flags', async t => {
  const s = await setup(t), run = s.store.readJSON(s.key, 'run.json');
  const deadline = run.createdAt + run.budget.deadlineSeconds * 1000, clock = Date.now;
  try {
    Date.now = () => deadline - 1; await s.guard('bash');
    Date.now = () => deadline; await assert.rejects(s.guard('bash'), /LONGRUN_DEADLINE_EXPIRED/);
  } finally { Date.now = clock; }
  s.expire('PAUSED');
  const bindings = JSON.parse(fs.readFileSync(path.join(s.state, 'runs.json')));
  bindings.owner.paused = true; bindings.owner.disabled = true;
  fs.writeFileSync(path.join(s.state, 'runs.json'), JSON.stringify(bindings));
  await assert.rejects(s.guard('edit'), /LONGRUN_DEADLINE_EXPIRED/);
});

test('fresh sessions cannot bypass a project deadline when routing indices are absent', async t => {
  const s = await setup(t); s.expire();
  fs.unlinkSync(path.join(s.state, 'runs.json')); fs.unlinkSync(path.join(s.state, 'projects.json'));
  const before = fs.readFileSync(s.file);
  await assert.rejects(s.guard('bash', {}, 'fresh-session'), /LONGRUN_DEADLINE_EXPIRED/);
  await assert.rejects(s.guard('task', {}, 'fresh-session'), /LONGRUN_DEADLINE_EXPIRED/);
  assert.deepEqual(fs.readFileSync(s.file), before);
  const foreign = path.join(s.root, 'other'); fs.mkdirSync(foreign);
  const other = await F('../plugin/longrun.js', { client: null, directory: foreign, worktree: foreign });
  await other['tool.execute.before']({ tool: 'bash', sessionID: 'untracked-other' }, { args: {} });
});

test('expired native bookkeeping and explicit check refusal remain available, while memory writes and replacement start are refused', async t => {
  const s = await setup(t); s.expire();
  const before = s.store.readJSON(s.key, 'run.json');
  for (const action of ['help', 'status', 'next', 'resume-context', 'verify', 'checkpoint', 'pause', 'cancel', 'complete', 'resume', 'reconcile', 'memory_status']) await s.guard('longrun', { action, runId: s.runId });
  for (const action of ['memory_init', 'memory_refresh', 'start']) await assert.rejects(s.guard('longrun', { action }), /LONGRUN_DEADLINE_EXPIRED/);
  await s.guard('longrun_verify', { checkId: 'check', runId: s.runId });
  const refusal = JSON.parse(await s.hooks.tool.longrun_verify.execute({ checkId: 'check', runId: s.runId, evidenceClass: 'STATIC' }, s.ctx));
  assert.equal(refusal.error, 'BUDGET_EXHAUSTED'); assert.equal(refusal.spent.deadline, true);
  await s.hooks.tool.longrun.execute({ action: 'checkpoint', runId: s.runId, progress: { nextAction: 'Expired fixture; preserve incomplete evidence.' } }, s.ctx);
  assert.equal(await s.hooks.tool.longrun.execute({ action: 'pause', runId: s.runId }, s.ctx), 'paused');
  const after = s.store.readJSON(s.key, 'run.json');
  for (const key of ['runId', 'contract', 'contractHash', 'budget', 'createdAt', 'state', 'receipts', 'execution']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.status, 'PAUSED'); assert.equal(after.autoEnabled, false); assert.equal(fs.existsSync(s.marker), false);
});

test('unreadable canonical state cannot silently disable admission enforcement for a bound session', async t => {
  const s = await setup(t);
  for (const bytes of ['{ corrupt canonical bytes', 'null']) {
    fs.writeFileSync(s.file, bytes);
    await assert.rejects(s.guard('bash'), /ROUTING_STORE_ERROR/);
    assert.equal(fs.readFileSync(s.file, 'utf8'), bytes);
  }
  fs.unlinkSync(s.file);
  await assert.rejects(s.guard('bash'), /ROUTING_STORE_ERROR/);
});

test('recovery and status expose authoritative wall-clock timing without mutating the persisted run', async t => {
  const s = await setup(t), run = s.store.readJSON(s.key, 'run.json'), before = structuredClone(run);
  const deadline = run.createdAt + run.budget.deadlineSeconds * 1000;
  const view = C.deriveRunView(run, { now: deadline - 1250 });
  assert.deepEqual(view.timing, { observedAt: deadline - 1250, startedAt: run.createdAt, deadlineAt: deadline, remainingMs: 1250, expired: false, scope: 'absolute_wall_clock_since_run_creation' });
  const packet = C.buildRecoveryPacket(run, 1500, view).packet;
  assert.ok(packet.includes(new Date(deadline - 1250).toISOString()));
  assert.ok(packet.includes(new Date(deadline).toISOString()));
  assert.match(packet, /DEADLINE REMAINING: 1250 ms/);
  const expired = C.deriveRunView(run, { now: deadline });
  assert.equal(expired.timing.expired, true); assert.equal(expired.timing.remainingMs, 0);
  assert.match(C.buildRecoveryPacket(run, 1500, expired).packet, /DEADLINE EXPIRED.*checkpoint.*pause/);
  assert.deepEqual(run, before);
});

test('legacy unknown timestamps are explicit rather than manufactured, including in recovery context', async t => {
  const s = await setup(t), run = s.store.readJSON(s.key, 'run.json'); delete run.createdAt;
  const view = C.deriveRunView(run, { now: 1700000000000 });
  assert.equal(view.timing.deadlineAt, null); assert.equal(view.timing.remainingMs, null); assert.equal(view.timing.expired, null);
  const packet = C.buildRecoveryPacket(run, 1500, view).packet;
  assert.match(packet, /DEADLINE: UNKNOWN/); assert.match(packet, /DEADLINE REMAINING: UNKNOWN/);
  assert.equal(Object.hasOwn(run, 'createdAt'), false);
});

test('an expired foreign-project binding cannot impose its deadline on the actual host project', async t => {
  const s = await setup(t); s.expire();
  const foreign = path.join(s.root, 'foreign-project'); fs.mkdirSync(foreign);
  const other = await F('../plugin/longrun.js', { client: null, directory: foreign, worktree: foreign });
  await other['tool.execute.before']({ tool: 'bash', sessionID: s.ctx.sessionID }, { args: {} });
});

test('native status and recovery observe time afresh, without changing the deadline or source ledger', async t => {
  const s = await setup(t), run = s.store.readJSON(s.key, 'run.json');
  let now = run.createdAt + 1000; t.mock.method(Date, 'now', () => now);
  const first = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'status', runId: s.runId }, s.ctx));
  now += 8000;
  const second = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'status', runId: s.runId }, s.ctx));
  assert.equal(second.timing.observedAt - first.timing.observedAt, 8000);
  assert.equal(first.timing.remainingMs - second.timing.remainingMs, 8000);
  assert.equal(first.timing.deadlineAt, second.timing.deadlineAt);
  const packet = await s.hooks.tool.longrun.execute({ action: 'resume-context', runId: s.runId }, s.ctx);
  assert.ok(packet.includes(new Date(now).toISOString()));
  assert.deepEqual(s.store.readJSON(s.key, 'run.json'), run);
});
