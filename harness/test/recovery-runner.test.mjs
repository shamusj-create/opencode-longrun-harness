// Recovery-runner tests: the operator-side supervised-resume tool.
// These are OFFLINE tests of the decision logic and the CLI's refusal paths. They deliberately do not
// dispatch a model turn (no --skip-model-check path reaches a spawn), so no host is started here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideRecovery, evaluateOutcome, resumePrompt, freshSessionPrompt, extractSessionId, applyRebindGuard, dispatchLogStem, defaultMaintenanceBin, findRunKey, sessionForRun, boundSessions, hostLive, pauseViaMaintenance, inferenceBaseFromConfig, configFileSupplyingBase, resolveInferenceBase, parseListeners, isMtplxRuntime, isLocalModelRuntime, requiredModel, requiredProviderModel, opencodeBin, runtimeMatcher, DEFAULT_REQUIRED_MODEL, DEFAULT_OPENCODE_BIN, DEFAULT_RUNTIME_MATCHER, discoverMtplxBases, inferenceCandidates, pickServedBase, pinnedConfigContent, DEFAULT_INFERENCE_BASE, REQUIRED_MODEL, REQUIRED_PROVIDER_MODEL } from '../tools/recovery-runner.mjs';

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

test('a terminal run counts as a successful ending and is never asked to rebind', () => {
  // Regression: the completion dispatch drove the run to COMPLETE, then the rebind guard scored that
  // success as NO_REBIND, retried, and exited ATTEMPT_LIMIT — reporting a fully completed run as a
  // runner failure. A terminal run cannot legitimately be adopted, so it must not be required to be.
  for (const status of ['COMPLETE', 'CANCELLED', 'BLOCKED']) {
    const outcome = evaluateOutcome({ status });
    assert.equal(outcome.recovered, true, `${status} is an ending, not a failure`);
    assert.equal(outcome.retry, false, `${status} must not be retried`);
    assert.equal(outcome.terminal, true, `${status} is marked terminal`);
    // even with no rebound session at all, the guard must pass it through unchanged
    const guarded = applyRebindGuard(outcome, { newSessionId: null, boundSessions: [], compactionSessionID: null });
    assert.equal(guarded.outcome.recovered, true, `${status} must survive the rebind guard`);
    assert.notEqual(guarded.outcome.reason, 'NO_REBIND', `${status} must not be scored NO_REBIND`);
    assert.equal(guarded.rebound, false);
  }
  // a NON-terminal success still requires proof that the new conversation adopted the run
  const paused = evaluateOutcome({ status: 'PAUSED' });
  assert.equal(paused.terminal, undefined);
  assert.equal(applyRebindGuard(paused, { newSessionId: null, boundSessions: [] }).outcome.reason, 'NO_REBIND',
    'a non-terminal turn that proved nothing must still be rejected');
});

