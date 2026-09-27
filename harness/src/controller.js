// Long-run Harness — deterministic controller (shared by plugin, tools, CLI).
// Dependency-free: node builtins only (works without bun; importable by Bun or Node ESM).
// No network, no external packages. This file is copied verbatim into the built install.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as EV from "./evidence.mjs";
import * as MEM from "./memory.mjs";
import * as EXEC from "./execution.mjs";

// ---- Run-lifecycle schema (authoritative, shared by plugin + tools + CLI + tests) ----------
// The native longrun tool exposes EXACTLY these actions; no ellipsis, no hidden guessing.
export const LIFECYCLE_SCHEMA_VERSION = "1.2.25";
export const RUN_ACTIONS = [
  "help", "start", "status", "receipts", "next", "checkpoint", "verify", "pause",
  "resume", "complete", "cancel", "reconcile", "memory_init", "memory_refresh", "memory_status",
];
export const ACTION_PARAMS = {
  help: { required: [], optional: ["session"] },
  start: { required: ["request", "criteria"], optional: ["hardGates", "candidateBudget", "timeBudgetHours", "deadlineHours", "toolActionCap", "sameFailureThreshold", "noProgressThreshold", "autoContinue", "checkCatalogue"] },
  status: { required: [], optional: ["run"] },
  receipts: { required: [], optional: ["run", "checkId", "receiptId", "offset", "limit"] },
  next: { required: [], optional: ["run"] },
  checkpoint: { required: [], optional: ["run", "progress"] },
  verify: { required: ["checkId"], optional: ["evidenceClass", "runId"] },
  pause: { required: [], optional: ["run"] },
  resume: { required: [], optional: ["run"] },
  reconcile: { required: [], optional: ["runId"] },
  complete: { required: [], optional: ["run"] },
  cancel: { required: [], optional: ["run", "reason"] },
  memory_init: { required: [], optional: ["maxDepth", "dryRun", "regenerate"] },
  memory_refresh: { required: [], optional: ["maxDepth"] },
  memory_status: { required: [], optional: [] },
};

export const STATES = [
  "READY", "IMPLEMENTING", "VERIFYING", "REPAIRING", "NEEDS_REPLAN",
  "COMPACTING", "RECOVERY_REQUIRED", "PAUSED", "BLOCKED", "COMPLETE",
  "CANCELLED",
];

// ---- Canonical run resolution (§1, v1.2.2): ONE definition of "active run", shared by the
// native `longrun` tool AND native `longrun_verify`. State -> code is EXPLICIT; never collapse
// everything into a single generic "no_active_run". A non-terminal run's state decides whether a
// verification may run; terminal (COMPLETE/CANCELLED) and absent runs return distinct structured
// codes. The tool supplies the candidate run records (resolved from session binding + canonical
// project/worktree identity + an explicit runId); the controller owns the rules.

// States in which a declared check MAY be executed + recorded.
export const RUN_VERIFY_STATES = ["IMPLEMENTING", "VERIFYING", "REPAIRING", "NEEDS_REPLAN"];
// Terminal states: never a verification target, and never block a fresh `start`.
export const RUN_TERMINAL_STATES = ["COMPLETE", "CANCELLED"];
// Resolvable-but-not-eligible states (a verification must first be resumed/reconciled).
export const RUN_STALL_STATES = ["READY", "COMPACTING", "RECOVERY_REQUIRED", "BLOCKED", "PAUSED"];

export function isVerifyEligible(status) { return RUN_VERIFY_STATES.includes(status); }

// Caller holds the run writer lock. Shared by native control and installed
// maintenance so an emergency pause cannot resurrect a terminal run or miss
// the generation change observed by an already-running declared check.
export function pauseRun(run) {
  if (RUN_TERMINAL_STATES.includes(run.status)) return { error: `RUN_${run.status}`, state: run.status };
  run.status = "PAUSED";
  run.autoEnabled = false;
  run.controlGeneration = (run.controlGeneration || 0) + 1;
  return { ok: true, state: "PAUSED", cancelledContinuations: true };
}

// Classify a single run record for verification. Returns {eligible, code, state}.
export function runVerifyCategory(run) {
  if (!run) return { eligible: false, code: "NO_RUN", state: null };
  const s = run.status;
  if (RUN_VERIFY_STATES.includes(s)) return { eligible: true, code: "ELIGIBLE", state: s };
  if (s === "PAUSED") return { eligible: false, code: "RUN_PAUSED", state: s };
  if (s === "COMPLETE") return { eligible: false, code: "RUN_COMPLETE", state: s };
  if (s === "CANCELLED") return { eligible: false, code: "RUN_CANCELLED", state: s };
  return { eligible: false, code: "RUN_STALLED", state: s };
}

// STATUS/display selection: the single authoritative current run for a project. Prefer the most
// recent NON-terminal run; otherwise surface the most recent terminal one (so status can read
// COMPLETE/CANCELLED). `entries` = chronological [{run}]. Returns the entry or null.
export function pickCurrentRun(entries) {
  const list = (entries || []).filter((e) => e && e.run);
  const nonTerm = list.filter((e) => !RUN_TERMINAL_STATES.includes(e.run.status));
  if (nonTerm.length) return nonTerm[nonTerm.length - 1];
  if (list.length) return list[list.length - 1];
  return null;
}

// VERIFY resolution against a single authoritative run. Never silently verifies an arbitrary run
// and never guesses when resolution is ambiguous. `entries` are already project-isolated by the
// caller. explicitRunId restricts to that id; if it is absent for this project it is NO_RUN (not a
// cross-project fallback).
export function resolveVerification({ entries = [], explicitRunId = null } = {}) {
  const withRun = (entries || []).filter((e) => e && e.run);
  if (explicitRunId) {
    const found = withRun.find((e) => e.run.runId === explicitRunId);
    if (!found) return { ok: false, code: "NO_RUN", detail: `run ${explicitRunId} not resolvable in this project/worktree` };
    const cat = runVerifyCategory(found.run);
    if (cat.eligible) return { ok: true, entry: found, run: found.run, runId: found.run.runId };
    return { ok: false, code: cat.code, runId: found.run.runId, state: cat.state, detail: `run ${found.run.runId} is ${cat.state}; not eligible for verification` };
  }
  const active = withRun.filter((e) => !RUN_TERMINAL_STATES.includes(e.run.status));
  if (active.length === 0) return { ok: false, code: "NO_RUN", detail: "no active run in this project (terminal-only or none); a prompt alone is not a run" };
  if (active.length > 1) return { ok: false, code: "AMBIGUOUS_RUN", ids: active.map((e) => e.run.runId), detail: "multiple non-terminal runs; pass an explicit runId" };
  const cat = runVerifyCategory(active[0].run);
  if (cat.eligible) return { ok: true, entry: active[0], run: active[0].run, runId: active[0].run.runId };
  return { ok: false, code: cat.code, runId: active[0].run.runId, state: cat.state, detail: `run ${active[0].run.runId} is ${cat.state}; not eligible for verification` };
}

// Lifecycle verification (§6 + §8): records a receipt + recomputes criterion status/loss WITHOUT
// counting a source candidate. `applyVerification` (candidate accounting) is UNCHANGED for real
// candidate evaluation. A lifecycle verify with unchanged source must leave the candidate count
// at 0, so it is routed here with diagnosticOnly + canChangeAcceptance:false.
export function applyLifecycleVerification(run, opts = {}) {
  return applyVerification(run, { ...opts, diagnosticOnly: true, canChangeAcceptance: false });
}

export const CHECK_STATUSES = [
  "PASS", "FAIL", "ERROR", "TIMEOUT", "SKIPPED", "BLOCKED", "NOT_RUN", "STALE",
];
// Only a valid PASS satisfies a required check.
export function statusSatisfies(status) { return status === "PASS"; }

// Excluded: caches, VCS, and the controller's OWN outputs (so recording evidence never
// self-invalidates). Matched by path segment (dirs) or by basename / suffix (files).
const LEGACY_EXCLUDES = [
  ".git", "node_modules", ".opencode", "longrun-harness", ".longrun",
  "**/RESUME.md", "**/*.longrun-receipt.json",
];

// Schema 2 excludes known generated outputs. Tests, source, manifests and configuration remain
// inputs. Legacy hashes are computed separately, never rewritten into historical receipts.
export const SOURCE_FINGERPRINT_SCHEMA = 2;
const DEFAULT_EXCLUDES = [...LEGACY_EXCLUDES,
  "dist", "coverage", "test-results", "playwright-report", ".cache", ".DS_Store",
  "**/CHECKPOINT.md", "**/*.tsbuildinfo",
];
function generatedEvidence(p) {
  return /^artifacts\/.*\.(png|jpe?g|webp|mp4|webm|zip|log|json)$/i.test(p);
}

function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function rel(p, root) { return path.relative(root, p).split(path.sep).join("/"); }
function isExcluded(relPath, excludes) {
  const parts = relPath.split("/");
  const last = parts[parts.length - 1];
  for (const e of excludes) {
    // a bare name (no slash) excludes the path if ANY segment equals it (dir) or basename equals it
    if (!e.startsWith("**/")) {
      if (parts.includes(e) || last === e) return true;
      continue;
    }
    const tail = e.slice(3); // strip "**/"
    if (tail.startsWith("*.")) { if (last.endsWith(tail.slice(1))) return true; }
    else if (last === tail) return true;
  }
  return false;
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || "").toString(), code: r.status };
}

// ---- Identity (§4): key by canonical repo/worktree identity AND run id.
// Git: worktree root + HEAD. Non-git: keyed by ABSOLUTE path (never group all non-git together).
export function projectIdentity(root) {
  const abs = path.resolve(root);
  const g = git(abs, ["rev-parse", "--show-toplevel"]);
  if (g.ok && g.out.trim()) {
    const top = path.resolve(g.out.trim());
    const head = git(top, ["rev-parse", "HEAD"]);
    const inside = git(top, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.ok && inside.out.trim() === "true") {
      return { kind: "git", id: `git:${top}`, root: top, head: head.ok ? head.out.trim() : null };
    }
  }
  // Non-git / git-dir-less: stable id from absolute path so two dirs never share state.
  return { kind: "dir", id: `dir:${abs}`, root: abs, head: null };
}
export function stateKey(identity, runId) {
  return sha256(`${identity.id}\u0000${runId}`).slice(0, 32);
}

function routingFailure(detail, code = "ROUTING_STORE_ERROR") {
  return Object.assign(new Error(detail), { code });
}
export async function withStoreRoutingLock(dir, callback) {
  if (!dir) throw routingFailure("state directory unavailable");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ROUTING.lock"), token = crypto.randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() })); acquired = true; }
      finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw routingFailure(`routing lock unavailable (${error.code || error.name})`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  if (!acquired) throw routingFailure("another host owns the routing transaction or its lock needs recovery; no lifecycle mutation was started. Retry after that host finishes; preserve an abandoned lock for inspected recovery.", "ROUTING_BUSY");
  try {
    return await callback();
  } finally {
    try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file); } catch {}
  }
}

