#!/usr/bin/env node
// Long-run harness — operator-side recovery runner (source-repo tool, NOT installed into OpenCode).
//
// Purpose: when a real natural compaction leaves a tracked run in RECOVERY_REQUIRED and no host is
// active, perform the standard SUPERVISED resume dispatch automatically, with bounded attempts and a
// full JSON log. This is operator orchestration around the existing CLI; it does NOT enable in-harness
// automatic continuation, does NOT touch budgets/state, and refuses loudly whenever anything is
// ambiguous. Dependency-free (node builtins) like the rest of the harness.
//
// Usage:
//   node harness/tools/recovery-runner.mjs --state-dir DIR --project DIR --run RUN_ID
//        [--session SES_ID] [--max-attempts 2] [--config-file JSON] [--prompt-file FILE]
//        [--log-dir DIR] [--timeout-ms N] [--dry-run] [--json]
//        [--fresh-session [--phase resume|verify|complete]] [--allow-status CSV]
//
// --fresh-session is the REDUCED-CONTEXT path: when the bound conversation's own context is over the
// model window it re-compacts on every resume, so dispatching to it again cannot make progress. This
// mode creates a NEW conversation in the same project instead; the model's first native action must be
// action=resume for the SAME run, which re-binds the session+worktree (v1.2.2 RE-BIND). The run, its
// contract, budgets, receipts and counters are untouched, and the mode reports whether the rebind
// actually happened — a turn that changes nothing is NOT reported as recovered.
// --allow-status widens which lifecycle states may be dispatched, so it additionally requires an
// explicit --prompt-file: a human states the intent rather than the tool guessing.
//
// Exit codes: 0 recovered / nothing to do; 2 still stuck after the attempt cap; 3 precondition refused;
//             4 environment or dispatch error (endpoint/model/spawn).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_MODEL = "mtplx-flash-next-optimized-speed";
export const REQUIRED_PROVIDER_MODEL = "mtplx/mtplx-flash-next-optimized-speed";
export const OPENCODE_BIN = "/opt/homebrew/bin/opencode";

// ---- pure decision logic (unit-tested offline) ------------------------------------------------
// Decide what to do for a run, before any dispatch.
// Lifecycle states a reduced-context NEW conversation may adopt. Both are non-terminal and
// non-ambiguous; neither authorises anything the run itself does not already permit.
export const FRESH_SESSION_STATUSES = ["RECOVERY_REQUIRED", "PAUSED"];

export function decideRecovery({ status, inFlight, hostLive, sessionId, attempt = 0, maxAttempts = 2, allowStatus = null, freshSession = false } = {}) {
  if (hostLive) return { action: "refuse", reason: "HOST_LIVE", detail: "a host already owns this project directory; do not launch a competing turn" };
  if (inFlight) return { action: "refuse", reason: "VERIFY_IN_FLIGHT", detail: "a declared check is reserved/running; wait or reconcile instead" };
  const okStatus = allowStatus ? allowStatus.includes(status) : (freshSession ? FRESH_SESSION_STATUSES.includes(status) : status === "RECOVERY_REQUIRED");
  if (!okStatus) {
    return freshSession
      ? { action: "refuse", reason: "NOT_RESUMABLE", status, detail: `reduced-context continuation only adopts a non-terminal ${FRESH_SESSION_STATUSES.join("/")} run, not ${status}` }
      : { action: "refuse", reason: "NOT_RECOVERY_REQUIRED", status, detail: "this tool only resumes a run left in RECOVERY_REQUIRED" };
  }
  // A fresh conversation is exactly the case where the old binding is unusable (missing or over the
  // model window), so the missing binding is not itself a refusal — the run identity is what matters.
  if (!sessionId && !freshSession) return { action: "refuse", reason: "NO_SESSION_BINDING", detail: "no session binding found in runs.json; a recovery would not reach the same session" };
  if (attempt >= maxAttempts) return { action: "give_up", reason: "ATTEMPT_LIMIT", detail: `still ${status} after ${attempt} supervised attempt(s)` };
  return { action: "dispatch", attempt: attempt + 1, reason: freshSession ? "FRESH_SESSION_REBIND" : "SUPERVISED_RESUME" };
}

