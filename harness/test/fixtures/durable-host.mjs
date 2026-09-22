// Exact owned offline host for destructive crash injection. Never a live app host.
import fs from 'node:fs';
import path from 'node:path';
import * as C from '../../src/controller.js';
import { F } from '../helper.mjs';
const base = process.argv[2], dir = path.join(base, 'project');
process.env.LONGRUN_STATE_DIR = path.join(base, 'state');
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, '../../src/controller.js');
const hooks = await F('../plugin/longrun.js', { client: null, directory: dir, worktree: dir });
const context = { sessionID: 'crash-host', directory: dir, worktree: dir };
const completed = process.argv[3] === 'complete';
const command = [process.execPath, '-e', completed
  ? "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'fixture');console.log('actual assertion passed')"
  : `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(base, 'child'))},String(process.pid));process.on('SIGTERM',()=>{});setTimeout(()=>{require('node:assert/strict').equal(fs.readFileSync('value.txt','utf8'),'fixture');},30000)`];
const started = JSON.parse(await hooks.tool.longrun.execute({ action: 'start', request: 'Offline durable execution crash test',
  criteria: [{ id: 'assertion', checks: ['check'] }], checkCatalogue: { check: { command, timeoutMs: 35000, kind: 'cmd' } },
  candidateBudget: 2, timeBudgetHours: 0.02, deadlineHours: 0.1, autoContinue: false }, context));
fs.writeFileSync(path.join(base, 'run-id'), started.runId);
if (completed) {
  // Hold only the final ledger commit; the independently produced real journal is untouched.
  const mutate = C.Store.prototype.mutate;
  C.Store.prototype.mutate = function(key, callback) {
    if (fs.readdirSync(this.keyPath(key)).some(n => /^execution-.*\.json$/.test(n))) return { error: 'STATE_BUSY' };
    return mutate.call(this, key, callback);
  };
}
await hooks.tool.longrun_verify.execute({ checkId: 'check', runId: started.runId }, context);