// ---- Append-only store with an append-only event log + locks (§4).
export class Store {
  constructor(dir) { this.dir = dir; }
  keyPath(key) {
    const p = path.join(this.dir, "state", key);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }
  _file(key, name) { return path.join(this.keyPath(key), name); }
  readJSON(key, name) {
    try { return JSON.parse(fs.readFileSync(this._file(key, name), "utf8")); } catch { return null; }
  }
  // Canonical lifecycle reads distinguish absent records from damaged storage.
  // Diagnostic readJSON's tolerant fallback is inappropriate for mutations.
  readRun(key) {
    let text;
    try { text = fs.readFileSync(path.join(this.dir, "state", key, "run.json"), "utf8"); }
    catch (error) { return { error: error.code === "ENOENT" ? "NO_RUN" : "STATE_READ_ERROR", detail: error.code || error.message }; }
    try {
      const run = JSON.parse(text);
      if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("expected a canonical run object");
      return { run };
    } catch (error) { return { error: "STATE_CORRUPT", detail: error.message }; }
  }
  // Atomic write: tmp + rename. Never a destructive reset.
  writeJSON(key, name, value) {
    const final = this._file(key, name);
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, final);
    return final;
  }
  // Append-only event log with dedup. Returns true if newly appended, false if duplicate.
  appendEvent(key, event) {
    const log = this._file(key, "events.log");
    let seen = [];
    try { seen = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).dedupeKey; } catch { return null; } }); } catch {}
    if (event.dedupeKey && seen.includes(event.dedupeKey)) return false;
    fs.appendFileSync(log, JSON.stringify(event) + "\n");
    return true;
  }
  // Non-blocking writer lock (acquire/release), never held across model/test/subprocess I/O.
  tryLock(key, token) {
    const lock = path.join(this.keyPath(key), "WRITER.lock");
    try {
      if (fs.existsSync(lock)) {
        const cur = fs.readFileSync(lock, "utf8");
        let info = {}; try { info = JSON.parse(cur); } catch {}
        // stale if pid gone
        if (info.pid && !procAlive(info.pid)) { try { fs.rmSync(lock); } catch {} }
      }
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) { if (e && e.code === "EEXIST") return false; throw e; }
  }
  releaseLock(key) { try { fs.rmSync(path.join(this.keyPath(key), "WRITER.lock")); } catch {} }
  whoHoldsLock(key) { try { return JSON.parse(fs.readFileSync(path.join(this.keyPath(key), "WRITER.lock"), "utf8")); } catch { return null; } }
  // Re-read under the short writer lock, so a checkpoint/pause cannot be overwritten
  // by a verifier's pre-subprocess snapshot. Callbacks must be synchronous.
  mutate(key, callback) {
    const token = crypto.randomUUID();
    if (!this.tryLock(key, token)) return { error: "STATE_BUSY", detail: "another writer is committing; retry the same operation" };
    try {
      const found = this.readRun(key);
      if (found.error) return found;
      const { run } = found;
      const result = callback(run);
      if (!result?.error) this.writeJSON(key, "run.json", run);
      return result;
    } finally { this.releaseLock(key); }
  }
}
function procAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ---- Source fingerprint (§7): tracked + untracked + deletions/renames.
// Returns {hash, manifest}. Deletions are recorded as `!DELETED:<rel>`.
export function sourceFingerprint(root, opts = {}) {
  const legacy = opts.schemaVersion === 1;
  const excludes = [...(legacy ? LEGACY_EXCLUDES : DEFAULT_EXCLUDES), ...(opts.extraExcludes || [])];
  const excluded = (p) => isExcluded(p, excludes) || (!legacy && generatedEvidence(p));
  const rootAbs = path.resolve(root);
  const entries = [];
  const id = projectIdentity(rootAbs);
  if (id.kind === "git" && id.head) {
    const tracked = git(id.root, ["ls-files"]);
    const untracked = git(id.root, ["ls-files", "--others", "--exclude-standard"]);
    const trackedFiles = tracked.ok ? tracked.out.split("\n").filter(Boolean).map((f) => path.join(id.root, f)) : [];
    const untrackedFiles = untracked.ok ? untracked.out.split("\n").filter(Boolean).map((f) => path.join(id.root, f)) : [];
    for (const f of [...trackedFiles, ...untrackedFiles]) {
      const r = rel(f, id.root);
      if (excluded(r)) continue;
      if (exists(f)) entries.push(`${r}:${sha256(fs.readFileSync(f))}`);
      else entries.push(`!DELETED:${r}`);
    }
  } else {
    // Non-git: bounded deterministic walk, exclude listed patterns + hidden caches.
    const stack = [rootAbs]; const visited = new Set();
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const d = stack.pop();
      let items; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const it of items) {
        const full = path.join(d, it.name);
        const r = rel(full, rootAbs);
        if (excluded(r)) continue;
        if (it.isDirectory()) { if (!visited.has(full)) { visited.add(full); stack.push(full); } }
        else if (it.isFile()) { if (exists(full)) entries.push(`${r}:${sha256(fs.readFileSync(full))}`); }
      }
    }
  }
  entries.sort();
  return { hash: sha256(entries.join("\n")), schemaVersion: legacy ? 1 : SOURCE_FINGERPRINT_SCHEMA, count: entries.length, kind: id.kind, head: id.head, ...(!legacy ? { legacyHash: sourceFingerprint(root, { ...opts, schemaVersion: 1 }).hash } : {}) };
}

// ---- Contract + loss (§5)
// contract = { criteria:[{id, required, checks:[checkId], weight, status, evidenceFingerprint}],
//              gates:[{id, required, status}], evaluator?:{...}, revision }
export function defaultLoss(contract) {
  const req = (contract.criteria || []).filter((c) => c.required);
  if (req.length === 0) return { error: "empty_required_set" };
  const denom = req.reduce((s, c) => s + (c.weight ?? 1), 0);
  if (!(denom > 0)) return { error: "zero_denominator" };
  // Missing/stale/unverified evidence counts as unsatisfied (numerator).
  const num = req.reduce((s, c) => s + (statusSatisfies(c.status) ? 0 : (c.weight ?? 1)), 0);
  const loss = num / denom;
  if (!Number.isFinite(loss)) return { error: "non_finite" };
  return { loss, target: 0, num, denom };
}
export function evaluateEvaluatorResult(result) {
  // Invalid / missing / non-finite / out-of-domain => evaluator error, never a good score.
  if (!result || typeof result !== "object") return { error: "invalid_evaluator_output" };
  const v = result.value;
  if (typeof v !== "number" || !Number.isFinite(v) || Number.isNaN(v)) return { error: "non_finite_or_missing_value" };
  if (typeof result.direction === "number") { /* domain bound supplied by evaluator */ }
  return { ok: true, value: v, schemaValid: !!result.schemaValid };
}

// Contract-only callers (without a receipt store or check catalogue) can evaluate explicit
// declarations. Tracked runs NEVER use cached criterion/gate statuses as evidence.
function declarationOnly(run) { return !Array.isArray(run.receipts) && !run.checkCatalogue; }
function currentHash(fp) { return typeof fp === "object" && fp ? fp.hash : fp; }

// Operator review is independent of check success. It is an audited workflow
// boundary, not an OS sandbox against actors with arbitrary state-file access.
export function completionReviewBasis(run, currentFingerprint = run.sourceFingerprint) {
  // A recorded budget amendment changes the effective limits, so it is part of the basis. Runs with
  // no amendments hash EXACTLY as before (the extra key is omitted), so historical reviews are not
  // invalidated merely by upgrading the harness.
  const amendments = Array.isArray(run.budgetAmendments) && run.budgetAmendments.length ? { budgetAmendments: run.budgetAmendments } : {};
  return sha256(JSON.stringify({ runId: run.runId, directory: run.directory,
    originalRequest: run.originalRequest, createdAt: run.createdAt, budget: run.budget,
    ...amendments,
    contract: run.contract, contractHash: run.contractHash, evaluatorHash: run.evaluatorHash,
    checkCatalogue: run.checkCatalogue, sourceFingerprint: currentHash(currentFingerprint),
    receipts: run.receipts, evidence: run.evidence, candidates: run.state?.candidates,
    verificationMs: run.execution?.verificationMs, commandAttempts: run.execution?.commandAttempts }));
}
export function completionReviewStatus(run, currentFingerprint = run.sourceFingerprint) {
  if (declarationOnly(run)) return { required: false, status: "NOT_APPLICABLE", basis: null };
  const basis = completionReviewBasis(run, currentFingerprint);
  const latest = Array.isArray(run.completionReviews) ? run.completionReviews.at(-1) : null;
  const valid = latest?.schemaVersion === 1 && latest?.source === "operator_cli" &&
    typeof latest.id === "string" && typeof latest.reason === "string" &&
    ["accept", "reject"].includes(latest.verdict) && Number.isFinite(latest.at);
  const status = !valid ? "REQUIRED" : latest.basis !== basis ? "STALE" : latest.verdict === "accept" ? "ACCEPTED" : "REJECTED";
  return { required: true, status, basis, reviewId: valid ? latest.id : null,
    reason: valid ? latest.reason : null,
    guidance: "Green checks alone do not authorize completion. Pause for an independent operator review. The installed maintenance review command records it; model checkpoints and complete arguments cannot grant approval." };
}

// Caller holds the writer lock. All refusals precede mutation/archive writes.
// Archive is required before rejecting a recorded COMPLETE; normal pause/resume
// remain unable to reopen terminal records.
export function recordCompletionReview(run, { verdict, reason, expectedBasis, reviewId,
  currentFingerprint, archive, now = Date.now() } = {}) {
  if (!["accept", "reject"].includes(verdict) || typeof reason !== "string" || !reason.trim() || reason.length > 4000 ||
      typeof reviewId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(reviewId) ||
      typeof expectedBasis !== "string" || !/^[a-f0-9]{64}$/.test(expectedBasis) || !currentHash(currentFingerprint))
    return { error: "INVALID_COMPLETION_REVIEW" };
  if (run.completionReviews !== undefined && !Array.isArray(run.completionReviews)) return { error: "INVALID_REVIEW_HISTORY" };
  const history = run.completionReviews || [];
  if (history.some(r => !r || typeof r !== "object" || r.schemaVersion !== 1 || typeof r.id !== "string")) return { error: "INVALID_REVIEW_HISTORY" };
  if (run.status === "CANCELLED") return { error: "RUN_CANCELLED", state: run.status };
  if (run.execution?.inFlight) return { error: "VERIFY_IN_FLIGHT" };
  const prior = history.find(r => r.id === reviewId);
  if (prior) {
    if (prior.basis !== expectedBasis || prior.verdict !== verdict || prior.reason !== reason.trim()) return { error: "REVIEW_ID_CONFLICT" };
    if (completionReviewBasis(run, currentFingerprint) !== expectedBasis) return { error: "REVIEW_BASIS_CHANGED" };
    return { ok: true, alreadyRecorded: true, reviewId, state: run.status, completionReview: completionReviewStatus(run, currentFingerprint) };
  }
  if (run.status !== "PAUSED" && !(verdict === "reject" && run.status === "COMPLETE"))
    return { error: "REVIEW_REQUIRES_PAUSE", state: run.status };
  const basis = completionReviewBasis(run, currentFingerprint);
  if (basis !== expectedBasis) return { error: "REVIEW_BASIS_CHANGED", currentBasis: basis };
  if (verdict === "accept" && !deriveRunView(run, { currentFingerprint }).declaredChecksReady)
    return { error: "REVIEW_CHECKS_NOT_READY" };
  const previousState = run.status;
  const before = JSON.stringify(run, null, 2);
  let archivedSnapshot = null;
  if (previousState === "COMPLETE") {
    if (typeof archive !== "function") return { error: "REVIEW_ARCHIVE_REQUIRED" };
    try { archivedSnapshot = archive(JSON.parse(before), reviewId); }
    catch (e) { return { error: "REVIEW_ARCHIVE_FAILED", detail: e.code || e.message }; }
    if (typeof archivedSnapshot !== "string" || !archivedSnapshot) return { error: "REVIEW_ARCHIVE_FAILED" };
  }
  const record = { schemaVersion: 1, id: reviewId, at: now, source: "operator_cli", verdict,
    reason: reason.trim(), basis, sourceFingerprint: currentHash(currentFingerprint),
    previousState, priorRunHash: sha256(before), archivedSnapshot };
  run.completionReviews = [...history, record];
  run.status = "PAUSED"; run.autoEnabled = false;
  run.controlGeneration = (run.controlGeneration || 0) + 1;
  return { ok: true, state: run.status, reviewId, verdict, archivedSnapshot,
    completionReview: completionReviewStatus(run, currentFingerprint) };
}

