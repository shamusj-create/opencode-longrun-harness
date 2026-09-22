// v1.2.21 — negative-fixture isolation must not be defeated by a filesystem-root anchor.
//
// Reproduced BEFORE the fix: a real OpenCode CLI host supplied context.worktree="/" so the plugin
// passed "/" among the project directories, and validateNegativeFixture rejected EVERY fixture
// (including one under /private/tmp) as "fixture and production project overlap". The original
// negative-control tests only ever passed the project as both directory and worktree, so this path
// was never exercised. These are offline deterministic tests, not native host evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';

function mk(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('a filesystem-root anchor does not make every fixture overlap', t => {
  const base = mk(t, 'lr1221-');
  const project = path.join(base, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'a.mjs'), 'x');
  const fixture = path.join(base, 'fixture'); fs.mkdirSync(fixture); fs.writeFileSync(path.join(fixture, 'a.mjs'), 'x');
  const fsRoot = path.parse(process.cwd()).root;
  const result = C.validateNegativeFixture(fixture, [project, fsRoot]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fixture, fs.realpathSync(fixture));
});

test('a fixture inside the project is still refused, and the refusal names the offending directory', t => {
  const base = mk(t, 'lr1221-');
  const project = path.join(base, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'a.mjs'), 'x');
  const inside = path.join(project, 'fixture'); fs.mkdirSync(inside);
  const result = C.validateNegativeFixture(inside, [project]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FIXTURE_NOT_ISOLATED');
  assert.match(result.detail, /overlap/);
  assert.ok(result.detail.includes(fs.realpathSync(project)), 'detail names the overlapping project directory');
});

test('a project directory nested inside the fixture is still refused', t => {
  const base = mk(t, 'lr1221-');
  const fixture = path.join(base, 'fixture'); fs.mkdirSync(fixture);
  const nested = path.join(fixture, 'project'); fs.mkdirSync(nested);
  const result = C.validateNegativeFixture(fixture, [nested]);
  assert.equal(result.ok, false);
  assert.match(result.detail, /overlap/);
});

test('an escaping symlink and a shared hard link are still refused', t => {
  const base = mk(t, 'lr1221-');
  const symlinked = path.join(base, 'symlinked'); fs.mkdirSync(symlinked);
  fs.symlinkSync(fs.realpathSync(os.tmpdir()), path.join(symlinked, 'escape'));
  const escaped = C.validateNegativeFixture(symlinked, []);
  assert.equal(escaped.ok, false);
  assert.match(escaped.detail, /symlink escapes/);

  const hard = path.join(base, 'hard'); fs.mkdirSync(hard);
  const source = path.join(base, 'hard-source.txt'); fs.writeFileSync(source, 'x');
  fs.linkSync(source, path.join(hard, 'linked.txt'));
  const shared = C.validateNegativeFixture(hard, []);
  assert.equal(shared.ok, false);
  assert.match(shared.detail, /hard link/);
});
