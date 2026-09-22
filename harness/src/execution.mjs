// Declared-check execution accounting and owned, cancellable subprocesses.
// This measures checks, not unobserved model thinking or arbitrary host tools.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidateCount } from './evidence.mjs';

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Read-only check of the owned child and its POSIX process group. The host can
// remain alive after a failed commit; host liveness alone does not imply work.
export function ownedWorkAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (alive(pid)) return true;
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function usage(run) {
  if (run.execution) return { ...run.execution, candidateCount: candidateCount(run), scope: 'declared_check_execution' };
  const records = [...(run.receipts || []), ...(run.evidence || []).filter(x => x.kind === 'negative_control')];
  const intervals = records.filter(r => Number.isFinite(r.startedAt) && Number.isFinite(r.finishedAt) && r.finishedAt >= r.startedAt)
    .map(r => [r.startedAt, r.finishedAt]).sort((a, b) => a[0] - b[0]);
  let verificationMs = 0, end = -Infinity;
  for (const [start, finish] of intervals) { verificationMs += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
  return { schemaVersion: 1, since: null, historicalUsageUnknown: true, verificationMs,
    commandAttempts: records.length, inFlight: null, candidateCount: candidateCount(run), scope: 'declared_check_execution' };
}

export function initialize(run, now = Date.now()) {
  if (!run.execution) {
    const { candidateCount: ignored, scope, ...previous } = usage(run);
    run.execution = { ...previous, since: now };
  }
  return run.execution;
}

export function newCandidate(run, fingerprint) {
  const hash = fingerprint?.hash || fingerprint;
  const aliases = [hash, fingerprint?.legacyHash].filter(Boolean), state = run.state || {};
  return !aliases.includes(state.lastEvalFingerprint) && !(state.candidates || []).some(c => c.counted && aliases.includes(c.fingerprint));
}

const validTime = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000;

// The ORIGINAL declared boundary: creation time + declared duration. An operator amendment never
// rewrites those fields or this derivation, so the original limit stays auditable forever.
export function originalTiming(run, now = Date.now()) {
  const startedAt = validTime(run.createdAt) ? run.createdAt : null;
  const seconds = run.budget?.deadlineSeconds;
  const value = startedAt !== null && Number.isFinite(seconds) && seconds >= 0 ? startedAt + seconds * 1000 : null;
  const deadlineAt = validTime(value) ? value : null;
  return { observedAt: now, startedAt, deadlineAt,
    remainingMs: deadlineAt === null ? null : Math.max(0, deadlineAt - now),
    expired: deadlineAt === null ? null : now >= deadlineAt,
    scope: 'absolute_wall_clock_since_run_creation' };
}

// Append-only operator-authorized absolute deadline (run.budgetAmendments). The highest value wins,
// so a later grant may extend but never shorten the effective boundary. The original budget fields
// and the original deadline are never mutated.
export function grantedDeadlineAt(run) {
  const values = (Array.isArray(run.budgetAmendments) ? run.budgetAmendments : [])
    .map(a => a && a.newDeadlineAt).filter(validTime);
  return values.length ? Math.max(...values) : null;
}

// Effective candidate limit = original declared limit + finite authorized allowance. Usage counters
// are never reset by a grant; the original run.budget.iterations is untouched.
export function effectiveIterations(run) {
  const base = Number.isFinite(run.budget?.iterations) ? run.budget.iterations : 40;
  const extra = (Array.isArray(run.budgetAmendments) ? run.budgetAmendments : [])
    .reduce((n, a) => n + (a && Number.isInteger(a.additionalCandidates) && a.additionalCandidates > 0 ? a.additionalCandidates : 0), 0);
  return base + extra;
}

// A fresh observation, never persisted usage or a replacement for missing legacy
// timestamps. Share the absolute wall-clock boundary across readouts and admission.
// Shape stability: a run with no operator amendment returns EXACTLY the original object, so
// existing readouts/consumers are unchanged. The original/granted split appears only once a grant
// actually exists.
export function timing(run, now = Date.now()) {
  const base = originalTiming(run, now);
  const granted = grantedDeadlineAt(run);
  if (granted === null) return base;
  const deadlineAt = base.deadlineAt === null ? granted : Math.max(base.deadlineAt, granted);
  return { ...base, deadlineAt, originalDeadlineAt: base.deadlineAt, grantedDeadlineAt: granted,
    remainingMs: deadlineAt === null ? null : Math.max(0, deadlineAt - now),
    expired: deadlineAt === null ? null : now >= deadlineAt,
    scope: 'absolute_wall_clock_with_operator_amendment' };
}

export function budgetGuard(run, { fingerprint, mode = 'normal', now = Date.now(), canCount = true } = {}) {
  const u = usage(run), b = run.budget || {};
  const deadline = timing(run, now).deadlineAt;
  const activeRemaining = Number.isFinite(b.activeSeconds) ? b.activeSeconds * 1000 - u.verificationMs : Infinity;
  const deadlineRemaining = deadline === null ? Infinity : deadline - now;
  const spent = {
    candidates: mode !== 'negative' && canCount && newCandidate(run, fingerprint) && u.candidateCount >= effectiveIterations(run),
    activeSeconds: activeRemaining <= 0,
    deadline: deadlineRemaining <= 0,
    toolActions: u.commandAttempts >= (b.toolActionCap ?? 200),
  };
  return { ok: !Object.values(spent).some(Boolean), spent, usage: u,
    activeRemaining, deadlineRemaining, deadlineKnown: deadline !== null,
    note: u.historicalUsageUnknown ? 'Historical unmetered usage is unknown; retained command times/attempts are lower bounds. Budgets were not reset.' : 'Time/action accounting covers declared check execution; model and other host-tool time is not measured here.' };
}

export function timeoutFor(check, guard) {
  const choices = [
    [Number.isFinite(check.timeoutMs) && check.timeoutMs > 0 ? check.timeoutMs : 120000, 'check_timeout'],
    [guard.activeRemaining, 'active_time_budget'], [guard.deadlineRemaining, 'deadline_budget'],
  ].sort((a, b) => a[0] - b[0]);
  return { timeoutMs: Math.max(1, Math.ceil(choices[0][0])), timeoutReason: choices[0][1] };
}

// Every check gets its own process group on POSIX. Timeout/abort/pause kill only that group.
// The grace interval is bounded; descendants cannot silently keep the verifier alive.
export function runCommand(command, { cwd, env, timeoutMs, timeoutReason, signal, shouldStop, onSpawn } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now(); let child, finished = false, terminationReason = null, error = null;
    let stdout = '', stderr = '', bytes = 0, timer, poll, force;
    const group = process.platform !== 'win32';
    const kill = sig => { try { if (group && child?.pid) process.kill(-child.pid, sig); else child?.kill(sig); } catch {} };
    const stop = reason => {
      if (finished || terminationReason) return;
      terminationReason = reason; kill('SIGTERM');
      force = setTimeout(() => kill('SIGKILL'), 400);
    };
    const abort = () => stop('aborted');
    const groupAlive = () => {
      if (!group || !child?.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
    };
    const finish = async (status, sig) => {
      if (finished) return; finished = true; clearTimeout(timer); clearInterval(poll);
      signal?.removeEventListener('abort', abort);
      // Keep an already scheduled group cleanup even if the root exited before a descendant.
      if (!force) { kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 400); }
      // 'close' only means the root/stdio closed. An ignored-stdio descendant may
      // still be writing source. Keep the reservation until group cleanup settles,
      // then fingerprint/commit in the caller. Fail explicitly if cleanup is uncertain.
      for (let attempt = 0; attempt < 75 && groupAlive(); attempt++) await new Promise(done => setTimeout(done, 20));
      const cleanupComplete = !groupAlive();
      if (!cleanupComplete) { error = error || 'CLEANUP_INCOMPLETE'; terminationReason = terminationReason || 'child_cleanup_failed'; }
      clearTimeout(force);
      resolve({ status, signal: sig, error, stdout, stderr, terminationReason, cleanupComplete, startedAt, finishedAt: Date.now(), pid: child?.pid || null });
    };
    if (signal?.aborted) { terminationReason = 'aborted'; finish(null, null); return; }
    try {
      const initialStop = shouldStop?.();
      if (initialStop) { terminationReason = initialStop; finish(null, null); return; }
      child = spawn(command[0], command.slice(1), { cwd, env, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (name, data) => {
        bytes += data.length;
        if (bytes > 16 * 1024 * 1024) { error = 'OUTPUT_LIMIT'; stop('output_limit'); return; }
        if (name === 'stdout') stdout += data.toString(); else stderr += data.toString();
      };
      child.stdout.on('data', d => collect('stdout', d)); child.stderr.on('data', d => collect('stderr', d));
      child.on('error', e => { error = e.code || e.message; });
      child.on('exit', () => {
        // A shell can exit while leaving descendants holding stdout open.
        kill('SIGTERM'); if (!force) force = setTimeout(() => kill('SIGKILL'), 400);
      });
      child.on('close', finish);
      // Register handlers before persistence callbacks: a failed callback must not leave
      // an unobserved child or turn a later spawn error into an uncaught exception.
      onSpawn?.(child.pid);
      timer = setTimeout(() => stop(timeoutReason || 'check_timeout'), timeoutMs || 120000);
      if (shouldStop) poll = setInterval(() => {
        try { const reason = shouldStop(); if (reason) stop(reason); }
        catch (e) { error = e.code || e.message; stop('state_read_failed'); }
      }, 50);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (e) {
      error = e.code || e.message; stop(child?.pid ? 'setup_error' : 'launch_error');
      if (!child?.pid) finish(null, null); // Otherwise wait for actual process closure.
    }
  });
}

// One finite Node worker per declared check, not a server or continuation daemon.
// IPC ownership loss reaches the worker even if the OpenCode host is SIGKILLed.
// Node is already required by the installed maintenance launcher and check tooling.
export function runDurableCheck(job, { env, signal, onExecutor } = {}) {
  return new Promise(resolve => {
    let worker, error = null, stderr = '';
    const abort = () => { if (worker?.connected) worker.send({ type: 'abort' }, () => {}); };
    try {
      worker = spawn('node', [fileURLToPath(new URL('./executor.mjs', import.meta.url))], {
        env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      worker.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000); });
      worker.on('error', e => { error = e.code || e.message; });
      worker.on('close', (code, terminationSignal) => {
        signal?.removeEventListener('abort', abort);
        resolve({ executorPid: worker.pid || null, code, signal: terminationSignal, error, stderr });
      });
      const registered = onExecutor(worker.pid);
      if (registered?.error) {
        error = registered.error; worker.kill('SIGTERM'); return;
      }
      worker.send({ type: 'execute', job, aborted: !!signal?.aborted }, e => {
        if (e) { error = e.code || e.message; worker.kill('SIGTERM'); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (e) {
      error = e.code || e.message;
      if (worker?.pid) worker.kill('SIGTERM');
      else resolve({ executorPid: null, code: null, signal: null, error, stderr });
    }
  });
}