export async function operatorCompletionReview(store, key, args) {
  return withStoreRoutingLock(store.dir, () => store.mutate(key, run => {
    if (!args.directory || !args.runId || run.runId !== args.runId || !run.directory ||
        projectIdentity(args.directory).root !== projectIdentity(run.directory).root)
      return { error: "REVIEW_RUN_MISMATCH" };
    // Rejecting COMPLETE reopens a project slot. Serialize against native start
    // and refuse if a later, different task already occupies that slot.
    if (run.status === "COMPLETE" && args.verdict === "reject") {
      for (const name of fs.readdirSync(path.join(store.dir, "state"))) {
        if (name === key || !/^[a-f0-9]{32}$/.test(name)) continue;
        const other = store.readRun(name);
        if (other.error) return other;
        if (other.run.directory && projectIdentity(other.run.directory).root === projectIdentity(args.directory).root &&
            !RUN_TERMINAL_STATES.includes(other.run.status))
          return { error: "EXISTING_RUN", runId: other.run.runId, detail: "Another task already occupies this project; no terminal record was reopened." };
      }
    }
    return recordCompletionReview(run, { ...args, currentFingerprint: sourceFingerprint(args.directory),
      archive: (snapshot, id) => {
        const file = path.join(store.keyPath(key), `completion-review-${id}.json`), bytes = JSON.stringify(snapshot, null, 2);
        try { fs.writeFileSync(file, bytes, { flag: "wx" }); }
        catch (e) { if (e.code !== "EEXIST" || fs.readFileSync(file, "utf8") !== bytes) throw e; }
        return file;
      } });
  }));
}

// ---- v1.2.20 audited operator-only budget amendment -----------------------------------------
// A finite additional candidate allowance and/or a new ABSOLUTE deadline granted after the
// original limits were exhausted/expired. The original budget, deadline, usage, receipts, contract
// and failure history are preserved byte-for-byte; only an append-only amendment record plus a
// control-generation increment are added. It NEVER resumes a run and NEVER implies acceptance.
// Reachable ONLY through the installed maintenance CLI (not RUN_ACTIONS / ACTION_PARAMS), so the
// native model tool surface has no amendment action. Like the operator completion review this is an
// auditable workflow boundary, not an OS sandbox against arbitrary state-file access.
export const AMENDMENT_SCHEMA_VERSION = 1;
const AMENDMENT_MAX_ADDITIONAL = 1000;
const AMENDMENT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;

// Original vs effective limits, for status/readouts and for the operator preparing a grant.
export function budgetAmendmentStatus(run, now = Date.now()) {
  const original = run.budget || defaultBudget();
  const baseIterations = Number.isFinite(original.iterations) ? original.iterations : defaultBudget().iterations;
  const t = EXEC.timing(run, now);
  const originalDeadlineAt = EXEC.originalTiming(run, now).deadlineAt;
  const list = Array.isArray(run.budgetAmendments) ? run.budgetAmendments : [];
  return {
    schemaVersion: AMENDMENT_SCHEMA_VERSION,
    count: list.length,
    original: {
      iterations: baseIterations, deadlineAt: originalDeadlineAt,
      deadlineSeconds: Number.isFinite(original.deadlineSeconds) ? original.deadlineSeconds : null,
      activeSeconds: Number.isFinite(original.activeSeconds) ? original.activeSeconds : null,
      toolActionCap: Number.isFinite(original.toolActionCap) ? original.toolActionCap : null,
    },
    additionalCandidates: EXEC.effectiveIterations(run) - baseIterations,
    effective: { iterations: EXEC.effectiveIterations(run), deadlineAt: t.deadlineAt },
    amendments: list,
  };
}

// Caller holds the run writer lock. Every refusal precedes any mutation.
export function applyBudgetAmendment(run, { amendmentId, additionalCandidates, newDeadlineAt, authorization, reason,
  expectedRevision, expectedBasis, now = Date.now() } = {}) {
  if (typeof amendmentId !== "string" || !AMENDMENT_ID_RE.test(amendmentId))
    return { error: "INVALID_AMENDMENT", detail: "amendmentId must be 8..80 characters of [A-Za-z0-9_-]" };
  if (!Number.isInteger(additionalCandidates) || additionalCandidates < 1 || additionalCandidates > AMENDMENT_MAX_ADDITIONAL)
    return { error: "INVALID_AMENDMENT", detail: `additionalCandidates must be an integer 1..${AMENDMENT_MAX_ADDITIONAL}` };
  if (!Number.isFinite(newDeadlineAt) || Math.abs(newDeadlineAt) > 8640000000000000)
    return { error: "INVALID_AMENDMENT", detail: "newDeadlineAt must be a valid absolute epoch-ms timestamp" };
  if (typeof authorization !== "string" || !authorization.trim() || authorization.length > 4000)
    return { error: "INVALID_AMENDMENT", detail: "explicit authorization text is required (<=4000 chars)" };
  if (typeof reason !== "string" || !reason.trim() || reason.length > 4000)
    return { error: "INVALID_AMENDMENT", detail: "a reason is required (<=4000 chars)" };
  if (!Number.isInteger(expectedRevision))
    return { error: "INVALID_AMENDMENT", detail: "expectedRevision (current controlGeneration) is required" };
  if (typeof expectedBasis !== "string" || !HEX64_RE.test(expectedBasis))
    return { error: "INVALID_AMENDMENT", detail: "expectedBasis (current canonical basis) is required" };
  if (run.budgetAmendments !== undefined && !Array.isArray(run.budgetAmendments)) return { error: "INVALID_AMENDMENT_HISTORY" };
  const history = run.budgetAmendments || [];
  if (history.some(a => !a || typeof a !== "object" || a.schemaVersion !== AMENDMENT_SCHEMA_VERSION || typeof a.id !== "string"))
    return { error: "INVALID_AMENDMENT_HISTORY" };
  if (RUN_TERMINAL_STATES.includes(run.status)) return { error: `RUN_${run.status}`, state: run.status };
  if (run.status !== "PAUSED") return { error: "AMENDMENT_REQUIRES_PAUSE", state: run.status };
  if (run.execution?.inFlight) return { error: "VERIFY_IN_FLIGHT" };
  const auth = authorization.trim(), why = reason.trim();
  const prior = history.find(a => a.id === amendmentId);
  if (prior) {
    // An exact repeat is an idempotent no-op; the same id with different content is a conflict.
    if (prior.additionalCandidates !== additionalCandidates || prior.newDeadlineAt !== newDeadlineAt ||
        prior.authorization !== auth || prior.reason !== why)
      return { error: "AMENDMENT_ID_CONFLICT", detail: "this amendmentId is already recorded with different content" };
    return { ok: true, alreadyApplied: true, amendmentId, state: run.status, budgetLimit: budgetAmendmentStatus(run, now) };
  }
  const basis = completionReviewBasis(run, run.sourceFingerprint);
  if (basis !== expectedBasis) return { error: "AMENDMENT_BASIS_CHANGED", currentBasis: basis };
  const revision = run.controlGeneration || 0;
  if (revision !== expectedRevision) return { error: "AMENDMENT_REVISION_CHANGED", currentRevision: revision };
  const t = EXEC.timing(run, now);
  const currentEffective = t.deadlineAt;
  const originalDeadlineAt = EXEC.originalTiming(run, now).deadlineAt;
  if (!(newDeadlineAt > now)) return { error: "AMENDMENT_DEADLINE_NOT_FUTURE", detail: new Date(newDeadlineAt).toISOString() };
  if (currentEffective !== null && !(newDeadlineAt > currentEffective))
    return { error: "AMENDMENT_DEADLINE_NOT_EXTENDING", currentDeadlineAt: currentEffective };
  const record = {
    schemaVersion: AMENDMENT_SCHEMA_VERSION, id: amendmentId, at: now, source: "operator_cli",
    additionalCandidates, authorization: auth, reason: why,
    originalBudget: {
      iterations: Number.isFinite(run.budget?.iterations) ? run.budget.iterations : defaultBudget().iterations,
      deadlineSeconds: run.budget?.deadlineSeconds ?? null, activeSeconds: run.budget?.activeSeconds ?? null,
      toolActionCap: run.budget?.toolActionCap ?? null,
    },
    originalDeadlineAt, previousEffectiveCandidates: EXEC.effectiveIterations(run),
    previousEffectiveDeadlineAt: currentEffective, newDeadlineAt,
    effectiveCandidatesAfter: EXEC.effectiveIterations(run) + additionalCandidates,
    expectedRevision: revision, priorRunHash: sha256(JSON.stringify(run, null, 2)),
  };
  run.budgetAmendments = [...history, record];
  run.controlGeneration = revision + 1;
  return { ok: true, state: run.status, amendmentId, amendment: record, budgetLimit: budgetAmendmentStatus(run, now) };
}

export async function operatorBudgetAmendment(store, key, args = {}) {
  return withStoreRoutingLock(store.dir, () => store.mutate(key, run => {
    if (!args.directory || !args.runId || run.runId !== args.runId || !run.directory ||
        projectIdentity(args.directory).root !== projectIdentity(run.directory).root)
      return { error: "AMENDMENT_RUN_MISMATCH" };
    return applyBudgetAmendment(run, args);
  }));
}

export function effectiveLoss(run, currentFingerprint = run.sourceFingerprint) {
  const criteria = (run.contract?.criteria || []).map(c => ({ ...c,
    status: criterionSatisfied(run, c, currentFingerprint).satisfied ? "PASS" : "FAIL" }));
  return defaultLoss({ ...run.contract, criteria });
}
export function effectiveRemaining(run, currentFingerprint = run.sourceFingerprint) {
  return (run.contract?.criteria || []).filter(c => c.required && !criterionSatisfied(run, c, currentFingerprint).satisfied).map(c => c.id);
}

// The sole lifecycle projection. Pure: no receipt, contract, budget or legacy summary migration.
export function deriveRunView(run, { currentFingerprint = run.sourceFingerprint, projectMemoryStatus = null, now = Date.now() } = {}) {
  const criteria = (run.contract?.criteria || []).map(c => ({ id: c.id, required: !!c.required,
    checks: c.checks || [], needs: c.evidenceClass || null, ...criterionSatisfied(run, c, currentFingerprint) }));
  const checks = [...new Set([...Object.keys(run.checkCatalogue || {}),
    ...(run.contract?.criteria || []).flatMap(c => c.checks || []),
    ...(run.contract?.gates || []).flatMap(g => g.checks?.length ? g.checks : [g.id])])]
    .map(id => checkDiagnostics(run, id, currentFingerprint));
  const gates = gateStatuses(run, currentFingerprint);
  const hardGateBlockers = gates.filter(g => !g.satisfied);
  const remaining = criteria.filter(c => c.required && !c.satisfied).map(c => c.id);
  const ev = evidenceStatus(run, currentFingerprint), loss = effectiveLoss(run, currentFingerprint);
  // Replay receipt prefixes using their recorded identities, under the CURRENT contract and
  // evaluator. Cached lossBefore/lossAfter/best/current are not qualifying evidence.
  const history = [];
  const prefix = [];
  for (const r of run.receipts || []) {
    prefix.push(r);
    if (!isProjectReceipt(r) || !r.sourceFingerprint) continue;
    const historicalFp = { hash: r.sourceFingerprint, legacyHash: r.sourceFingerprint, schemaVersion: r.fingerprintSchemaVersion || 1 };
    const l = effectiveLoss({ ...run, receipts: prefix }, historicalFp);
    if (!l.error) history.push({ loss: l.loss, receiptId: receiptId(run, r) });
  }
  const currentLoss = loss.loss ?? null;
  const values = [...history.map(x => x.loss), currentLoss].filter(Number.isFinite);
  const bestLoss = values.length ? Math.min(...values) : null;
  const targetLoss = run.contract?.lossTarget ?? 0;
  let blockReason = null;
  if (hardGateBlockers.length) blockReason = hardGateBlockers.every(g => g.kind === "STALE_EVIDENCE") ? "stale_evidence" : "hard_gates_failed";
  else if (remaining.length) blockReason = "required_unverified";
  else if (loss.error) blockReason = "loss_error";
  else if (!(currentLoss <= targetLoss + 1e-9)) blockReason = "loss_above_target";
  else if (run.faults?.length) blockReason = "controller_fault";
  const declaredChecksReady = blockReason === null;
  const completionReview = completionReviewStatus(run, currentFingerprint);
  if (!blockReason && completionReview.required && completionReview.status !== "ACCEPTED")
    blockReason = `completion_review_${completionReview.status.toLowerCase()}`;
  const memory = projectMemoryStatus || { status: "UNKNOWN", reasons: ["project memory was not supplied"], perNode: {} };
  return { state: run.status, runId: run.runId || null, currentFingerprint: currentHash(currentFingerprint) || null,
    currentLoss, loss: currentLoss, bestLoss, targetLoss, lossError: loss.error || null,
    criterionStates: criteria, checks, gates, hardGateStates: gates, hardGateBlockers,
    remaining, outstanding: criteria.filter(c => c.required && !c.satisfied),
    evidenceGaps: ev.gaps, failures: ev.failures, staleEvidence: checks.filter(c => c.staleReason),
    completionBlocked: blockReason !== null, blockReason, declaredChecksReady, completionReview,
    candidateCount: EV.candidateCount(run), candidates: `${EV.candidateCount(run)}/${EXEC.effectiveIterations(run)}`,
    budgets: run.budget || defaultBudget(), budgetLimit: budgetAmendmentStatus(run, now),
    controlRevision: run.controlGeneration || 0,
    // Binds the CANONICAL RECORD as stored (its own last-verified source fingerprint), not the live
    // working tree, so an operator can read the basis here and pass it to `amend` unchanged. A
    // working-tree edit is orthogonal to a budget/deadline grant and stays unverified regardless.
    amendmentBasis: declarationOnly(run) ? null : completionReviewBasis(run, run.sourceFingerprint),
    timing: EXEC.timing(run, now), executionUsage: EXEC.usage(run), counters: { iterations: EV.candidateCount(run), activeMs: null,
      verificationMs: EXEC.usage(run).verificationMs, commandAttempts: EXEC.usage(run).commandAttempts,
      activeTimeNote: "total agent active time is not fully observed; verificationMs covers declared checks only",
      noProgressStreak: run.state?.noProgressStreak || 0, sameFailureStreak: run.state?.sameFailureStreak || 0 },
    memoryStatus: memory.status, memory, continuation: false, lifecycleGuidance: LIFECYCLE_GUIDANCE, agentProgress: run.agentProgress || null,
    effectiveReceiptRefs: checks.filter(c => c.effectiveStatus === "PASS").map(c => c.effectiveReceiptId),
    historicalReceiptCount: (run.receipts || []).length,
    legacyCachedLoss: { loss: run.loss ?? null, current: run.state?.current?.loss ?? run.state?.current?.lossAfter ?? null,
      best: run.state?.best?.loss ?? run.state?.best?.lossAfter ?? null },
    bestLossBasis: "current projection and receipt-prefix replay under current contract/evaluator; cached summaries excluded" };
}
export function canComplete(run, opts = {}) {
  const view = opts.view || deriveRunView(run, opts);
  return { ...view, complete: !view.completionBlocked, reason: view.blockReason,
    hardFails: view.hardGateBlockers.map(g => g.id), blocking: view.hardGateBlockers,
    reqFails: view.remaining };
}