test('the inference endpoint is discovered from config, not hardcoded to one port', () => {
  // Regression: the port was a literal. When the environment moved the required model from :8000 to
  // :8001 while another local router took :8000, the identity check queried the wrong server and
  // reported MODEL_MISMATCH even though the required model WAS being served — a false alarm that
  // blocks every dispatch. The endpoint must follow the live OpenCode config, which is also what the
  // dispatched session itself uses.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-cfg-'));
  try {
    assert.equal(inferenceBaseFromConfig({ configDir: dir }), null, 'no config => no derived base');
    assert.equal(resolveInferenceBase({ configDir: dir }), DEFAULT_INFERENCE_BASE,
      'falls back to the historic default only when nothing else is configured');

    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({
      model: 'mtplx/mtplx-flash-next-optimized-speed',
      provider: { mtplx: { options: { baseURL: 'http://127.0.0.1:8001/v1' } } },
    }));
    assert.equal(inferenceBaseFromConfig({ configDir: dir }), 'http://127.0.0.1:8001/v1',
      'reads the live baseURL from the OpenCode config');
    assert.equal(resolveInferenceBase({ configDir: dir }), 'http://127.0.0.1:8001/v1');
    // a trailing slash must not produce a doubled path when /models is appended
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({
      provider: { mtplx: { options: { baseURL: 'http://127.0.0.1:8001/v1///' } } },
    }));
    assert.equal(resolveInferenceBase({ configDir: dir }), 'http://127.0.0.1:8001/v1');

    // explicit overrides win, so an operator can point at a non-default endpoint deliberately
    assert.equal(resolveInferenceBase({ flagValue: 'http://127.0.0.1:9999/v1', configDir: dir }),
      'http://127.0.0.1:9999/v1', 'an explicit flag wins over the config');
    assert.equal(resolveInferenceBase({ env: { LONGRUN_MODEL_BASE: 'http://127.0.0.1:7777/v1' }, configDir: dir }),
      'http://127.0.0.1:7777/v1', 'the env override wins over the config');

    // a malformed config must not crash the resolver or silently invent an endpoint
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{ not json');
    assert.equal(resolveInferenceBase({ configDir: dir }), DEFAULT_INFERENCE_BASE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dispatch pins the config file the endpoint check actually read', () => {
  // Regression: OpenCode MERGES every config file it finds. With opencode.json naming :8001 and a
  // stale opencode.jsonc still naming :8000, the identity check read :8001 and passed, then the
  // session was dispatched against :8000 and 404'd with "model not found". The check and the dispatch
  // must use the same endpoint, so the runner pins the resolved file via OPENCODE_CONFIG_CONTENT.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-pin-'));
  try {
    assert.equal(configFileSupplyingBase({ configDir: dir }), null, 'nothing to pin when no config defines an endpoint');

    const good = path.join(dir, 'opencode.json');
    fs.writeFileSync(good, JSON.stringify({ provider: { mtplx: { options: { baseURL: 'http://127.0.0.1:8001/v1' } } } }));
    assert.equal(configFileSupplyingBase({ configDir: dir }), good, 'pins the .json that supplies the endpoint');

    // the stale sibling must NOT be chosen while the .json still defines a baseURL
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), JSON.stringify({ provider: { mtplx: { options: { baseURL: 'http://127.0.0.1:8000/v1' } } } }));
    assert.equal(configFileSupplyingBase({ configDir: dir }), good, '.json keeps precedence over the stale .jsonc');

    // if only the .jsonc remains, it is what the check reads — so it is what must be pinned
    fs.rmSync(good);
    assert.equal(configFileSupplyingBase({ configDir: dir }), path.join(dir, 'opencode.jsonc'));
    assert.equal(resolveInferenceBase({ configDir: dir }), 'http://127.0.0.1:8000/v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('the MTPLX endpoint is discovered from its own listening socket, then still held to the strict bar', async () => {
  // A configured port can be stale in the other direction: MTPLX's Settings say :8000 and it only fell
  // back to :8001 because another app held :8000, so the config can point at a port MTPLX has left.
  // Discovery changes only WHERE we look; the identity bar is unchanged (exactly one model, the required one).
  const lsof = ['p39575', 'n127.0.0.1:8000', 'p48754', 'n127.0.0.1:8001', 'p999', 'n*:5199'].join('\n');
  assert.deepEqual(parseListeners(lsof), [
    { pid: '39575', port: 8000 }, { pid: '48754', port: 8001 }, { pid: '999', port: 5199 },
  ]);
  assert.deepEqual(parseListeners(''), []);
  assert.deepEqual(parseListeners('garbage'), []);

  // only MTPLX's bundled runtime counts as MTPLX — the router on :8000 must not be mistaken for it
  assert.equal(isMtplxRuntime('/home/example/Library/Application Support/MTPLX/runtime-venv/bin/python'), true);
  assert.equal(isMtplxRuntime('/Applications/MTPLX.app/Contents/MacOS/MTPLXApp'), true);
  assert.equal(isMtplxRuntime('/opt/homebrew/bin/python3.1'), false);
  assert.equal(isMtplxRuntime(''), false);

  // discovery maps a listening socket to a base URL, and several ports can be probed
  const fakeExec = (cmd, args) => {
    if (cmd === 'lsof') return { stdout: 'p100\nn127.0.0.1:8000\np200\nn127.0.0.1:8001\n' };
    const pid = args[args.length - 1];
    return { stdout: pid === '200' ? '/x/MTPLX/runtime-venv/bin/python\n' : '/opt/homebrew/bin/python3.1\n' };
  };
  assert.deepEqual(discoverMtplxBases({ exec: fakeExec }), ['http://127.0.0.1:8001/v1']);

  // the first candidate serving EXACTLY the required model wins; a wrong model is not accepted
  const probe = async (b) => ({
    'http://a/v1': ['local-governor', 'qwen-local'],
    'http://b/v1': [REQUIRED_MODEL],
    'http://c/v1': [REQUIRED_MODEL, 'something-else'],
  }[b] || (() => { throw new Error('refused'); })());
  const picked = await pickServedBase({ bases: ['http://a/v1', 'http://b/v1', 'http://c/v1'], probe });
  assert.equal(picked.base, 'http://b/v1', 'picks the endpoint serving exactly the required model');
  assert.equal(picked.models.length, 1);
  // a reachable endpoint that serves the right model plus another is NOT accepted
  const strict = await pickServedBase({ bases: ['http://c/v1'], probe });
  assert.equal(strict.base, null, 'exactly one served model is still required');
  // so is an unreachable one — and the failure names what was tried instead of guessing
  const none = await pickServedBase({ bases: ['http://dead/v1'], probe });
  assert.equal(none.base, null);
  assert.equal(none.tried[0].base, 'http://dead/v1');
  assert.ok(none.tried[0].error, 'an unreachable candidate records why');

  // candidate order: explicit operator value, then MTPLX discovery, then config, then default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-cand-'));
  try {
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ provider: { mtplx: { options: { baseURL: 'http://cfg/v1' } } } }));
    const cands = inferenceCandidates({ env: {}, configDir: dir, exec: fakeExec });
    assert.equal(cands[0], 'http://127.0.0.1:8001/v1', 'the discovered MTPLX socket outranks the stale config');
    assert.ok(cands.includes('http://cfg/v1'), 'the config is still probed as a fallback');
    assert.ok(cands.includes(DEFAULT_INFERENCE_BASE), 'and the historic default last');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // pinning rewrites baseURL to the VERIFIED endpoint, so the session cannot reach another server
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-pinbase-'));
  try {
    const f = path.join(pdir, 'opencode.json');
    fs.writeFileSync(f, JSON.stringify({ model: 'mtplx/x', provider: { mtplx: { name: 'MTPLX (local)', options: { baseURL: 'http://stale/v1', apiKey: 'local' } } } }));
    const content = pinnedConfigContent({ file: f, base: 'http://127.0.0.1:8001/v1' });
    const parsed = JSON.parse(content);
    assert.equal(parsed.provider.mtplx.options.baseURL, 'http://127.0.0.1:8001/v1', 'baseURL is forced to the verified endpoint');
    assert.equal(parsed.provider.mtplx.options.apiKey, 'local', 'other provider options survive the pin');
    assert.equal(parsed.provider.mtplx.name, 'MTPLX (local)');
    assert.equal(pinnedConfigContent({ file: path.join(pdir, 'missing.json'), base: 'x' }), null);
  } finally {
    fs.rmSync(pdir, { recursive: true, force: true });
  }
});