// Decide the outcome after a dispatch turn finished. In-flight work always wins: a reserved or running
// check must never be retried over, whatever the lifecycle status says.
export function evaluateOutcome({ status, inFlight } = {}) {
  if (inFlight) return { recovered: false, retry: false, status, reason: "VERIFY_IN_FLIGHT" };
  if (status === "RECOVERY_REQUIRED") return { recovered: false, retry: true, status };
  return { recovered: true, retry: false, status };
}

// The supervised resume prompt. Deliberately bounded and non-destructive.
export function resumePrompt(runId) {
  return [
    "Supervised same-run recovery. A natural compaction left this tracked run in RECOVERY_REQUIRED and no host is active.",
    `Call native longrun action=next (resume-context) for runId ${runId}, then explicit action=resume for the SAME run, then a bounded action=checkpoint naming the immediate next action, then continue the already-authorized work.`,
    "Do not start a new run, do not change budgets, limits or the contract, do not bypass guards through another tool or session, keep automatic continuation OFF, and do not COMPLETE.",
    "If the run cannot be resumed, report the exact refusal code and stop.",
  ].join(" ");
}

// The reduced-context prompt: a NEW conversation that must first re-bind the SAME run. It is
// deliberately explicit that this is a continuation, not a new run, and that only the operator can
// authorise completion (which requires a review acceptance the model cannot grant itself).
export function freshSessionPrompt(runId, { phase = "verify" } = {}) {
  const parts = [
    "Reduced-context supervised continuation. The previous conversation for this tracked run exceeded the model window and re-compacted on every resume, so this is a NEW conversation continuing the SAME tracked run.",
    `Call native longrun action=status for runId ${runId} first, then explicit action=resume for that SAME runId; resume re-binds this new session and worktree to the existing run, so report whether the rebound flag came back true.`,
  ];
  if (phase === "verify") parts.push("Then run the checks the contract already DECLARES, by their declared ids, with longrun_verify(runId=..., checkId=...); do not add, remove or reinterpret criteria, and do not touch the contract or budgets.");
  if (phase === "verify") parts.push("Then record a bounded action=checkpoint naming the immediate next action.");
  if (phase === "complete") parts.push("The operator has already accepted the current evidence review. Confirm with action=status that every REQUIRED criterion is verified and nothing is in flight, then call action=complete for this run and report the canonical result verbatim.");
  parts.push("Do not start a new run or a replacement run, do not change budgets, limits or the contract, do not bypass the lifecycle guards, and keep automatic continuation OFF.");
  if (phase !== "complete") parts.push("Do not COMPLETE: completion additionally requires an operator review acceptance that has not been granted yet.");
  parts.push("If the run cannot be resumed, report the exact refusal code and stop.");
  return parts.join(" ");
}

// A reduced-context dispatch only counts as recovered if the new conversation actually adopted the
// run. A turn that merely left the status alone proves nothing and must never read as success.
// Adoption means BOTH that the new session is bound to this run in runs.json AND that the run's own
// compaction-owner marker (if it has one) moved to the new session.
export function applyRebindGuard(outcome, { newSessionId, boundSessions: bound = [], compactionSessionID = null } = {}) {
  const listed = !!(newSessionId && bound.includes(newSessionId));
  const owned = !newSessionId || !compactionSessionID || compactionSessionID === newSessionId;
  const rebound = listed && owned;
  const info = { newSessionId: newSessionId || null, boundSessions: bound.slice(), compactionSessionID: compactionSessionID || null, rebound };
  if (outcome.recovered && !rebound) return { ...info, outcome: { recovered: false, retry: true, status: outcome.status, reason: "NO_REBIND" } };
  return { ...info, outcome };
}