// Routine tool readouts must not repeat command logs throughout the check table.
// Keep the canonical view/calculation intact; detailed receipts are read separately.
export function summarizeRunView(view) {
  const compact = ({ historicalReceipts, effectiveReceipt, ...check }) => check;
  return { ...view, checks: view.checks.map(compact), staleEvidence: view.staleEvidence.map(compact),
    receiptDetails: { action: "receipts", runId: view.runId,
      params: "Optional checkId, offset and limit (1..20) list receipt metadata; receiptId retrieves one receipt with its actual output tail.",
      omittedFromStatus: ["historicalReceipts", "effectiveReceipt"], canonicalHistoryPreserved: true } };
}

// (v1.2.2) A second, duplicate copy of the canonical run resolver + lifecycle-verification block
// once lived here and shadowed the single canonical definition near STATES above. Removed: there is
// now exactly ONE definition of "active run", shared by the native `longrun` tool and `longrun_verify`.

// ---- Contract completeness at START (§5, v1.2.1): a required criterion must be SATISFIABLE. ----
// A required criterion can only ever reach PASS via a receipt from a DECLARED check. A criterion
// that declares no checks, or checks absent from checkCatalogue, is doomed to a permanent
// EVIDENCE_GAP (the v1.2.0 commissioning bug: LC-001 had evidenceClass STATIC but no mapped
// check, so loss could never reach zero). We refuse to create such a run: no fabricated PASS, no
// criterion that can never be verified. Returns {ok, problems:[{criterionId, missingChecks, reason}]}.
export function validateStartContract({ criteria = [], checkCatalogue = {} } = {}) {
  const cat = checkCatalogue || {};
  const problems = [];
  for (const c of criteria) {
    if (c.required === false) continue;
    const id = c.id || "(unnamed)";
    const checks = Array.isArray(c.checks) ? c.checks : [];
    if (checks.length === 0) { problems.push({ criterionId: id, missingChecks: ["<none-declared>"], reason: "required criterion has no mapped check" }); continue; }
    const missing = checks.filter((k) => !Array.isArray(cat[k]?.command));
    if (missing.length) problems.push({ criterionId: id, missingChecks: missing, reason: "mapped check(s) absent from checkCatalogue" });
  }
  return { ok: problems.length === 0, problems };
}


// ---- Receipts (§7)
// Only a valid PASS satisfies; ZERO discovered tests cannot satisfy a test-coverage requirement;
// console optimism is ignored — exit code + discovered counts decide.
// `fpScope` records WHICH root the source fingerprint was measured against: "project" (the real
// tracked worktree) or a foreign scope ("fixture"/"copy"/"subprocess" — an isolated temp copy, a
// negative-control fixture, or a subprocess working dir). Foreign-scope receipts are NEVER allowed
// to satisfy OR invalidate a project check (they only prove a verifier is live / is sabotaged).
export function makeReceipt({ checkId, command, exitCode, output = "", testCount, startedAt, finishedAt, versions = {}, contractHash, evaluatorHash, sourceFingerprint, requirementKind, evidenceClass, proxyOnly, fpScope, fingerprintSchemaVersion }) {
  let status = "PASS";
  if (exitCode === "TIMEOUT") status = "TIMEOUT";
  else if (exitCode === "BLOCKED") status = "BLOCKED";
  else if (exitCode === "ERROR") status = "ERROR";
  else if (exitCode !== 0) status = "FAIL";
  // Zero discovered tests cannot satisfy a TEST-COVERAGE requirement. This gate applies ONLY to a
  // declared test requirement; a NON-TEST hard gate (build/typecheck, kind "cmd") is satisfied by a
  // clean exit and must never be forced to produce a test receipt.
  else if (requirementKind === "test" && (typeof testCount !== "number" || testCount === 0)) status = "NOT_RUN";
  const cls = evidenceClass || (proxyOnly ? "STATIC" : undefined);
  return {
    checkId, command, status, exitCode,
    testCount: typeof testCount === "number" ? testCount : null,
    startedAt, finishedAt,
    versions, contractHash, evaluatorHash,
    sourceFingerprint, fingerprintSchemaVersion, fpScope: fpScope || "project",
    evidenceClass: cls, class: cls, proxyOnly: !!proxyOnly || EV.PROXY_ONLY.has(cls),
    // a receipt is only valid if recorded against a still-current fingerprint
    _validateAgainst: (currentFp) => currentFp === sourceFingerprint ? status : "STALE",
  };
}
export function resolveReceiptStatus(receipt, currentFingerprint) {
  return currentFingerprint === receipt.sourceFingerprint ? receipt.status : "STALE";
}

