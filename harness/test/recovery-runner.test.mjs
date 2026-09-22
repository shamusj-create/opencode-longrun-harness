// Recovery-runner tests: the operator-side supervised-resume tool.
// These are OFFLINE tests of the decision logic and the CLI's refusal paths. They deliberately do not
// dispatch a model turn (no --skip-model-check path reaches a spawn), so no host is started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideRecovery, evaluateOutcome, resumePrompt, freshSessionPrompt, extractSessionId, applyRebindGuard, dispatchLogStem, defaultMaintenanceBin, findRunKey, sessionForRun, boundSessions, hostLive, pauseViaMaintenance, REQUIRED_MODEL, REQUIRED_PROVIDER_MODEL } from '../tools/recovery-runner.mjs';

const RUNNER = path.resolve(import.meta.dirname, '..', 'tools', 'recovery-runner.mjs');

function stateFixture(t, run, runs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-runner-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const key = 'a'.repeat(32);
  fs.mkdirSync(path.join(base, 'state', key), { recursive: true });
  fs.writeFileSync(path.join(base, 'state', key, 'run.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(base, 'runs.json'), JSON.stringify(runs || {}));
  return { base, key };
}

test('refuses to dispatch beside a live host, in-flight work, or the wrong status', () => {
  assert.equal(decideRecovery({ status: 'RECOVERY_REQUIRED', hostLive: true, sessionId: 's' }).reason, 'HOST_LIVE');
  assert.equal(decideRecovery({ status: 'RECOVERY_REQUIRED', inFlight: { token: 't' }, sessionId: 's' }).reason, 'VERIFY_IN_FLIGHT');
  assert.equal(decideRecovery({ status: 'IMPLEMENTING', sessionId: 's' }).reason, 'NOT_RECOVERY_REQUIRED');
  assert.equal(decideRecovery({ status: 'PAUSED', sessionId: 's' }).reason, 'NOT_RECOVERY_REQUIRED');
  assert.equal(decideRecovery({ status: 'RECOVERY_REQUIRED' }).reason, 'NO_SESSION_BINDING', 'no binding means a new host cannot reach the same session');
  assert.equal(decideRecovery({ status: 'RECOVERY_REQUIRED', sessionId: 's', attempt: 2, maxAttempts: 2 }).action, 'give_up');
});

test('dispatches only for a bound RECOVERY_REQUIRED run and counts attempts', () => {
  const first = decideRecovery({ status: 'RECOVERY_REQUIRED', sessionId: 's', attempt: 0, maxAttempts: 2 });
  assert.equal(first.action, 'dispatch'); assert.equal(first.attempt, 1);
  const second = decideRecovery({ status: 'RECOVERY_REQUIRED', sessionId: 's', attempt: 1, maxAttempts: 2 });
  assert.equal(second.action, 'dispatch'); assert.equal(second.attempt, 2);
  assert.equal(decideRecovery({ status: 'PAUSED', sessionId: 's', allowStatus: ['PAUSED'] }).action, 'dispatch', 'explicit opt-in statuses are honoured');
});

test('outcome evaluation only reports recovered when the run actually left RECOVERY_REQUIRED', () => {
  assert.deepEqual(evaluateOutcome({ status: 'RECOVERY_REQUIRED' }), { recovered: false, retry: true, status: 'RECOVERY_REQUIRED' });
  assert.equal(evaluateOutcome({ status: 'IMPLEMENTING' }).recovered, true);
  assert.equal(evaluateOutcome({ status: 'PAUSED' }).recovered, true);
  assert.equal(evaluateOutcome({ status: 'RECOVERY_REQUIRED', inFlight: { token: 'x' } }).retry, false, 'an in-flight check must not be retried over');
});

test('the supervised resume prompt is bounded and preserves the safety invariants', () => {
  const p = resumePrompt('lr-test');
  for (const needle of ['lr-test', 'resume-context', 'action=resume', 'Do not start a new run', 'keep automatic continuation OFF', 'do not COMPLETE']) {
    assert.ok(p.includes(needle), `prompt should mention: ${needle}`);
  }
});

test('state helpers locate the run key and its session binding', t => {
  const { base } = stateFixture(t, { runId: 'lr-x', status: 'RECOVERY_REQUIRED', execution: { inFlight: null } }, { ses_abc: { runId: 'lr-x', directory: '/tmp/p' } });
  assert.equal(findRunKey(base, 'lr-x').run.runId, 'lr-x');
  assert.equal(findRunKey(base, 'lr-missing'), null);
  assert.equal(sessionForRun(base, 'lr-x'), 'ses_abc');
  assert.equal(sessionForRun(base, 'lr-none'), null);
});

test('hostLive is false for a directory no host owns', () => {
  assert.equal(hostLive('/nonexistent/lr-runner-probe-' + process.pid), false);
});

test('the CLI refuses a run that is not in RECOVERY_REQUIRED, without dispatching', t => {
  const { base } = stateFixture(t, { runId: 'lr-paused', status: 'PAUSED', execution: { inFlight: null } }, { ses_abc: { runId: 'lr-paused' } });
  const res = spawnSync(process.execPath, [RUNNER, '--state-dir', base, '--project', '/nonexistent/project', '--run', 'lr-paused', '--skip-model-check', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 3, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.error, 'NOT_RECOVERY_REQUIRED');
  assert.equal(out.attempts.length, 1);
  assert.equal(out.attempts[0].decision.action, 'refuse');
});

test('the CLI passes the environment identity guard for the required model', () => {
  assert.equal(REQUIRED_MODEL, 'mtplx-flash-next-optimized-speed');
  assert.equal(REQUIRED_PROVIDER_MODEL, 'mtplx/mtplx-flash-next-optimized-speed');
});

test('reduced-context mode adopts a non-terminal run even with no usable session binding', () => {
  // The whole point: an over-window or missing binding is why a fresh conversation is needed at all.
  const d = decideRecovery({ status: 'RECOVERY_REQUIRED', freshSession: true });
  assert.equal(d.action, 'dispatch');
  assert.equal(d.reason, 'FRESH_SESSION_REBIND');
  assert.equal(decideRecovery({ status: 'PAUSED', freshSession: true }).action, 'dispatch');
  assert.equal(decideRecovery({ status: 'IMPLEMENTING', freshSession: true }).reason, 'NOT_RESUMABLE');
  assert.equal(decideRecovery({ status: 'COMPLETE', freshSession: true }).reason, 'NOT_RESUMABLE');
  assert.equal(decideRecovery({ status: 'CANCELLED', freshSession: true }).reason, 'NOT_RESUMABLE');
  // Safety refusals are not weakened by the mode.
  assert.equal(decideRecovery({ status: 'PAUSED', freshSession: true, hostLive: true }).reason, 'HOST_LIVE');
  assert.equal(decideRecovery({ status: 'PAUSED', freshSession: true, inFlight: { token: 't' } }).reason, 'VERIFY_IN_FLIGHT');
  assert.equal(decideRecovery({ status: 'PAUSED', freshSession: true, attempt: 2, maxAttempts: 2 }).action, 'give_up');
  // Without the flag the old contract is unchanged: PAUSED and a missing binding still refuse.
  assert.equal(decideRecovery({ status: 'PAUSED' }).reason, 'NOT_RECOVERY_REQUIRED');
});

test('the reduced-context prompt forbids a new run and reserves completion to the operator', () => {
  const p = freshSessionPrompt('lr-test', { phase: 'verify' });
  for (const needle of ['lr-test', 'NEW conversation', 'action=resume', 'rebound', 'longrun_verify',
    'Do not start a new run', 'keep automatic continuation OFF', 'Do not COMPLETE']) {
    assert.ok(p.includes(needle), `verify prompt should mention: ${needle}`);
  }
  const c = freshSessionPrompt('lr-test', { phase: 'complete' });
  assert.ok(c.includes('action=complete'), 'complete phase asks for completion after the operator acceptance');
  assert.ok(c.includes('operator has already accepted'), 'complete phase states who authorised it');
  assert.ok(!c.includes('Do not COMPLETE'), 'complete phase must not forbid the authorised completion');
});

test('a dispatched session id is read back from the event stream, never guessed', () => {
  const line = (sid) => JSON.stringify({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } });
  assert.equal(extractSessionId([line('ses_first'), line('ses_second')].join('\n')), 'ses_first');
  assert.equal(extractSessionId('not json\n' + line('ses_only')), 'ses_only');
  assert.equal(extractSessionId('{"type":"text","part":{}}\n'), null, 'an event without a sessionID is not a binding');
  assert.equal(extractSessionId(''), null);
  assert.equal(extractSessionId('garbage "sessionID":"ses_fallback"'), 'ses_fallback');
});

test('a reduced-context turn that did not adopt the run is never reported as recovered', () => {
  const recovered = { recovered: true, retry: false, status: 'IMPLEMENTING' };
  // A real re-bind leaves BOTH markers on the new session: the routing entry and the run's own owner.
  const adopted = applyRebindGuard(recovered, { newSessionId: 'ses_new', boundSessions: ['ses_old', 'ses_new'], compactionSessionID: 'ses_new' });
  assert.equal(adopted.rebound, true);
  assert.equal(adopted.outcome.recovered, true, 'an adopted run is the success case');
  // The historical conversation stays in runs.json, so reading only the first entry would have shown
  // ses_old and wrongly reported failure: that was a real tool bug, pinned here.
  const firstEntryOnly = applyRebindGuard(recovered, { newSessionId: 'ses_new', boundSessions: ['ses_old'], compactionSessionID: 'ses_new' });
  assert.equal(firstEntryOnly.rebound, false);
  assert.equal(firstEntryOnly.outcome.reason, 'NO_REBIND');
  // Bound in routing but the run's own owner marker never moved: not adoption.
  const notOwned = applyRebindGuard(recovered, { newSessionId: 'ses_new', boundSessions: ['ses_old', 'ses_new'], compactionSessionID: 'ses_old' });
  assert.equal(notOwned.rebound, false, 'a routing entry alone is not evidence that the run moved');
  assert.equal(applyRebindGuard(recovered, { newSessionId: null, boundSessions: ['ses_old'] }).outcome.reason, 'NO_REBIND',
    'a dispatch that reported no session id cannot be credited');
  // A legacy run with no owner marker is judged by its routing binding.
  assert.equal(applyRebindGuard(recovered, { newSessionId: 'ses_new', boundSessions: ['ses_new'], compactionSessionID: null }).rebound, true);
  // A run that is still un-recovered stays un-recovered whatever the binding says.
  const stuck = applyRebindGuard({ recovered: false, retry: true, status: 'RECOVERY_REQUIRED' }, { newSessionId: 'ses_new', boundSessions: ['ses_new'], compactionSessionID: 'ses_new' });
  assert.equal(stuck.outcome.retry, true);
});

test('every session bound to a run is discoverable, not just the first', t => {
  const { base } = stateFixture(t, { runId: 'lr-x' }, { ses_old: { runId: 'lr-x' }, ses_new: { runId: 'lr-x' }, ses_other: { runId: 'lr-y' } });
  assert.deepEqual(boundSessions(base, 'lr-x').sort(), ['ses_new', 'ses_old']);
  assert.deepEqual(boundSessions(base, 'lr-absent'), []);
  assert.equal(sessionForRun(base, 'lr-x'), 'ses_old', 'the historical helper still reports the earliest binding');
});

test('the CLI refuses conflicting or unstated reduced-context arguments before any state or network use', () => {
  const conflict = spawnSync(process.execPath, [RUNNER, '--state-dir', '/nonexistent/state', '--project', '/nonexistent/project',
    '--run', 'lr-x', '--fresh-session', '--session', 'ses_old', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(conflict.status, 3, conflict.stdout + conflict.stderr);
  assert.equal(JSON.parse(conflict.stdout).error, 'ARGUMENT_CONFLICT');

  const unstated = spawnSync(process.execPath, [RUNNER, '--state-dir', '/nonexistent/state', '--project', '/nonexistent/project',
    '--run', 'lr-x', '--allow-status', 'PAUSED', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(unstated.status, 3, unstated.stdout + unstated.stderr);
  assert.equal(JSON.parse(unstated.stdout).error, 'PROMPT_REQUIRED');

  const badPhase = spawnSync(process.execPath, [RUNNER, '--state-dir', '/nonexistent/state', '--project', '/nonexistent/project',
    '--run', 'lr-x', '--fresh-session', '--phase', 'whenever', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(badPhase.status, 3, badPhase.stdout + badPhase.stderr);
  assert.equal(JSON.parse(badPhase.stdout).error, 'INVALID_PHASE');
});

test('a reduced-context dispatch to a PAUSED run reaches the attempt cap without touching the network', t => {
  const { base } = stateFixture(t, { runId: 'lr-fresh', status: 'PAUSED', execution: { inFlight: null }, receipts: [] }, { ses_old: { runId: 'lr-fresh' } });
  const promptFile = path.join(base, 'phase.txt');
  fs.writeFileSync(promptFile, 'operator-authored intent');
  const res = spawnSync(process.execPath, [RUNNER, '--state-dir', base, '--project', '/nonexistent/project', '--run', 'lr-fresh',
    '--fresh-session', '--allow-status', 'PAUSED', '--prompt-file', promptFile, '--max-attempts', '0', '--skip-model-check', '--json'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.freshSession, true);
  assert.equal(out.boundSession, 'ses_old');
  assert.equal(out.sessionId, null, 'a fresh conversation must not be dispatched into the old session');
  assert.equal(out.attempts[0].decision.action, 'give_up', 'the widened status may not be refused as NOT_RESUMABLE');
  assert.equal(out.attempts[0].decision.reason, 'ATTEMPT_LIMIT');
  assert.equal(out.attempts[0].status, 'PAUSED', 'the widened --allow-status value is what was evaluated');
  assert.equal(out.attempts[0].receiptsBefore, 0);
  assert.equal(out.attempts[0].dispatch, undefined, 'nothing may be dispatched once the attempt cap is reached');
});

test('raw dispatch streams get unique, phase-tagged names so evidence is never overwritten', () => {
  const at = Date.parse('2026-09-22T09:29:48.118Z');
  const a = dispatchLogStem({ logDir: '/tmp/ev', attempt: 1, runId: 'lr-x', phase: 'verify', at });
  const b = dispatchLogStem({ logDir: '/tmp/ev', attempt: 1, runId: 'lr-x', phase: 'complete', at });
  assert.notEqual(a, b, 'the same run and attempt number in different phases must not collide');
  assert.ok(a.includes('-verify-'), a);
  assert.ok(b.includes('-complete-'), b);
  assert.ok(!a.includes(':') && !a.includes('.'), 'a stem must be a safe filename: ' + a);
  // Distinct dispatches of the same phase and attempt still differ once time moves on.
  const later = dispatchLogStem({ logDir: '/tmp/ev', attempt: 1, runId: 'lr-x', phase: 'verify', at: at + 60000 });
  assert.notEqual(a, later);
  // Non-fresh dispatches keep the historical shape (no phase tag).
  assert.ok(dispatchLogStem({ logDir: '/tmp/ev', attempt: 2, runId: 'lr-x', at }).includes('recovery-attempt-2-lr-x-'));
});

test('the operator fallback binary resolves under HOME, not dirname(HOME)', () => {
  // Regression: the give-up path once used path.dirname(HOME), giving <dirname>/.config/<...> which
  // does not exist, so the pause fallback failed silently with exitCode null.
  const home = '/home/example';
  const bin = defaultMaintenanceBin(home);
  assert.equal(bin, '/home/example/.config/opencode/longrun-harness/longrun');
  assert.ok(bin.startsWith(home + '/'), 'must live under HOME: ' + bin);
  assert.ok(!bin.startsWith('/home/.config'), 'must not be dirname(HOME)-rooted: ' + bin);
  // A different HOME must move the path with it.
  assert.ok(defaultMaintenanceBin('/tmp/fake-home').startsWith('/tmp/fake-home/.config/'));
});

test('a fallback that never ran reports why, instead of a bare failure', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-runner-bin-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const res = pauseViaMaintenance({ bin: path.join(base, 'does-not-exist'), stateDir: base, project: base, runId: 'lr-x' });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, null, 'no exit code because the process never started');
  assert.ok(res.bin.endsWith('does-not-exist'), 'the attempted binary is reported');
  assert.ok(res.error, 'the spawn error is reported: ' + JSON.stringify(res));
});

test('the operator pause fallback lands a thrashing run in a controlled state', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-runner-pause-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stub = path.join(base, 'longrun-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"state":"PAUSED"}\'\n');
  fs.chmodSync(stub, 0o755);
  const res = pauseViaMaintenance({ bin: stub, stateDir: base, project: base, runId: 'lr-x' });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'PAUSED');
});

test('an exhausted run is paused rather than left looping (CLI path, no dispatch)', t => {
  const { base } = stateFixture(t, { runId: 'lr-stuck', status: 'RECOVERY_REQUIRED', execution: { inFlight: null } }, { ses_abc: { runId: 'lr-stuck' } });
  const stub = path.join(base, 'longrun-stub');
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"state":"PAUSED"}\'\n');
  fs.chmodSync(stub, 0o755);
  const res = spawnSync(process.execPath, [RUNNER, '--state-dir', base, '--project', '/nonexistent/project', '--run', 'lr-stuck',
    '--max-attempts', '0', '--maintenance-bin', stub, '--skip-model-check', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.error, 'ATTEMPT_LIMIT');
  assert.equal(out.pausedAfterAttemptLimit.ok, true);
  assert.equal(out.state, 'PAUSED');
});