test('the toolchain is configurable, not hardcoded to one local setup', () => {
  // The harness should drive whatever local OpenCode + model an operator runs. The shipped MTPLX values
  // are DEFAULTS; every one of them must be overridable, or the tool cannot be reused across setups.
  assert.equal(requiredModel({}), DEFAULT_REQUIRED_MODEL, 'default model unchanged');
  assert.equal(requiredModel({ LONGRUN_REQUIRED_MODEL: 'other-model' }), 'other-model', 'model overridable');
  assert.equal(requiredProviderModel({}), 'mtplx/mtplx-flash-next-optimized-speed');
  assert.equal(requiredProviderModel({ LONGRUN_REQUIRED_PROVIDER_MODEL: 'vendor/other' }), 'vendor/other');
  assert.equal(opencodeBin({}), DEFAULT_OPENCODE_BIN);
  assert.equal(opencodeBin({ LONGRUN_OPENCODE_BIN: '/usr/local/bin/opencode' }), '/usr/local/bin/opencode', 'binary path overridable');
  assert.equal(runtimeMatcher({}), DEFAULT_RUNTIME_MATCHER);
  assert.equal(runtimeMatcher({ LONGRUN_RUNTIME_MATCHER: 'acme' }), 'acme');

  // a custom matcher must change which runtime is recognised — otherwise discovery is still vendor-locked
  assert.equal(isLocalModelRuntime('/Applications/MTPLX.app/x'), true, 'default matcher finds MTPLX');
  assert.equal(isLocalModelRuntime('/opt/acme/runtime-venv/bin/python', 'acme[\\/].*runtime-venv'), true, 'custom matcher finds another runtime');
  assert.equal(isLocalModelRuntime('/Applications/MTPLX.app/x', 'acme'), false, 'custom matcher excludes the default vendor');
  assert.equal(isLocalModelRuntime('/x', '('), false, 'an invalid matcher fails closed rather than throwing');

  // discovery and the strict identity check must both honour the configured toolchain
  const fakeExec = (cmd, args) => {
    if (cmd === 'lsof') return { stdout: 'p100\nn127.0.0.1:9100\n' };
    return { stdout: '/opt/acme/runtime-venv/bin/python\n' };
  };
  assert.deepEqual(discoverMtplxBases({ exec: fakeExec }), [], 'default matcher ignores a foreign runtime');
  assert.deepEqual(discoverMtplxBases({ exec: fakeExec, matcher: 'acme[\\/].*runtime-venv' }),
    ['http://127.0.0.1:9100/v1'], 'configured matcher discovers the foreign runtime');
  const cands = inferenceCandidates({ env: {}, configDir: '/nonexistent', exec: fakeExec, matcher: 'acme[\\/].*runtime-venv' });
  assert.equal(cands[0], 'http://127.0.0.1:9100/v1', 'discovery leads the candidate list');
});