// ---- Authoritative effective-receipt model (§1/§2, v1.2.3) ----------------------------------
// ONE definition of "what does this check currently prove", shared by status, the verify readout,
// replay, completion detection and hard-gate calculation. Rules:
//  * Only PROJECT-scope receipts decide a project check. A fixture/copy/subprocess-scope result
//    never satisfies AND never invalidates the real project (a sabotage run against a copied
//    workspace cannot turn the project's build red, and a healthy-fixture negative control is not
//    positive evidence).
//  * Of the project receipts, the AUTHORITATIVE one is the most recent (by finishedAt, then by
//    insertion order). This is the anti-masking rule: a NEWER failure is not hidden behind an older
//    pass, and a NEWER restore-pass is not hidden behind an older failure.
//  * A PASS only satisfies on CURRENT source. A pass measured against a different (stale) project
//    fingerprint is STALE, never trusted; an old PASS is never kept "just because it says PASS".
function isProjectReceipt(r) {
  return r && (r.fpScope == null || r.fpScope === "project") && r.mode !== "negative" && r.kind !== "negative_control";
}
export function projectReceiptsFor(run, checkId) {
  return (run?.receipts || []).filter(r => r.checkId === checkId && isProjectReceipt(r));
}
function receiptId(run, r) {
  return r.receiptId || r.id || `receipt-${(run.receipts || []).indexOf(r) + 1}-${sha256(JSON.stringify(r)).slice(0, 12)}`;
}
function receiptEligibility(run, r, fp) {
  if (!isProjectReceipt(r)) return "NON_PROJECT_EVIDENCE";
  if (!r.sourceFingerprint) return "LEGACY_STALE_MISSING_FINGERPRINT";
  if (run.contractHash && r.contractHash !== run.contractHash) return r.contractHash ? "CONTRACT_MISMATCH" : "LEGACY_STALE_MISSING_CONTRACT_HASH";
  if (run.evaluatorHash && r.evaluatorHash !== run.evaluatorHash) return "EVALUATOR_MISMATCH";
  if (r.fingerprintSchemaVersion && ![1, SOURCE_FINGERPRINT_SCHEMA].includes(r.fingerprintSchemaVersion)) return "FINGERPRINT_SCHEMA_INCOMPATIBLE";
  const current = typeof fp === "object" && fp ? ((r.fingerprintSchemaVersion || 1) === 1 ? fp.legacyHash : fp.hash) : fp;
  if (!current) return "CURRENT_FINGERPRINT_UNAVAILABLE";
  if (r.sourceFingerprint !== current) return "SOURCE_FINGERPRINT_MISMATCH";
  return r.status === "STALE" ? r.staleReason || "STALE_RECEIPT" : null;
}
export function effectiveReceipt(run, checkId, currentFingerprint = run.sourceFingerprint) {
  const list = projectReceiptsFor(run, checkId);
  if (!list.length) return null;
  const best = list.reduce((a, b) => (b.finishedAt || 0) >= (a.finishedAt || 0) ? b : a);
  const staleReason = receiptEligibility(run, best, currentFingerprint);
  return { receipt: best, receiptId: receiptId(run, best), status: staleReason ? "STALE" : best.status, staleReason };
}
export function checkDiagnostics(run, checkId, currentFingerprint) {
  const all = (run.receipts || []).filter(r => r.checkId === checkId);
  const e = effectiveReceipt(run, checkId, currentFingerprint);
  const describe = r => describeReceipt(run, r, currentFingerprint);
  const historicalReceipts = all.slice(-20).map(describe);
  return { checkId, effectiveStatus: e?.status || "NOT_RUN", effectiveReceiptId: e && !e.staleReason ? e.receiptId : null,
    selectedReceiptId: e?.receiptId || null, effectiveReceipt: e && !e.staleReason ? describe(e.receipt) : null,
    historicalReceiptCount: all.length, historicalReceipts, historicalReceiptsTruncated: all.length > 20,
    staleReason: e?.staleReason || null, receiptFingerprint: e?.receipt.sourceFingerprint || null,
    currentFingerprint: currentHash(currentFingerprint) || null,
    comparisonFingerprint: typeof currentFingerprint === "object" && currentFingerprint ? ((e?.receipt.fingerprintSchemaVersion || 1) === 1 ? currentFingerprint.legacyHash : currentFingerprint.hash) : currentFingerprint || null,
    blockingReason: e?.status === "PASS" ? null : e?.staleReason || e?.status || "NO_RECEIPT" };
}
function describeReceipt(run, r, currentFingerprint) {
  return { receiptId: receiptId(run, r), historicalStatus: r.status,
    command: r.command ?? null, argv: r.argv ?? null, exitCode: r.exitCode ?? null,
    testCount: r.testCount ?? null,
    testCountMeaning: "Legacy acceptance count; zero can mean a failed or unrecognized summary, not necessarily zero discovered tests.",
    reportedTests: reportedTestSummary(r.outputTail),
    startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
    versions: r.versions ?? null, fpScope: r.fpScope ?? null,
    outputTail: typeof r.outputTail === "string" ? r.outputTail.slice(-6000) : null,
    terminationReason: r.terminationReason ?? null, executionError: r.executionError ?? null,
    order: (run.receipts || []).indexOf(r) + 1, createdAt: r.finishedAt ?? r.startedAt ?? null,
    evidenceClass: r.evidenceClass || r.class || null, receiptFingerprint: r.sourceFingerprint || null,
    classification: receiptEligibility(run, r, currentFingerprint) || "ELIGIBLE",
    missingField: !r.sourceFingerprint ? "sourceFingerprint" : null };
}
export function receiptReadout(run, { currentFingerprint = run.sourceFingerprint, checkId, receiptId: selected, offset = 0, limit = 10 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    return { error: "INVALID_RECEIPT_PAGE", detail: "offset must be a nonnegative integer; limit must be 1..20" };
  const all = (run.receipts || []).filter(r => checkId === undefined || r.checkId === checkId);
  if (selected !== undefined) {
    const r = all.find(r => receiptId(run, r) === selected);
    return r ? { ok: true, runId: run.runId, checkId: r.checkId, receipt: describeReceipt(run, r, currentFingerprint) }
      : { error: "RECEIPT_NOT_FOUND", runId: run.runId, receiptId: selected };
  }
  return { ok: true, runId: run.runId, checkId: checkId ?? null, total: all.length, offset, limit,
    nextOffset: offset + limit < all.length ? offset + limit : null,
    receipts: all.slice(offset, offset + limit).map(r => {
      const { outputTail, ...metadata } = describeReceipt(run, r, currentFingerprint);
      return { checkId: r.checkId, ...metadata, outputAvailable: typeof r.outputTail === "string" };
    }), detail: "Metadata only; request action=receipts with receiptId for the recorded output tail. Historical status does not imply current eligibility." };
}
export function effectiveStatus(run, checkId, currentFingerprint) {
  const e = effectiveReceipt(run, checkId, currentFingerprint);
  return e ? e.status : "NOT_RUN";
}

// ---- Hard-gate evaluation (v1.2.3): recompute, never trust a cached gate status --------------
// A required gate maps to check(s): its explicit `checks` list, else — if the gate's own id is a
// declared check with receipts — [gate.id]. If it maps to NOTHING we fall back to the cached
// `status` (back-compat for hand-declared gates like "test-gate"/"render-gate" that carry no check
// and are satisfied by a human/external declaration). Otherwise the gate is satisfied only when
// EVERY mapped check's AUTHORITATIVE effective status is PASS on current source. A gate therefore
// needs its OWN passing (cmd) receipt — no fabricated test receipt, and no reliance on the loss
// number — and a passing build can complete a test-only run.
export function evaluateGate(run, gate, currentFingerprint) {
  const receipts = (run && run.receipts) || [];
  const checks = (Array.isArray(gate.checks) && gate.checks.length)
    ? gate.checks.slice()
    : ((run.checkCatalogue?.[gate.id] || receipts.some((r) => r && r.checkId === gate.id)) ? [gate.id] : []);
  if (checks.length === 0) {
    return { id: gate.id, checks: [], status: declarationOnly(run) ? gate.status || "FAIL" : "NOT_RUN", satisfied: declarationOnly(run) && statusSatisfies(gate.status), kind: "NO_MAPPED_CHECK", detail: declarationOnly(run) ? "contract-only declaration" : "gate declares no mapped check; recorded status is not evidence" };
  }
  const eff = checks.map((id) => ({ id, status: effectiveStatus(run, id, currentFingerprint) }));
  const hard = eff.filter((e) => ["FAIL", "ERROR", "TIMEOUT", "BLOCKED"].includes(e.status));
  if (hard.length) return { id: gate.id, checks, status: "FAIL", satisfied: false, kind: "HARD_GATE_FAILED", detail: hard };
  const unverified = eff.filter((e) => e.status === "NOT_RUN" || e.status === undefined);
  if (unverified.length) return { id: gate.id, checks, status: "NOT_RUN", satisfied: false, kind: "HARD_GATE_UNVERIFIED", detail: unverified };
  const stale = eff.filter((e) => e.status === "STALE");
  if (stale.length) return { id: gate.id, checks, status: "STALE", satisfied: false, kind: "STALE_EVIDENCE", detail: stale };
  const pass = eff.filter((e) => e.status === "PASS");
  const ok = pass.length === checks.length;
  return { id: gate.id, checks, status: ok ? "PASS" : "FAIL", satisfied: ok, kind: ok ? "SATISFIED" : "HARD_GATE_FAILED", detail: eff };
}
// The recomputed gate table for a run (used by status, the verify readout AND completion).
export function gateStatuses(run, currentFingerprint) {
  const fp = currentFingerprint != null ? currentFingerprint : (run && run.sourceFingerprint) || null;
  return (run && run.contract && run.contract.gates || []).filter((g) => g.required).map((g) => evaluateGate(run, g, fp));
}

// ---- Test-count parsing (v1.2.3): supply discovered counts for genuine test runners ----------
// The controller must never rely on console optimism, but for a DECLARED test requirement it needs
// the discovered count to decide PASS vs a zero-test NOT_RUN. Best-effort extraction from common
// runner output (node:test "tests N", vitest "Tests  N passed", playwright "N passed"). If a
// runner reports zero discovered tests the result is 0 (=> NOT_RUN). Returns null when no count is
// discoverable (caller then treats a clean exit as a plain cmd PASS, not a coverage requirement).
export function parseTestCounts(text) {
  if (!text) return null;
  const t = String(text);
  let m = /(?:Tests\s+)(\d+)\s+failed/i.exec(t); if (m) return +m[1] > 0 ? 0 : (/Tests\s+\d+\s+passed/i.test(t) ? (+(/Tests\s+(\d+)\s+passed/i.exec(t)[1])) : null);
  m = /Tests\s+(\d+)\s+passed/i.exec(t); if (m) return +m[1];
  m = /ℹ\s+tests?\s+(\d+)/i.exec(t); if (m) return +m[1];
  m = /(\d+)\s+(?:tests?|specs?)\s+(?:passed|ok)/i.exec(t); if (m) return +m[1];
  m = /RESULT\s+pass=(\d+)/i.exec(t); if (m) return +m[1];
  m = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(t); if (m) return +m[1];
  return null;
}

// Read-only runner-reported diagnostics, never an acceptance input. Historical receipts are
// not rewritten. Only a complete, internally consistent Vitest summary is recognized; absent
// categories stay unknown, and multiple summaries may be separate commands, so are declined.
function reportedTestSummary(outputTail) {
  if (typeof outputTail !== "string") return null;
  const text = outputTail.slice(-6000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^Tests\s/.test(line));
  if (lines.length !== 1) return null;
  const match = /^Tests\s+(.+?)\s+\((\d+)\)$/.exec(lines[0]);
  if (!match) return null;
  const total = Number(match[2]);
  if (!Number.isSafeInteger(total)) return null;
  const counts = { passed: null, failed: null, skipped: null, todo: null };
  for (const part of match[1].split("|")) {
    const item = /^(\d+)\s+(passed|failed|skipped|todo)$/.exec(part.trim());
    if (!item || counts[item[2]] !== null || !Number.isSafeInteger(Number(item[1]))) return null;
    counts[item[2]] = Number(item[1]);
  }
  if (Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0) !== total) return null;
  return { source: "recorded_output_tail", runner: "vitest", total, ...counts, summary: lines[0] };
}

// ---- Structured tool-input normalization (v1.2.3) --------------------------------------------
// MTPLX sometimes sends a structured field as a JSON STRING and numeric/boolean params as strings.
// This is the SINGLE authoritative place that recognises those params (no per-action ad-hoc patch).
// It NEVER invents data: a non-string/non-JSON value is returned untouched; a malformed JSON string
// yields a safe fallback (empty for arrays/objects), so a bad value can never masquerade as a run.
function coerceList(v) { if (Array.isArray(v)) return v; if (typeof v === "string") { const t = v.trim(); if (t.startsWith("[") || t.startsWith("{")) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : (p && typeof p === "object" ? [p] : []); } catch { return []; } } } return []; }
function coerceObj(v) { if (v && typeof v === "object" && !Array.isArray(v)) return v; if (typeof v === "string") { const t = v.trim(); if (t.startsWith("{")) { try { const p = JSON.parse(t); return (p && typeof p === "object" && !Array.isArray(p)) ? p : {}; } catch { return {}; } } } return {}; }
function num(v, fallback) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; }
function bool(v) { return v === true || v === "true"; }
export function normalizeStartArgs(args = {}) {
  const out = { ...args };
  if (args.criteria !== undefined) out.criteria = coerceList(args.criteria);
  if (args.checkCatalogue !== undefined) out.checkCatalogue = coerceObj(args.checkCatalogue);
  if (args.hardGates !== undefined) out.hardGates = coerceList(args.hardGates);
  if (args.candidateBudget !== undefined) out.candidateBudget = num(args.candidateBudget, undefined);
  if (args.timeBudgetHours !== undefined) out.timeBudgetHours = num(args.timeBudgetHours, undefined);
  if (args.sameFailureThreshold !== undefined) out.sameFailureThreshold = num(args.sameFailureThreshold, undefined);
  if (args.noProgressThreshold !== undefined) out.noProgressThreshold = num(args.noProgressThreshold, undefined);
  if (args.deadlineHours !== undefined) out.deadlineHours = num(args.deadlineHours, undefined);
  if (args.toolActionCap !== undefined) out.toolActionCap = num(args.toolActionCap, undefined);
  if (args.autoContinue !== undefined) out.autoContinue = bool(args.autoContinue);
  return out;
}

