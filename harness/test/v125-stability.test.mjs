import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
import * as M from '../src/memory.mjs';
import { F } from './helper.mjs';

process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../src/controller.js');
const tmp = label => fs.mkdtempSync(path.join(os.tmpdir(), `lr125-${label}-`));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
async function setup(command = ['node', '-e', 'process.exit(1)'], timeoutMs = 2000) {
  process.env.LONGRUN_STATE_DIR = tmp('state');
  const dir = tmp('project'), fixture = tmp('fixture');
  write(path.join(dir, 'value.txt'), 'protected');
  write(path.join(fixture, 'value.txt'), 'broken');
  const hooks = await F('../plugin/longrun.js', { client: null });
  const ctx = { sessionID: 'first', directory: dir, worktree: dir };
  const start = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Harness commissioning', criteria: [{ id: 'c', checks: ['gate'] }], checkCatalogue: { gate: { command, timeoutMs, kind: 'cmd', gate: true } } }, ctx));
  assert.ok(start.runId);
  const key = C.stateKey(C.projectIdentity(dir), start.runId), store = new C.Store(process.env.LONGRUN_STATE_DIR);
  return { hooks, ctx, dir, fixture, store, key, runId: start.runId };
}

test('memory refresh is independent of directory enumeration and preserves unchanged bytes/mtime', t => {
  const dir = tmp('memory');
  write(path.join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}');
  for (const name of ['zeta', 'alpha']) {
    write(path.join(dir, name, 'package.json'), '{}');
    for (let n = 0; n < 12; n++) write(path.join(dir, name, `f${n}.ts`), `export const x${n} = ${n};\n`);
    write(path.join(dir, name, 'index.ts'), 'export const entry = true;\n');
  }
  M.initDeep(dir, { harnessVersion: 'test' });
  const paths = ['AGENTS.md', 'alpha/AGENTS.md', 'zeta/AGENTS.md', M.MEMORY_PATH];
  const before = paths.map(p => ({ p, bytes: fs.readFileSync(path.join(dir, p)), mtime: fs.statSync(path.join(dir, p)).mtimeMs }));
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function (...args) { return readdir.apply(fs, args).reverse(); });
  const refresh = M.initDeep(dir, { harnessVersion: 'test' });
  for (const old of before) {
    assert.deepEqual(fs.readFileSync(path.join(dir, old.p)), old.bytes, old.p);
    assert.equal(fs.statSync(path.join(dir, old.p)).mtimeMs, old.mtime, old.p);
  }
  assert.deepEqual(refresh.updated, []);
  assert.equal(M.assessStaleness(dir, M.readMemoryIndex(dir)).status, 'FRESH');
});

test('managed refresh preserves surrounding text exactly and retains source subject/location', () => {
  const dir = tmp('prose');
  write(path.join(dir, 'main.ts'), '// Presentation-only hash helper: NEVER use this function for combat rules.\nexport const hash = 1;\n');
  const before = 'Curated preamble\n\n\nkeep exact spacing\n', after = '\n\n\nCurated ending\n';
  write(path.join(dir, 'AGENTS.md'), before + M.wrapManaged('stale\n').trimEnd() + after);
  M.initDeep(dir);
  const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(content.slice(0, content.indexOf(M.MANAGED_BEGIN)), before);
  assert.equal(content.slice(content.indexOf(M.MANAGED_END) + M.MANAGED_END.length), after);
  assert.match(content, /main\.ts:1.*Presentation-only hash helper: NEVER/);
});