// Raw dispatch streams are the audit trail, so their filenames must not collide between dispatches.
// The original stem keyed only on attempt number and run id, which meant a later dispatch silently
// OVERWROTE an earlier one's captured output (observed live: the completion dispatch replaced the
// verify dispatch's stream). The phase and a dispatch timestamp make each stream addressable.
export function dispatchLogStem({ logDir, attempt, runId, phase = null, at = Date.now() }) {
  const phaseTag = phase ? `-${phase}` : "";
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  return path.join(logDir, `recovery${phaseTag}-attempt-${attempt}-${runId}-${stamp}`);
}

// A fresh CLI dispatch reports its own new session id on the event stream. Reading it back from the
// dispatch output is how the operator proves which conversation actually did the work.
export function extractSessionId(stdout) {
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event.sessionID === "string" && event.sessionID) return event.sessionID;
    } catch {}
  }
  const m = String(stdout || "").match(/"sessionID"\s*:\s*"(ses_[A-Za-z0-9]+)"/);
  return m ? m[1] : null;
}

// The installed operator launcher, resolved from HOME itself.
// An earlier version resolved the give-up path with path.dirname(HOME), which yields /Users/.config/...
// instead of $HOME/.config/... — the binary did not exist, the spawn failed, and the pause fallback
// failed silently (ok:false, exitCode:null) while a run was left in RECOVERY_REQUIRED. Both call sites
// now share this one definition, and the resolved binary is reported so a failure is diagnosable.
export function defaultMaintenanceBin(home = process.env.HOME || "") {
  return path.join(home, ".config", "opencode", "longrun-harness", "longrun");
}

// Operator-side fallback: land a run in a controlled state when supervised resumes cannot clear
// RECOVERY_REQUIRED (e.g. the session's own context is over the model window, so it re-compacts
// immediately). This is a canonical, non-destructive lifecycle transition performed by the operator
// CLI — it resets nothing, only stops the loop. Uses the installed maintenance launcher.
export function pauseViaMaintenance({ bin, stateDir, project, runId }) {
  const res = spawnSync(bin, ["pause", "--json", "--project", project, "--run", runId], {
    env: { ...process.env, LONGRUN_STATE_DIR: stateDir }, encoding: "utf8", timeout: 60000,
  });
  let state = null;
  try { state = JSON.parse(res.stdout || "{}").state || null; } catch {}
  // A null exitCode means the process never ran (bad bin path, ENOENT). Surface that instead of
  // reporting a bare failure, so the operator can see why the fallback did not happen.
  return { ok: res.status === 0, exitCode: res.status, state, bin,
    error: res.error ? String(res.error.code || res.error.message) : null,
    stderr: String(res.stderr || "").trim().slice(0, 400) || null };
}

// ---- read-only state helpers -------------------------------------------------------------------
export function findRunKey(stateDir, runId) {
  const stateRoot = path.join(stateDir, "state");
  for (const name of fs.readdirSync(stateRoot)) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(stateRoot, name, "run.json"), "utf8"));
      if (run && run.runId === runId) return { key: name, run };
    } catch {}
  }
  return null;
}
export function sessionForRun(stateDir, runId) {
  try {
    const runs = JSON.parse(fs.readFileSync(path.join(stateDir, "runs.json"), "utf8"));
    for (const [sessionId, entry] of Object.entries(runs)) if (entry && entry.runId === runId) return sessionId;
  } catch {}
  return null;
}
// A run may legitimately accumulate MORE THAN ONE bound conversation: `resume` adds the current
// session to runs.json rather than replacing the old entry (v1.2.2 RE-BIND). Reading only the first
// binding therefore shows the historical session and can hide a successful re-bind, so the operator
// tool reads the whole set instead of guessing from one entry.
export function boundSessions(stateDir, runId) {
  try {
    const runs = JSON.parse(fs.readFileSync(path.join(stateDir, "runs.json"), "utf8"));
    return Object.entries(runs).filter(([, entry]) => entry && entry.runId === runId).map(([sessionId]) => sessionId);
  } catch { return []; }
}
export function hostLive(project, bin = OPENCODE_BIN) {
  const out = spawnSync("pgrep", ["-f", `${bin} run --dir ${project}`], { encoding: "utf8" });
  return out.status === 0 && String(out.stdout || "").trim().length > 0;
}
export async function servedModels(baseUrl = "http://127.0.0.1:8000/v1") {
  const res = await fetch(`${baseUrl}/models`);
  const body = await res.json();
  return (body.data || []).map((m) => m.id);
}