export function validateBudgetArgs(args = {}) {
  for (const name of ["candidateBudget", "timeBudgetHours", "deadlineHours", "toolActionCap", "sameFailureThreshold", "noProgressThreshold"]) {
    if (args[name] === undefined) continue;
    const n = Number(args[name]);
    const integer = !["timeBudgetHours", "deadlineHours"].includes(name);
    if (!(["number", "string"].includes(typeof args[name])) || !Number.isFinite(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER || integer && !Number.isSafeInteger(n))
      return { error: "INVALID_BUDGET", detail: `${name} must be a finite positive ${integer ? "integer" : "number"}; no run created` };
  }
  return { ok: true };
}

// ---- v1.2.22 default evidence class ---------------------------------------------------------
// A declared check that a criterion maps to already declares the evidence strength that criterion
// needs. When the caller omits the optional per-call evidenceClass, derive it from the run's OWN
// contract so a whole-suite round cannot silently record classless receipts and block every
// criterion as UNKNOWN_CLASS despite green checks (observed twice: annotations lr-00000000a1b2 and
// another run lr-00000000c3d4). An explicit argument always wins; an ambiguous mapping (two criteria
// demanding different classes for the same check) or an unmapped check yields null so the caller
// must be explicit rather than guessed at.
export function defaultEvidenceClass(run, checkId, explicit) {
  if (typeof explicit === "string" && explicit) return explicit;
  const classes = new Set();
  for (const criterion of run?.contract?.criteria || []) {
    if (!Array.isArray(criterion.checks) || !criterion.checks.includes(checkId)) continue;
    if (typeof criterion.evidenceClass === "string" && criterion.evidenceClass) classes.add(criterion.evidenceClass);
  }
  return classes.size === 1 ? [...classes][0] : null;
}

// ---- Evidence-strength gate (§7): a criterion is satisfied only when a PASS receipt exists
// whose evidence class is strong enough. A weaker/proxy class is a gap, not a pass.
export function criterionSatisfied(run, criterion, currentFingerprint = run.sourceFingerprint) {
  if (declarationOnly(run)) return { satisfied: statusSatisfies(criterion.status), status: criterion.status, kind: "DECLARATION_ONLY" };
  const checks = criterion.checks || [];
  const effective = checks.map(id => effectiveReceipt(run, id, currentFingerprint));
  if (!checks.length || effective.some(e => !e)) return { satisfied: false, status: "NOT_RUN", kind: "NO_RECEIPT" };
  const blocked = effective.find(e => e.status !== "PASS");
  if (blocked) return { satisfied: false, status: blocked.status, kind: blocked.staleReason || "NO_PASS" };
  const adequate = effective.find(e => EV.classSatisfies(e.receipt.proxyOnly ? "object_exists" : e.receipt.evidenceClass || e.receipt.class, criterion).satisfied);
  if (adequate) return { satisfied: true, status: "PASS", kind: "SATISFIED", receiptId: adequate.receiptId };
  const gap = EV.classSatisfies(effective.at(-1).receipt.evidenceClass, criterion);
  return { satisfied: false, status: "BLOCKED", kind: gap.kind || "EVIDENCE_GAP", note: gap.note };
}
export function evidenceStatus(run, currentFingerprint = run.sourceFingerprint) {
  const failures = [], gaps = [];
  for (const c of run.contract?.criteria || []) {
    if (!c.required) continue;
    const result = criterionSatisfied(run, c, currentFingerprint);
    if (result.satisfied) continue;
    if (["FAIL", "ERROR", "TIMEOUT"].includes(result.status)) failures.push({ criterion: c.id, status: result.status });
    else gaps.push({ criterion: c.id, checks: c.checks || [], missing: [...new Set([c.evidenceClass, ...(c.requiresEvidence || [])].filter(Boolean))], note: result.kind });
  }
  return { failures, gaps };
}

// Append receipt history; cached contract statuses and legacy summaries are preserved verbatim.
export function applyVerification(run, { receipt, canChangeAcceptance = true, diagnosticOnly = false, hypothesis, elapsedMs = 0, currentFingerprint }) {
  const fp = currentFingerprint || receipt?.sourceFingerprint || run.sourceFingerprint;
  const before = deriveRunView(run, { currentFingerprint: fp });
  run.receipts = run.receipts || []; run.receipts.push({ ...receipt, _validateAgainst: undefined });
  const after = deriveRunView(run, { currentFingerprint: fp });
  const changed = after.criterionStates.filter((c, i) => c.status !== before.criterionStates[i]?.status).map(c => c.id);
  const foreign = !isProjectReceipt(receipt);
  const cand = EV.considerCandidate(run, { fingerprint: receipt?.sourceFingerprint || run.sourceFingerprint,
    fingerprintAliases: typeof fp === "object" ? [fp.legacyHash].filter(Boolean) : [],
    evaluated: true, diagnosticOnly: diagnosticOnly || foreign, statusChanged: changed.length > 0, canChangeAcceptance,
    receiptIds: [receiptId(run, run.receipts.at(-1))], criteriaChanged: changed, lossBefore: before.currentLoss,
    lossAfter: after.currentLoss, result: receipt?.status, hypothesis, elapsedMs });
  if (!foreign) run.sourceFingerprint = receipt?.sourceFingerprint || run.sourceFingerprint;
  return { candidate: cand.candidate, counted: cand.counted, changed, lossBefore: before.currentLoss, lossAfter: after.currentLoss, gaps: after.evidenceGaps };
}

// Runs only a previously reserved command, then atomically writes genuine evidence.
// Its caller is a finite separate process so host death cannot erase completed I/O.
export async function executeReservedCheck(job, { ownerLost, aborted } = {}) {
  const { stateDir, runKey, token, runId, checkId, cwd, projectRoot, fixture,
    fpBefore, fpScope, targetFingerprint, productionBefore, evidenceClass, deadlineAt } = job;
  const store = new Store(stateDir), found = store.readRun(runKey);
  if (found.error) throw new Error(found.error);
  const run = found.run, lease = run.execution?.inFlight;
  // Older runs kept the declared catalogue in their session binding. The native
  // reservation captures that resolved declaration without replacing the contract.
  const check = run.checkCatalogue?.[checkId] || lease?.declaredCheck;
  if (!lease || lease.token !== token || lease.executorPid !== process.pid || run.runId !== runId || lease.checkId !== checkId || !Array.isArray(check?.command))
    throw new Error('EXECUTOR_RESERVATION_MISMATCH');
  const negative = lease.mode === 'negative';
  let stateWriteFailed = false;
  const shouldStop = () => {
    if (stateWriteFailed) return 'state_write_failed';
    const current = store.readRun(runKey);
    if (current.error) return 'state_read_failed';
    const latest = current.run;
    if (latest.execution?.inFlight?.token !== token) return 'reservation_changed';
    if (latest.status === 'PAUSED') return 'run_paused';
    if (RUN_TERMINAL_STATES.includes(latest.status)) return 'run_terminal';
    if (latest.status === 'RECOVERY_REQUIRED') return 'recovery_required';
    if ((latest.controlGeneration || 0) !== lease.generation) return 'control_generation_changed';
    if (ownerLost?.()) return 'owner_lost';
    if (aborted?.()) return 'aborted';
    if (deadlineAt !== null && Date.now() >= deadlineAt) return 'deadline_budget';
    return null;
  };
  const timeout = { ...job.timeout };
  if (deadlineAt !== null && deadlineAt - Date.now() < timeout.timeoutMs) {
    timeout.timeoutMs = Math.max(1, deadlineAt - Date.now()); timeout.timeoutReason = 'deadline_budget';
  }
  const r = await EXEC.runCommand(check.command, { cwd: negative ? fixture : cwd, env: process.env, ...timeout, shouldStop,
    onSpawn: pid => {
      const saved = store.mutate(runKey, latest => {
        if (latest.execution?.inFlight?.token !== token) return { error: 'RESERVATION_CHANGED' };
        latest.execution.inFlight.childPid = pid || null; return { ok: true };
      });
      stateWriteFailed = !!saved.error;
    },
  });
  const fp = sourceFingerprint(cwd);
  const timedOut = ['check_timeout', 'active_time_budget', 'deadline_budget'].includes(r.terminationReason);
  const invalid = r.error || r.signal || r.terminationReason || r.status === null;
  const exitCode = timedOut ? 'TIMEOUT' : invalid ? 'ERROR' : r.status;
  const output = r.stdout + r.stderr, outputTail = output.length > 6000 ? '...' + output.slice(-6000) : output;
  let receipt, negativeControl;
  if (negative) {
    const productionAfter = sourceFingerprint(projectRoot).hash;
    const observed = timedOut ? 'TIMEOUT' : invalid ? 'ERROR' : r.status === 0 ? 'PASS' : 'FAIL';
    negativeControl = EV.makeNegativeControl({ checkId, fixture, targetFingerprint, observed, ok: observed === 'FAIL',
      mutatedProduction: productionBefore !== productionAfter, command: check.command, exitCode: r.status,
      signal: r.signal, error: r.error || (r.terminationReason && !timedOut ? r.terminationReason : null),
      startedAt: r.startedAt, finishedAt: r.finishedAt, outputTail,
      productionFingerprintBefore: productionBefore, productionFingerprintAfter: productionAfter });
    negativeControl.terminationReason = r.terminationReason;
  } else {
    receipt = makeReceipt({ checkId, command: check.command.join(' '), exitCode, output,
      testCount: check.kind === 'test' ? (parseTestCounts(output) ?? 0) : undefined,
      requirementKind: check.kind || 'cmd', startedAt: r.startedAt, finishedAt: r.finishedAt,
      versions: { node: process.version }, contractHash: run.contractHash, evaluatorHash: run.evaluatorHash,
      sourceFingerprint: fpBefore.hash, fingerprintSchemaVersion: SOURCE_FINGERPRINT_SCHEMA,
      evidenceClass: evidenceClass && evidenceClass !== 'proxy' ? evidenceClass : undefined,
      proxyOnly: evidenceClass === 'proxy' || check.proxyOnly, fpScope });
    Object.assign(receipt, { argv: check.command, outputTail, terminationReason: r.terminationReason, executionError: r.error, executionToken: token });
    if (fp.hash !== fpBefore.hash) { receipt.status = 'STALE'; receipt.staleReason = 'SOURCE_CHANGED_DURING_CHECK'; }
  }
  const journal = { token, runId, checkId, receipt, negativeControl,
    result: { ...r, stdout: undefined, stderr: undefined }, fingerprintAfter: fp };
  store.writeJSON(runKey, `execution-${token}.json`, journal);
  return journal;
}

// Validate a saved executor result before recovering it. This does not manufacture
// missing evidence, rerun a command, or confer trust on an arbitrary state file.
export function validateExecutionRecord(run, journal) {
  const lease = run.execution?.inFlight, r = journal?.result;
  const bad = detail => ({ error: "INVALID_EXECUTION_RECORD", detail });
  if (!lease || !journal || journal.token !== lease.token || journal.checkId !== lease.checkId ||
      (journal.runId !== undefined && journal.runId !== run.runId)) return bad("record does not match the reserved run/check/token");
  const check = run.checkCatalogue?.[lease.checkId] || lease.declaredCheck, negative = lease.mode === "negative";
  const record = negative ? journal.negativeControl : journal.receipt;
  if (!check || !r || !record || (negative ? journal.receipt : journal.negativeControl)) return bad("missing or conflicting command evidence");
  if (r.cleanupComplete !== true) return { error: "EXECUTION_CLEANUP_UNCONFIRMED", detail: "saved result does not confirm owned process cleanup" };
  if (EXEC.ownedWorkAlive(r.pid) || EXEC.ownedWorkAlive(lease.childPid)) return { error: "VERIFY_IN_FLIGHT" };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hash = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
  if (!Number.isFinite(r.startedAt) || !Number.isFinite(r.finishedAt) || r.finishedAt < r.startedAt ||
      r.startedAt < lease.startedAt || r.finishedAt > Date.now() ||
      record.startedAt !== r.startedAt || record.finishedAt !== r.finishedAt ||
      record.checkId !== lease.checkId || !hash(journal.fingerprintAfter?.hash) ||
      (r.pid !== null && (!Number.isInteger(r.pid) || r.pid <= 0)) ||
      (lease.childPid != null && lease.childPid !== r.pid)) return bad("invalid timing, process or fingerprint evidence");
  if (!(r.status === null || Number.isInteger(r.status) && (r.status >= 0 || r.error)) ||
      (r.pid === null && !r.error && !r.terminationReason) ||
      ![r.signal, r.error, r.terminationReason].every(x => x === null || typeof x === "string")) return bad("invalid process result");
  const timeout = ["check_timeout", "active_time_budget", "deadline_budget"].includes(r.terminationReason);
  const invalid = r.error || r.signal || r.terminationReason || r.status === null;
  const exitCode = timeout ? "TIMEOUT" : invalid ? "ERROR" : r.status;
  if (negative) {
    const observed = timeout ? "TIMEOUT" : invalid ? "ERROR" : r.status === 0 ? "PASS" : "FAIL";
    const changed = record.productionFingerprintBefore !== record.productionFingerprintAfter;
    const expected = EV.makeNegativeControl({ ...record, observed, ok: observed === "FAIL", mutatedProduction: changed });
    if (!same(record.command, check.command) || record.exitCode !== r.status || record.observed !== observed ||
        record.signal !== r.signal || record.terminationReason !== r.terminationReason ||
        record.error !== (r.error || (r.terminationReason && !timeout ? r.terminationReason : null)) ||
        !hash(record.targetFingerprint) || !hash(record.productionFingerprintBefore) || !hash(record.productionFingerprintAfter) ||
        record.expected !== "FAIL" || record.mutatedProduction !== changed || record.ok !== expected.ok || record.valid !== expected.valid ||
        record.executionToken !== undefined && record.executionToken !== lease.token) return bad("negative-control record disagrees with execution");
  } else {
    const status = makeReceipt({ exitCode, requirementKind: check.kind || "cmd", testCount: record.testCount }).status;
    const changed = journal.fingerprintAfter.hash !== record.sourceFingerprint;
    if (!same(record.argv, check.command) || record.command !== check.command.join(" ") ||
        record.executionToken !== lease.token || record.exitCode !== exitCode || record.executionError !== r.error ||
        record.terminationReason !== r.terminationReason || !hash(record.sourceFingerprint) ||
        record.fingerprintSchemaVersion !== SOURCE_FINGERPRINT_SCHEMA ||
        record.contractHash !== run.contractHash || record.evaluatorHash !== run.evaluatorHash ||
        !["project", "copy"].includes(record.fpScope) || record.status !== (changed ? "STALE" : status) ||
        changed && record.staleReason !== "SOURCE_CHANGED_DURING_CHECK") return bad("receipt disagrees with execution or acceptance mapping");
  }
  return { ok: true };
}

// Caller holds Store.mutate's writer lock. Both the original executor and an
// explicit reconciliation use this single commit path, so attempts/time/results
// cannot be counted twice even when the executor retries after recovery.
export function commitExecutionResult(run, journal, { currentFingerprint = journal.fingerprintAfter } = {}) {
  const { token, receipt, negativeControl, result: r } = journal;
  const existing = [...(run.receipts || []), ...(run.evidence || [])].find(x => x.executionToken === token);
  if (existing) return { ok: true, alreadyRecorded: true, apply: { candidate: { counted: false }, gaps: [] }, candidateCount: candidateCount(run), usage: EXEC.usage(run) };
  if (run.execution?.inFlight?.token !== token) return { error: "RESERVATION_CHANGED" };
  const usage = EXEC.initialize(run);
  usage.verificationMs += Math.max(0, r.finishedAt - r.startedAt);
  usage.inFlight = r.cleanupComplete === false ? { ...usage.inFlight, recoveryRequired: "child_cleanup_failed" } : null;
  let apply;
  if (negativeControl) { run.evidence = run.evidence || []; run.evidence.push({ ...negativeControl, executionToken: token }); }
  else apply = applyVerification(run, { receipt, canChangeAcceptance: true, diagnosticOnly: !r.pid,
    hypothesis: run.checkCatalogue?.[journal.checkId]?.hypothesis, elapsedMs: r.finishedAt - r.startedAt, currentFingerprint });
  return { ok: true, apply, candidateCount: candidateCount(run), usage: EXEC.usage(run) };
}

// ---- Single-flight scheduling + generation guard (§8)
// Event dedup, per-run single-flight, current-session generation/message guard.
export class Scheduler {
  constructor(store) { this.store = store; this.inFlight = new Set(); }
  // Returns {dispatch:boolean, reason} . Guards: idle-only is never authorisation; ignore
  // helper/child sessions; dedupe; generation guard; single-flight.
  // (Default deployment keeps AUTO disabled in the plugin; this is the safe core + fixtures.)
  requestContinuation({ runKey, eventId, sessionID, generation, isHelper, state, autoEnabled, pendingGeneration, messageAuthorised }) {
    if (!autoEnabled) return { dispatch: false, reason: "auto_disabled" };
    if (isHelper) return { dispatch: false, reason: "helper_session" };
    if (state !== "IMPLEMENTING" && state !== "VERIFYING" && state !== "REPAIRING") return { dispatch: false, reason: "state_not_continuable" };
    if (!messageAuthorised) return { dispatch: false, reason: "idle_not_authorisation" };
    if (generation != null && pendingGeneration != null && generation !== pendingGeneration) return { dispatch: false, reason: "generation_guard" };
    const dk = `cont:${eventId || ""}:${sessionID}:${generation ?? ""}`;
    if (!this.store.appendEvent(runKey, { type: "continuation", dedupeKey: dk, at: Date.now() })) return { dispatch: false, reason: "duplicate_event" };
    if (this.inFlight.has(runKey)) return { dispatch: false, reason: "single_flight" };
    this.inFlight.add(runKey);
    return { dispatch: true, reason: "scheduled" };
  }
  completeDispatch(runKey) { this.inFlight.delete(runKey); }
  cancelAll() { this.inFlight.clear(); }
}

// ---- Budgets (§8) + counters that persist (store-backed by caller).
export function defaultBudget() {
  // autoDispatchCap bounds automatic continuation dispatches. Automatic continuation is
  // DISABLED unless a run explicitly opts in (see isAutoAllowed). 12/6 are commissioning caps.
  return { iterations: 40, activeSeconds: 4 * 3600, deadlineSeconds: 8 * 3600, sameFailureLimit: 3, noProgressLimit: 5, autoDispatchCap: 40, toolActionCap: 200 };
}
// Commissioning defaults are tighter; used only for an explicitly authorised disposable run.
export function commissioningBudget() {
  return { iterations: 12, activeSeconds: 4 * 3600, deadlineSeconds: 8 * 3600, sameFailureLimit: 3, noProgressLimit: 5, autoDispatchCap: 6, toolActionCap: 200 };
}
// Automatic continuation gate: DEFAULT OFF. Only a run that BOTH opted in AND is flagged
// commissioning may dispatch automatically; ordinary chat / inactive project can never.
export function isAutoAllowed(run) {
  if (!run) return false;
  if (!run.autoEnabled) return false;
  if (run.runMode !== "commissioning") return false;
  const s = run.state || {};
  const cap = (run.budget && run.budget.autoDispatchCap) ?? 40;
  if ((s.autoDispatches || 0) >= cap) return false;
  return true;
}
export function budgetState(budget, counters, nowMs, startedAtMs) {
  const spent = {};
  spent.iterations = counters.iterations >= budget.iterations;
  spent.activeSeconds = (counters.activeMs || 0) / 1000 >= budget.activeSeconds;
  spent.deadline = (nowMs - startedAtMs) / 1000 >= budget.deadlineSeconds;
  spent.sameFailure = (counters.sameFailureStreak || 0) >= budget.sameFailureLimit;
  spent.noProgress = (counters.noProgressStreak || 0) >= budget.noProgressLimit;
  spent.autoTurns = (counters.autoTurns || 0) >= (budget.autoTurnCap ?? 40);
  spent.autoDispatch = (counters.autoDispatches || 0) >= (budget.autoDispatchCap ?? 40);
  spent.toolActions = (counters.toolActions || 0) >= (budget.toolActionCap ?? 200);
  return { exhausted: Object.values(spent).some(Boolean), spent };
}

// Same materially equivalent failure 3x => require new evidence + replan (NEEDS_REPLAN).
// 5 evaluated candidates without meaningful progress => one bounded replan then pause.
export function afterEvaluation(run, { progress, fingerprint, failureSignature }) {
  const s = run.status;
  const st = run.state;
  if (!progress) {
    st.noProgressStreak = (st.noProgressStreak || 0) + 1;
  } else {
    st.noProgressStreak = 0;
  }
  if (failureSignature && failureSignature === st.lastFailureSignature) st.sameFailureStreak = (st.sameFailureStreak || 0) + 1;
  else { st.sameFailureStreak = failureSignature ? 1 : 0; st.lastFailureSignature = failureSignature || null; }
  st.iterations = (st.iterations || 0) + 1;
  const budget = run.budget || defaultBudget();
  if (st.sameFailureStreak >= budget.sameFailureLimit) return { next: "NEEDS_REPLAN", reason: "same_failure_3x" };
  if (st.noProgressStreak >= budget.noProgressLimit) {
    if (!st.replanned) { st.replanned = true; return { next: "NEEDS_REPLAN", reason: "no_progress_replan" }; }
    return { next: "PAUSED", reason: "still_stalled" };
  }
  return { next: s, reason: "continue" };
}

// ---- Best vs current experiment tracking (§8). Keep best verified candidate distinct.
export function recordCandidate(run, cand) {
  const st = run.state;
  st.candidates = st.candidates || [];
  st.candidates.push(cand);
  if (cand.verified && (!st.best || cand.loss <= st.best.loss)) st.best = cand;
  st.current = cand;
}

// ---- Resume authorization (§4,§8): fabricated assistant text or text in a repo file must NOT resume.
// Only a user-authorised CLI/session entry may transition PAUSED/cancelled -> active.
export function canResume(run, origin) {
  if (origin === "user_cli" || origin === "user_session_command") return { ok: true };
  // A repo file, assistant prose, or a stray event cannot resume a cancelled/paused run.
  if (origin === "assistant_text" || origin === "repo_file_text" || origin === "event") return { ok: false, reason: "not_user_authorised" };
  return { ok: false, reason: "unknown_origin" };
}

// Advisory working context has its own whitelist and history. It cannot write status,
// acceptance, receipts, budgets or counters. Legacy runs are unchanged until explicitly saved.
export const LIFECYCLE_GUIDANCE = "Continuation OFF disables automatic scheduling; it does not mean the run is PAUSED. Only the canonical state reports lifecycle. checkpoint saves advisory context without pausing. When authorized work is finished or must stop, explicitly call pause(runId), then confirm state with status(runId). toolActionCap counts declared-check attempts, not help/status/checkpoint calls or all host tools.";
const PROGRESS_SCALAR_LIMITS = { currentSlice: 240, nextAction: 1000 };
const PROGRESS_LIST_FIELDS = ["decisions", "failedHypotheses", "memoryNodes", "artifacts"];
export function progressSchema() {
  return {
    accepts: "object or JSON-encoded object; at least one supported field",
    fields: {
      ...Object.fromEntries(Object.entries(PROGRESS_SCALAR_LIMITS).map(([key, maxLength]) => [key, { type: "string", maxLength }])),
      ...Object.fromEntries(PROGRESS_LIST_FIELDS.map(key => [key, { type: "array", maxItems: 12, itemType: "string", itemMaxLength: 500 }])),
    },
    maxCombinedCharacters: 6000, maxSerializedCharacters: 24000,
    memoryNodes: "relative project paths without parent traversal",
    merge: "Partial fields merge; arrays replace. Advisory only; no status, receipts, budgets or acceptance fields.",
    example: { currentSlice: "Describe the actual work", nextAction: "Describe the remaining action" },
  };
}
export function saveAgentProgress(run, progress, { sessionID = null, fingerprint = null, at = Date.now() } = {}) {
  const scalarLimits = PROGRESS_SCALAR_LIMITS;
  const listFields = PROGRESS_LIST_FIELDS;
  // Called under the canonical writer lock by the native path. No mutation has
  // occurred on these returns; report the state actually inspected, not prose.
  const invalid = detail => ({ error: "INVALID_PROGRESS", detail, runId: run.runId || null,
    state: run.status, continuation: false, unchanged: true, progressSchema: progressSchema(),
    lifecycleGuidance: LIFECYCLE_GUIDANCE,
    correction: "Correct only progress using the supported fields. Do not rerun checks, rewrite state files or reset the run to repair this payload." });
  if (typeof progress === "string") {
    if (progress.length > 24000) return invalid("serialized progress is too large");
    try { progress = JSON.parse(progress); } catch { return invalid("progress must be a JSON object or a valid JSON-encoded object"); }
  }
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return invalid("progress must be an object");
  if (!Object.keys(progress).length) return invalid("provide at least one progress field");
  for (const [key, value] of Object.entries(progress)) {
    if (Object.hasOwn(scalarLimits, key)) {
      if (typeof value !== "string" || value.length > scalarLimits[key]) return invalid(`${key} must be a string of at most ${scalarLimits[key]} characters`);
    } else if (listFields.includes(key)) {
      if (!Array.isArray(value) || value.length > 12 || value.some(x => typeof x !== "string" || x.length > 500)) return invalid(`${key} needs at most 12 strings of at most 500 characters`);
      if (key === "memoryNodes" && value.some(x => !x || path.isAbsolute(x) || x.split(/[\\/]/).includes(".."))) return invalid("memoryNodes must be relative project paths without parent traversal");
    } else return invalid(`unsupported progress field: ${key}`);
  }
  const fields = { ...(run.agentProgress?.fields || {}), ...structuredClone(progress) };
  if (JSON.stringify(fields).length > 6000) return invalid("combined progress exceeds 6000 characters; keep it concise and link artifacts");
  const record = { schemaVersion: 1, revision: (run.agentProgress?.revision || 0) + 1, at, sessionID, sourceFingerprint: fingerprint, fields };
  run.agentProgressHistory = [...(run.agentProgressHistory || []), record];
  run.agentProgress = record;
  return { ok: true, progress: record };
}

// ---- Recovery packet (§9): machine facts plus explicitly advisory working context.
export function buildRecoveryPacket(run, limitWords = 1500, view = deriveRunView(run)) {
  const c = run.contract || {};
  const st = run.state || {};
  const remaining = view.remaining;
  const gaps = view.evidenceGaps;
  const candCount = EV.candidateCount(run);
  const candBudget = EXEC.effectiveIterations(run);
  const originalIterations = Number.isFinite(run.budget?.iterations) ? run.budget.iterations : defaultBudget().iterations;
  const allowance = candBudget - originalIterations;
  const lines = [];
  lines.push(`STATE: ${run.status}`);
  const timing = view.timing || EXEC.timing(run);
  lines.push(`OBSERVED AT: ${new Date(timing.observedAt).toISOString()} (snapshot; time continues during inference and compaction)`);
  lines.push(`DEADLINE: ${timing.deadlineAt === null ? "UNKNOWN (original timestamp or duration missing/invalid; not reconstructed)" : new Date(timing.deadlineAt).toISOString()} (absolute wall clock; never reset)`);
  lines.push(`DEADLINE REMAINING: ${timing.remainingMs === null ? "UNKNOWN" : `${timing.remainingMs} ms at observation`}`);
  if (timing.expired) lines.push("DEADLINE EXPIRED: no further implementation or checks; checkpoint the incomplete outcome and pause. Do not reset budgets, bypass via another tool/session or create a replacement run.");
  lines.push(`CONTRACT HASH: ${run.contractHash || "?"}  EVALUATOR HASH: ${run.evaluatorHash || "?"}`);
  lines.push(`SOURCE FINGERPRINT: ${view.currentFingerprint || "(unknown)"}${run.sourceFingerprintStale ? " [STALE: source changed since last verified]" : ""}`);
  lines.push(`REMAINING CRITERIA: ${remaining.length ? remaining.join(", ") : "(none)"}`);
  lines.push(`EVIDENCE GAPS: ${gaps.length ? gaps.map((g) => `${g.criterion}<-${g.missing.join("+")}`).join(", ") : "(none)"}`);
  lines.push(`CANDIDATES: ${candCount}/${candBudget}${allowance > 0 ? ` (original ${originalIterations} + operator-authorized ${allowance})` : ""} (exact, persisted; never reset by a new conversation)`);
  if ((run.budgetAmendments || []).length) lines.push(`OPERATOR BUDGET AMENDMENTS: ${run.budgetAmendments.length} recorded. Original deadline ${timing.originalDeadlineAt === null ? "UNKNOWN" : new Date(timing.originalDeadlineAt).toISOString()}; effective deadline ${timing.deadlineAt === null ? "UNKNOWN" : new Date(timing.deadlineAt).toISOString()}. Original limits/usage/history preserved; any prior completion approval is invalidated; a grant never resumes the run.`);
  lines.push(`VERIFIED EVIDENCE REFS: ${view.effectiveReceiptRefs.join(", ") || "(none currently eligible)"}`);
  lines.push(`HISTORICAL RECEIPTS: ${view.historicalReceiptCount} (retained; inspect status.checks for eligibility)`);
  lines.push(`HISTORICAL EVIDENCE REFS: ${view.checks.map(c => c.selectedReceiptId).filter(Boolean).join(", ") || "(none recorded)"}`);
  lines.push(`BEST LOSS: ${view.bestLoss ?? "n/a"}   CURRENT LOSS: ${view.currentLoss ?? "n/a"}`);
  lines.push(`TARGET LOSS: ${view.targetLoss}  COMPLETION BLOCKED: ${view.completionBlocked}  REASON: ${view.blockReason || "none"}`);
  if (view.completionReview?.required) lines.push(`COMPLETION REVIEW: ${view.completionReview.status}. Declared checks ready: ${view.declaredChecksReady}. Pause for independent operator review; never self-approve through a shell command or checkpoint. A zero declared-check loss is not full-scope acceptance.`);
  lines.push(`HARD GATE BLOCKERS: ${view.hardGateBlockers.map(g => g.id).join(", ") || "(none)"}`);
  lines.push(`MEMORY STATUS: ${view.memoryStatus}; ${view.memory.reasons.join("; ")}`);
  const progress = run.agentProgress?.fields || st;
  lines.push(`AGENT PROGRESS (advisory; not verification evidence): ${run.agentProgress ? `revision ${run.agentProgress.revision}, saved ${new Date(run.agentProgress.at).toISOString()}; source ${run.agentProgress.sourceFingerprint || "unknown"}` : "legacy fields or not yet saved; use checkpoint(progress=...)"}`);
  lines.push(`CURRENT SLICE: ${progress.currentSlice || "(none)"}`);
  lines.push(`DECISIONS/INVARIANTS: ${(progress.decisions || []).join("; ") || "(none)"}`);
  lines.push(`MEMORY NODES (reload lazily, do NOT dump all): ${[...new Set([...(view.memory.reloadableNodes || []), ...(progress.memoryNodes || run.memoryNodes || [])])].join(", ") || "(root only)"}`);
  lines.push(`UNSUCCESSFUL APPROACHES: ${(progress.failedHypotheses || []).join("; ") || "(none)"}`);
  lines.push(`NEXT ACTION: ${progress.nextAction || "(recompute)"}`);
  lines.push(`ARTIFACT REFERENCES (inspect; not proof by themselves): ${(progress.artifacts || []).join(", ") || "(none)"}`);
  lines.push(`BUDGETS (persisted): iters=${st.iterations || 0} noProgress=${st.noProgressStreak || 0} sameFailure=${st.sameFailureStreak || 0} (legacy counters; not execution authority)`);
  const execution = EXEC.usage(run);
  lines.push(`CHECK EXECUTION: candidates=${view.candidateCount}; commands=${execution.commandAttempts}; verificationMs=${execution.verificationMs}; historicalUsageUnknown=${execution.historicalUsageUnknown}; total agent time/actions unmeasured. In-flight=${execution.inFlight?.token || "none"}.`);
  // Put the authoritative reference/status and working context before a potentially very
  // long original request. Preserve the full request in the record, never relabel an excerpt
  // as verbatim or silently discard the next action behind a request-sized prefix.
  lines.push(`ORIGINAL GOAL (verbatim): ${run.originalRequest || "(none)"}`);
  const out = lines.join("\n");
  const words = out.split(/\s+/).filter(Boolean);
  if (words.length > limitWords) {
    const marked = out.replace("ORIGINAL GOAL (verbatim):", "ORIGINAL GOAL EXCERPT (full verbatim text remains in run.json):");
    const marker = "[truncated; inspect run.json for full context]";
    const available = Math.max(0, limitWords - marker.split(/\s+/).length);
    const packet = marked.split(/\s+/).filter(Boolean).slice(0, available).join(" ") + "\n" + marker;
    return { packet, words: packet.split(/\s+/).filter(Boolean).length, truncated: true, view };
  }
  return { packet: out, words: words.length, truncated: false, view };
}

export const __test = { sha256, isExcluded };

// ---- Re-exports so plugin + CLI can use ONE import surface (controller) -------------------
export const memory = MEM;
export const evidence = EV;
export const execution = EXEC;

// A fixture must be physically separate from the project. Resolve aliases and inspect
// dependencies too: a copied directory with node_modules pointing back is not isolated.
// This is a preflight integrity check, not an OS sandbox for arbitrary catalogue commands.
export function validateNegativeFixture(fixture, projectDirectories = [], { entryBudget = 200000 } = {}) {
  const reject = detail => ({ ok: false, error: "FIXTURE_NOT_ISOLATED", detail });
  const inside = (root, target) => { const rel = path.relative(root, target); return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)); };
  let root;
  try {
    root = fs.realpathSync(fixture);
    if (!fs.statSync(root).isDirectory()) return reject("fixture must be a directory");
    for (const dir of projectDirectories.filter(Boolean)) {
      const project = fs.realpathSync(dir);
      // A filesystem root (e.g. a host that reports context.worktree="/") contains every possible
      // path, so it conveys NO isolation information. Treating it as a project directory rejected
      // every fixture, including one outside $HOME. Real nested/overlapping directories are still
      // refused below; the refusal now names the offending directory.
      if (path.parse(project).root === project) continue;
      if (inside(project, root)) return reject(`fixture and production project overlap: fixture ${root} is inside project directory ${project}`);
      if (inside(root, project)) return reject(`fixture and production project overlap: fixture ${root} contains project directory ${project}`);
    }
    const stack = [root];
    let count = 0;
    while (stack.length) {
      const directory = stack.pop();
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++count > entryBudget) return reject("fixture isolation scan exceeded its entry budget");
        const file = path.join(directory, item.name);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
          const target = fs.realpathSync(file);
          if (!inside(root, target)) return reject(`fixture symlink escapes its root: ${path.relative(root, file)}`);
        } else if (stat.isDirectory()) stack.push(file);
        else if (stat.isFile() && stat.nlink > 1) return reject(`fixture contains a shared hard link: ${path.relative(root, file)}`);
        else if (!stat.isFile()) return reject(`fixture contains a special file: ${path.relative(root, file)}`);
      }
    }
    return { ok: true, fixture: root, inspectedEntries: count };
  } catch (error) { return reject(`cannot establish fixture isolation: ${error.code || error.message}`); }
}
export const candidateCount = (run) => EV.candidateCount(run);
export const classSatisfies = (a, b) => EV.classSatisfies(a, b);