test('checkpoint persists advisory progress across session rebind/compaction without changing machine evidence', async t => {
  const s = await setup(), before = s.store.readJSON(s.key, 'run.json');
  const progress = { currentSlice: 'recover the fixture', nextAction: 'inspect the independent oracle failure', decisions: ['keep the original contract'], failedHypotheses: ['a timeout alone proves the verifier works'], memoryNodes: ['AGENTS.md'], artifacts: [path.join(s.fixture, 'evidence.log')] };
  const result = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'checkpoint', runId: s.runId, progress }, s.ctx));
  assert.equal(result.checkpointed, true);
  const saved = s.store.readJSON(s.key, 'run.json');
  assert.deepEqual(saved.agentProgress.fields, progress);
  for (const key of ['contract', 'contractHash', 'budget', 'receipts', 'state', 'status']) assert.deepEqual(saved[key], before[key], key);
  await s.hooks.tool.longrun.execute({ action: 'pause', runId: s.runId }, s.ctx);
  const ctx = { ...s.ctx, sessionID: 'fresh' };
  await s.hooks.tool.longrun.execute({ action: 'resume', runId: s.runId }, ctx);
  const observedAt = Date.now(); t.mock.method(Date, 'now', () => observedAt); // exact packet comparison at one instant
  const packet = await s.hooks.tool.longrun.execute({ action: 'resume-context', runId: s.runId }, ctx);
  assert.match(packet, /AGENT PROGRESS \(advisory; not verification evidence\)/);
  assert.match(packet, /NEXT ACTION: inspect the independent oracle failure/);
  const output = { context: [] }; await s.hooks['experimental.session.compacting']({ sessionID: 'fresh' }, output);
  assert.equal(output.context.length, 1);
  assert.match(output.context[0], /^## Long-run recovery\nPRE-COMPACTION SNAPSHOT:/);
  assert.ok(output.context[0].endsWith(packet));
  const invalid = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'checkpoint', progress: { status: 'COMPLETE', loss: 0 } }, ctx));
  assert.equal(invalid.error, 'INVALID_PROGRESS');
  assert.equal(s.store.readJSON(s.key, 'run.json').status, 'IMPLEMENTING');
});

test('negative control refuses production, nested and symlink aliases before executing', async () => {
  const s = await setup(['node', '-e', "require('node:fs').writeFileSync('should-not-run','bad');process.exit(1)"]);
  const nested = path.join(s.dir, 'copy'); fs.mkdirSync(nested);
  const alias = path.join(tmp('alias'), 'linked'); fs.symlinkSync(s.dir, alias);
  const dependency = tmp('dependency'); fs.symlinkSync(s.dir, path.join(dependency, 'node_modules'));
  for (const fixture of [s.dir, nested, alias, dependency]) {
    const result = JSON.parse(await s.hooks.tool.longrun_verify.execute({ checkId: 'gate', mode: 'negative', fixture }, s.ctx));
    assert.equal(result.error, 'FIXTURE_NOT_ISOLATED', fixture);
    assert.equal(fs.existsSync(path.join(fixture, 'should-not-run')), false);
  }
  assert.equal((s.store.readJSON(s.key, 'run.json').evidence || []).length, 0);
});

test('negative control classifies launch failure and timeout as invalid execution, not expected FAIL', async () => {
  for (const [command, timeout, observed] of [
    [['/nonexistent/longrun-test-executable'], 1000, 'ERROR'],
    [['node', '-e', 'setInterval(()=>{},1000)'], 40, 'TIMEOUT'],
  ]) {
    const s = await setup(command, timeout);
    const result = JSON.parse(await s.hooks.tool.longrun_verify.execute({ checkId: 'gate', mode: 'negative', fixture: s.fixture }, s.ctx));
    assert.equal(result.observed, observed);
    assert.equal(result.ok, false);
    const evidence = s.store.readJSON(s.key, 'run.json').evidence.at(-1);
    assert.equal(evidence.valid, false);
    assert.deepEqual(evidence.command, command);
    assert.ok(evidence.finishedAt >= evidence.startedAt);
    assert.equal(s.store.readJSON(s.key, 'run.json').receipts.length, 0);
  }
});

test('long original requests cannot crowd the next action and machine status out of recovery', () => {
  const run = C.startRun({ request: 'original request '.repeat(2000), contract: C.makeContract({ criteria: [{ id: 'c', checks: ['check'] }] }), checkCatalogue: { check: { command: ['node', '-e', 'process.exit(1)'] } } }).run;
  const original = run.originalRequest;
  assert.equal(C.saveAgentProgress(run, { currentSlice: 'API persistence', nextAction: 'verify reload preserves the saved record' }).ok, true);
  const { packet, words, truncated } = C.buildRecoveryPacket(run);
  assert.match(packet, /NEXT ACTION: verify reload preserves the saved record/);
  assert.match(packet, /COMPLETION BLOCKED: true/);
  assert.match(packet, /ORIGINAL GOAL EXCERPT/);
  assert.equal(truncated, true);
  assert.equal(words, packet.split(/\s+/).filter(Boolean).length);
  assert.ok(words <= 1500);
  assert.equal(run.originalRequest, original);
});