// ---- main ---------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes(n);
  const stateDir = flag("--state-dir"), project = flag("--project"), runId = flag("--run");
  const maxAttempts = Number(flag("--max-attempts") || 2);
  const dryRun = has("--dry-run"), json = has("--json");
  const timeoutMs = Number(flag("--timeout-ms") || 1800000);
  const out = { tool: "recovery-runner", runId, project, stateDir, attempts: [], ok: false };
  const freshSession = has("--fresh-session");
  const phase = flag("--phase") || "verify";
  const allowStatusRaw = flag("--allow-status");
  const allowStatus = allowStatusRaw ? allowStatusRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const bail = (error, detail, code = 3) => {
    out.error = error; out.detail = detail;
    process.stdout.write(JSON.stringify(out, null, json ? 2 : 0) + "\n");
    process.exit(code);
  };
  if (!stateDir || !project || !runId) bail("ARGUMENTS_REQUIRED", "--state-dir, --project and --run are required");
  if (freshSession && flag("--session")) bail("ARGUMENT_CONFLICT", "--fresh-session creates a NEW conversation, so it cannot be combined with --session; pass one or the other");
  if (!["resume", "verify", "complete"].includes(phase)) bail("INVALID_PHASE", `--phase must be resume, verify or complete (saw ${phase})`);
  // Widening the accepted lifecycle states is an operator decision, so it must come with an explicit
  // written prompt instead of the tool's own default wording.
  if (allowStatus && !flag("--prompt-file")) bail("PROMPT_REQUIRED", "--allow-status overrides which lifecycle states may be dispatched; it requires an explicit --prompt-file stating the intent");
  const found = findRunKey(stateDir, runId);
  if (!found) { out.error = "NO_RUN"; process.stdout.write(JSON.stringify(out, null, json ? 2 : 0) + "\n"); process.exit(3); }
  const boundSession = flag("--session") || sessionForRun(stateDir, runId);
  const sessionId = freshSession ? null : boundSession;
  out.sessionId = sessionId || null;
  if (freshSession) { out.freshSession = true; out.phase = phase; }
  if (boundSession) out.boundSession = boundSession;

  // Environment identity check: never dispatch to an unverified model. --skip-model-check exists only
  // for offline unit tests of the refusal/decision paths; a real dispatch must verify the endpoint.
  if (!has("--skip-model-check")) {
    try {
      const models = await servedModels();
      out.servedModels = models;
      if (!(models.length === 1 && models[0] === REQUIRED_MODEL)) {
        out.error = "MODEL_MISMATCH";
        out.detail = `expected the single served model ${REQUIRED_MODEL}, saw ${JSON.stringify(models)}`;
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        process.exit(4);
      }
    } catch (e) {
      out.error = "ENDPOINT_UNREACHABLE";
      out.detail = String(e && e.message || e);
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      process.exit(4);
    }
  } else { out.modelCheck = "SKIPPED"; }

  const promptFile = flag("--prompt-file");
  const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : (freshSession ? freshSessionPrompt(runId, { phase }) : resumePrompt(runId));
  const configFile = flag("--config-file");
  let attempt = 0;
  for (;;) {
    const run = findRunKey(stateDir, runId)?.run || {};
    const decision = decideRecovery({
      status: run.status, inFlight: run.execution?.inFlight, hostLive: hostLive(project),
      sessionId, attempt, maxAttempts, allowStatus, freshSession,
    });
    out.attempts.push({ attempt, status: run.status, receiptsBefore: (run.receipts || []).length, decision });
    if (decision.action === "refuse") { out.error = decision.reason; out.detail = decision.detail; out.state = run.status; break; }
    if (decision.action === "give_up") {
      out.error = decision.reason; out.detail = decision.detail; out.state = run.status;
      if (run.status === "RECOVERY_REQUIRED" && !has("--no-pause-on-give-up")) {
        const bin = flag("--maintenance-bin") || defaultMaintenanceBin();
        const paused = pauseViaMaintenance({ bin, stateDir, project, runId });
        out.pausedAfterAttemptLimit = paused;
        if (paused.ok) out.state = paused.state || "PAUSED";
      }
      break;
    }
    if (dryRun) { out.ok = true; out.dryRun = true; out.wouldDispatch = true; break; }

    const env = { ...process.env, LONGRUN_STATE_DIR: stateDir };
    if (configFile) env.OPENCODE_CONFIG_CONTENT = fs.readFileSync(configFile, "utf8");
    for (const k of ["LONGRUN_TEST", "LONGRUN_CONTROLLER_FILE", "OPENCODE_CLIENT"]) delete env[k];
    const started = Date.now();
    const spawnArgs = ["run", "--dir", project, "--model", REQUIRED_PROVIDER_MODEL, "--agent", "build", "--format", "json"];
    if (sessionId) spawnArgs.push("--session", sessionId); // a fresh conversation deliberately has none
    spawnArgs.push(prompt);
    const res = spawnSync(OPENCODE_BIN, spawnArgs, {
      env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    const after = findRunKey(stateDir, runId)?.run || {};
    let outcome = evaluateOutcome({ status: after.status, inFlight: after.execution?.inFlight });
    // Adoption is only required when this dispatch was supposed to TAKE OVER a stopped run. A later
    // phase (e.g. the operator-authorised completion after review) continues a run that is already
    // running, so it is judged by its own result instead.
    if (freshSession && ["PAUSED", "RECOVERY_REQUIRED"].includes(run.status)) {
      const newSessionId = extractSessionId(res.stdout);
      const guarded = applyRebindGuard(outcome, { newSessionId, boundSessions: boundSessions(stateDir, runId),
        compactionSessionID: after.compactionSessionID });
      outcome = guarded.outcome;
      out.attempts.at(-1).freshSession = { newSessionId: guarded.newSessionId, boundSessions: guarded.boundSessions,
        compactionSessionID: guarded.compactionSessionID, rebound: guarded.rebound, statusBefore: run.status,
        statusAfter: after.status, receiptsAfter: (after.receipts || []).length };
    }
    out.attempts.at(-1).dispatch = { exitCode: res.status, timedOut: res.error?.code === "ETIMEDOUT", ms: Date.now() - started };
    out.attempts.at(-1).outcome = outcome;
    // Capture the dispatched host's raw output so the recovery is auditable, not just summarised.
    const logDirEarly = flag("--log-dir");
    if (logDirEarly) {
      fs.mkdirSync(logDirEarly, { recursive: true });
      const stem = dispatchLogStem({ logDir: logDirEarly, attempt: attempt + 1, runId,
        phase: freshSession ? phase : null, at: started });
      try { fs.writeFileSync(`${stem}-events.jsonl`, String(res.stdout || "")); } catch {}
      try { fs.writeFileSync(`${stem}-stderr.log`, String(res.stderr || "")); } catch {}
      out.attempts.at(-1).dispatch.eventsFile = `${stem}-events.jsonl`;
    }
    if (!outcome.retry) { out.ok = outcome.recovered; out.state = after.status; break; }
    attempt += 1;
    if (attempt >= maxAttempts) {
      out.error = "ATTEMPT_LIMIT"; out.state = after.status;
      // Leave the run controlled rather than thrashing in recovery, unless told not to.
      if (after.status === "RECOVERY_REQUIRED" && !has("--no-pause-on-give-up")) {
        const bin = flag("--maintenance-bin") || defaultMaintenanceBin();
        const paused = pauseViaMaintenance({ bin, stateDir, project, runId });
        out.pausedAfterAttemptLimit = paused;
        if (paused.ok) out.state = paused.state || "PAUSED";
      }
      break;
    }
  }

  const logDir = flag("--log-dir");
  if (logDir) {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, `recovery-runner-${runId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    out.log = file;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(out.ok ? 0 : (out.error === "ATTEMPT_LIMIT" ? 2 : 3));
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) main().catch((e) => { process.stdout.write("ERROR " + (e && e.message) + "\n"); process.exit(4); });