// ---- Authoritative run construction (§5): `start` must create a REAL run ------------------
// Builds a stable contract from declared criteria (with evidence classes + gates) and an initial
// run record. It does NOT fabricate a PASS anywhere; initial loss reflects unverified criteria.
export function makeContract({ criteria = [], hardGates = [], lossTarget = 0 } = {}) {
  const crit = criteria.map((c, i) => {
    const id = c.id || `c${i + 1}`;
    return { id, required: c.required !== false, weight: c.weight ?? 1, checks: c.checks || [], evidenceClass: c.evidenceClass || null, visual: !!c.visual, status: "FAIL" };
  });
  const gates = hardGates.map((g, i) => typeof g === "string" ? { id: g, required: true, status: "FAIL" } : { ...g, id: g.id || `g${i + 1}`, required: g.required !== false, status: g.status || "FAIL" });
  return { criteria: crit, gates, lossTarget };
}
export function startRun({ request, contract, budgets, sourceFingerprint, memoryStatus, continuation = false, runId, directory, checkCatalogue = {} }) {
  const loss = defaultLoss(contract);
  if (loss.error) return { error: loss.error, hint: "a run needs >=1 required criterion with a positive weight" };
  const run = {
    runId: runId || ("lr-" + crypto.randomBytes(6).toString("hex")),
    status: "IMPLEMENTING",
    originalRequest: request || "",
    contract, contractHash: sha256(JSON.stringify(contract)),
    evaluatorHash: null,
    sourceFingerprint: sourceFingerprint || null,
    loss: loss.loss,
    budget: budgets || defaultBudget(),
    autoEnabled: !!continuation, runMode: "tracked",
    memoryStatus: memoryStatus || "UNKNOWN",
    state: { iterations: 0, noProgressStreak: 0, sameFailureStreak: 0, candidates: [], lastEvalFingerprint: sourceFingerprint || null, memoryNodes: ["AGENTS.md"] },
    receipts: [], faults: [],
    execution: { schemaVersion: 1, since: Date.now(), historicalUsageUnknown: false, verificationMs: 0, commandAttempts: 0, inFlight: null },
    directory: directory || null, checkCatalogue,
    createdAt: Date.now(),
  };
  return { run, initialLoss: loss.loss, contractHash: run.contractHash };
}

// ---- Ledger / schema health for `doctor` ---------------------------------------------------
export function runHealth(run) {
  if (!run) return { ok: true, state: "NO_RUN", candidateLedger: "empty", evidence: "n/a" };
  const st = run.state || {};
  const ledger = (st.candidates || []);
  const badCandidate = ledger.find((c) => c.counted && (c.fingerprint == null || c.lossBefore == null && c.lossAfter != null));
  const ev = evidenceStatus(run);
  return {
    ok: !badCandidate,
    state: run.status,
    candidateLedger: `${EV.candidateCount(run)} counted / ${ledger.length} recorded`,
    evidence: `${ev.gaps.length} gaps; ${ev.failures.length} failures`,
    issues: [badCandidate ? "candidate ledger inconsistency" : null, ...ev.gaps.map((g) => `gap ${g.criterion}`)].filter(Boolean),
  };
}
