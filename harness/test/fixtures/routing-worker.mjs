// Offline child process fixture. Never imports a live host or production state.
import fs from 'node:fs';
import path from 'node:path';
const repo = path.resolve(import.meta.dirname, '../../..');
  const [base, label, mode] = process.argv.slice(2);
  process.env.LONGRUN_TEST = '1';
  process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
  process.env.LONGRUN_CONTROLLER_FILE = path.join(repo, 'harness/src/controller.js');
  let savedRun = false, delayed = false, projectReads = 0;
  const rename = fs.renameSync, read = fs.readFileSync;
  fs.renameSync = function(from, to, ...args) {
    const result = rename.call(this, from, to, ...args);
    if (String(to).endsWith('/run.json')) savedRun = true;
    return result;
  };
  fs.readFileSync = function(file, ...args) {
    let data, failure;
    try { data = read.call(this, file, ...args); } catch (error) { failure = error; }
    const target = mode === 'same-project' ? 'projects.json' : 'runs.json';
    if (path.basename(String(file)) === 'projects.json') projectReads++;
    if (label === 'A' && !delayed && path.basename(String(file)) === target && (mode === 'same-project' ? projectReads === 2 : savedRun)) {
      delayed = true;
      process.stdout.write(JSON.stringify({ critical: true }) + '\n');
      // A normal scheduler can pause a process here. Hold its already-read snapshot
      // long enough for B's independent process to finish an unprotected mutation.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
    }
    if (failure) throw failure;
    return data;
  };
  const plugin = await import(path.join(repo, 'harness/plugin/longrun.js'));
  const hooks = await plugin.default.server({ client: null });
  const dir = path.join(base, mode === 'same-project' ? 'A' : label);
  const result = await hooks.tool.longrun.execute({ action: 'start', request: 'Concurrent routing fixture', criteria: [{ id: 'c', checks: ['check'], evidenceClass: 'STATIC' }], checkCatalogue: { check: { command: [process.execPath, '-e', 'require("node:assert/strict").equal(2+2,4)'], kind: 'cmd' } } }, { sessionID: label, directory: dir, worktree: dir });
  process.stdout.write(JSON.stringify({ result: JSON.parse(result) }) + '\n');