test('progress merges bounded revisions without allowing unknown fields or path traversal', () => {
  const run = { state: {}, status: 'PAUSED', receipts: [], budget: { iterations: 40 } };
  assert.equal(C.saveAgentProgress(run, { currentSlice: 'slice one', decisions: ['keep scope'] }).ok, true);
  assert.equal(C.saveAgentProgress(run, { nextAction: 'review result' }).ok, true);
  assert.equal(run.agentProgress.fields.currentSlice, 'slice one');
  assert.equal(run.agentProgressHistory.length, 2);
  assert.equal(run.agentProgressHistory[0].fields.nextAction, undefined);
  for (const progress of [{ nextAction: 'x'.repeat(1001) }, { decisions: ['x'.repeat(501)] }, { memoryNodes: ['../AGENTS.md'] }, { receipts: [] }]) {
    const before = JSON.stringify(run);
    assert.equal(C.saveAgentProgress(run, progress).error, 'INVALID_PROGRESS');
    assert.equal(JSON.stringify(run), before);
  }
});

test('checkpoint accepts JSON-string objects emitted by the local adapter and validates their contents', async () => {
  const s = await setup();
  const fields = { currentSlice: 'adapter recovery', nextAction: 'inspect the declared result' };
  const result = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'checkpoint', progress: JSON.stringify(fields) }, s.ctx));
  assert.equal(result.checkpointed, true);
  assert.deepEqual(s.store.readJSON(s.key, 'run.json').agentProgress.fields, fields);
  for (const progress of ['not JSON', '[]', '{"status":"COMPLETE"}', JSON.stringify({ currentSlice: 'x'.repeat(241) })]) {
    const before = s.store.readJSON(s.key, 'run.json');
    const result = JSON.parse(await s.hooks.tool.longrun.execute({ action: 'checkpoint', progress }, s.ctx));
    assert.equal(result.error, 'INVALID_PROGRESS');
    assert.deepEqual(s.store.readJSON(s.key, 'run.json'), before);
  }
});

test('ambiguous managed markers preserve the file and are reported for review', () => {
  const existing = 'Curated notes\n' + M.MANAGED_BEGIN + '\nIncomplete managed block\nStill curated';
  const result = M.mergeManaged(existing, M.wrapManaged('new content\n'));
  assert.equal(result.content, existing);
  assert.equal(result.preserved, true);
  assert.match(result.note, /ambiguous/);
});

test('isolation allows internal dependency links, rejects shared hardlinks and detects source mutation', async () => {
  const s = await setup();
  fs.symlinkSync('value.txt', path.join(s.fixture, 'internal'));
  assert.equal(C.validateNegativeFixture(s.fixture, [s.dir]).ok, true);
  fs.linkSync(path.join(s.dir, 'value.txt'), path.join(s.fixture, 'shared'));
  assert.equal(C.validateNegativeFixture(s.fixture, [s.dir]).ok, false);
  fs.unlinkSync(path.join(s.fixture, 'shared'));
  const run = s.store.readJSON(s.key, 'run.json');
  run.checkCatalogue.gate.command = ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(s.dir, 'value.txt'))},'unexpected mutation');process.exit(1)`];
  s.store.writeJSON(s.key, 'run.json', run);
  // The persisted session catalogue is authoritative for this deliberately hostile runner too.
  const indexPath = path.join(process.env.LONGRUN_STATE_DIR, 'runs.json');
  const index = JSON.parse(fs.readFileSync(indexPath)); index.first.checkCatalogue = run.checkCatalogue;
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const result = JSON.parse(await s.hooks.tool.longrun_verify.execute({ checkId: 'gate', mode: 'negative', fixture: s.fixture }, s.ctx));
  assert.equal(result.mutatedProduction, true);
  assert.equal(result.valid, false);
  assert.equal(result.ok, false);
  assert.equal(s.store.readJSON(s.key, 'run.json').receipts.length, 0);
});
