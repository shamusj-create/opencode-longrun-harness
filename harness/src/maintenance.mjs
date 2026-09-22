#!/usr/bin/env node
// Long-run maintenance entry point. Copied into the built install and run from ANY cwd
// WITHOUT the source repository. Resolves its own controller + installer copy by relative
// URL (reuses existing logic; no competing controller). Node-builtin only (works under the
// Electron/Node desktop runtime too). Run via the `longrun` launcher or:
//   node longrun.mjs <doctor [--live]|status|pause|review|amend|disable|enable|uninstall> [--json] [--project PATH]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ---- resolve installed siblings regardless of layout (bin/ vs src/) ----
function firstExisting(urls) {
  for (const u of urls) { try { if (fs.existsSync(new URL(u))) return u; } catch {} }
  return null;
}
const CTRL_URLS = ["../lib/controller.js", "./controller.js", "file://" + (process.env.LONGRUN_CONTROLLER_FILE || "")].filter(Boolean);
const INST_URLS = ["../lib/install.mjs", "./install.mjs"];
const ctrlUrl = firstExisting(CTRL_URLS.map((p) => (p.startsWith("file://") ? p : new URL(p, import.meta.url).href)));
const instUrl = firstExisting(INST_URLS.map((p) => new URL(p, import.meta.url).href));

function cfgDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  return path.resolve(path.join(process.env.HOME || os.homedir(), ".config", "opencode"));
}
function stateDir() { return process.env.LONGRUN_STATE_DIR || path.join(os.homedir() || os.tmpdir(), ".local", "state", "opencode-longrun", "v1"); }
function currentVersion() { try { return fs.readFileSync(path.join(cfgDir(), "longrun-harness", "current"), "utf8").trim(); } catch { return null; } }

async function loadMods() {
  if (!ctrlUrl) throw new Error("controller copy not found next to maintenance entry point");
  const C = await import(ctrlUrl);
  const I = instUrl ? await import(instUrl) : null;
  return { C, I };
}

// ---- doctor: TWO documented modes ----
// INSTALL mode (default): structural integrity of the owned install.
// LIVE mode (--live): requires an OBSERVED current-desktop load + hook activity. Must NOT
// report success for awaiting-restart / unverified. Machine-readable.
async function doctor({ live = false }) {
  const cfg = cfgDir();
  const res = { mode: live ? "live-readiness" : "install", configDir: cfg, ok: true, notes: [], degraded: [], failures: [] };
  const ver = currentVersion();
  if (!ver) { res.ok = false; res.notes.push("not installed"); return res; }
  res.installedVersion = ver;
  // resolve the controller the maintenance entry point will actually execute
  try { res.executedController = path.relative(cfg, new URL(ctrlUrl).pathname) || ctrlUrl; } catch { res.executedController = ctrlUrl; }
  res.reportedVsExecutedVersion = "see installedVersion + executedController";
  if (!ctrlUrl) { res.ok = false; res.degraded.push("controller copy missing -> plugin cannot load"); return res; }
  // structural: verify manifest-listed files still present + hash-match (user edits are fine = "preserved")
  const { C, I } = await loadMods();
  res.executedControllerVersion = C.LIFECYCLE_SCHEMA_VERSION;
  if (C.LIFECYCLE_SCHEMA_VERSION !== ver || I?.VERSION !== ver) {
    res.ok = false; res.degraded.push("release pointer / executed controller / installer version mismatch");
  }
  const mfPath = path.join(cfg, "longrun-harness", "releases", ver, "manifest.json");
  let manifest = null; try { manifest = JSON.parse(fs.readFileSync(mfPath, "utf8")); } catch {}
  if (!manifest) { res.ok = false; res.degraded.push("manifest missing"); return res; }
  let missing = 0, edited = 0;
  for (const f of manifest.files) {
    const abs = path.join(cfg, f.rel);
    let buf; try { buf = fs.readFileSync(abs); } catch { missing++; continue; }
    if (crypto.createHash("sha256").update(buf).digest("hex") !== f.sha256) { edited++; res.notes.push("user-edited (preserved): " + f.rel); }
  }
  if (missing) { res.ok = false; res.degraded.push(`${missing} installed files missing`); }
  // no duplicate registration: plugin file must not ALSO be named in a config plugin[]
  for (const cfgf of ["opencode.json", "opencode.jsonc"]) {
    const p = path.join(cfg, cfgf); if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, "utf8");
    if (/"plugin"\s*:/.test(txt) && /longrun/.test(txt)) res.degraded.push(`possible duplicate plugin registration in ${cfgf}`);
  }
  if (!fs.existsSync(path.join(cfg, "plugins", "longrun.js"))) res.degraded.push("plugin file absent -> will not load next start");
  res.notes.push("plugins are NOT an OS security sandbox; integrity checks are not tamper-proofing");

  // ---- v1.2.1 subsystem report (structural; do NOT weaken the --live rules below) ----
  try {
    res.harnessVersion = ver;
    res.pluginShape = (await import("file://" + path.join(cfg, "plugins", "longrun.js"))).default && typeof (await import("file://" + path.join(cfg, "plugins", "longrun.js"))).default.server === "function" ? "v1-server-plugin" : "UNKNOWN";
  } catch { res.pluginShape = "unknown (import failed)"; }
  res.runLifecycleSchema = { version: C.LIFECYCLE_SCHEMA_VERSION, actions: C.RUN_ACTIONS, noEllipsis: true };
  res.memorySubsystem = {
    present: !!(C.memory && typeof C.memory.initDeep === "function" && typeof C.memory.assessStaleness === "function"),
    maxDepth: C.memory ? C.memory.DEFAULT_MAX_DEPTH : null,
    agentsDiscovery: !!(C.memory && typeof C.memory.scanTree === "function"),
    lspUsed: false, note: "deterministic filesystem signals; LSP/structural probes not wired (marked unmeasured, never failed on their absence)",
  };
  const projArg = (() => { const i = process.argv.indexOf("--project"); return i >= 0 ? process.argv[i + 1] : null; })();
  const projDir = projArg || process.cwd();
  const idx = C.memory && C.memory.readMemoryIndex(projDir);
  res.memoryIndex = { project: projDir, present: !!idx, status: idx ? C.memory.assessStaleness(projDir, idx).status : "NO_MEMORY (optional)", schemaValid: !!idx && idx.schemaVersion === C.memory.SCHEMA_VERSION };
  res.candidateLedger = { schemaVersion: 1, note: "candidate counters persist in run.json state; no active run to audit from doctor" };
  res.evidenceSchema = { present: !!(C.evidence && Array.isArray(C.evidence.EVIDENCE_CLASSES)), classes: C.evidence ? C.evidence.EVIDENCE_CLASSES : [], verifyRejectsWeakerClass: true };
  // ---- v1.2.3 authoritative receipt model + hard-gate recomputation (a real structural check) ----
  // Doctor must not just confirm files exist; it self-tests that (a) there is ONE effective-receipt
  // definition (no duplicate resolver), (b) a copied/fixture result cannot invalidate a project
  // check, and (c) a hard gate is RECOMPUTED from evidence (a passing build can complete). If any
  // part is missing/damaged the check FAILS (degraded), so a partial install is never reported healthy.
  let rm;
  try {
    const fns = ["effectiveReceipt", "effectiveStatus", "evaluateGate", "gateStatuses", "normalizeStartArgs", "parseTestCounts", "deriveRunView", "checkDiagnostics"];
    const present = fns.every((f) => typeof C[f] === "function");
    // exactly one resolver + one lifecycle-verification block: count the canonical marker
    let ctrlSrc = ""; try { ctrlSrc = fs.readFileSync(new URL(ctrlUrl), "utf8"); } catch {}
    const resolverDefs = (ctrlSrc.match(/export function resolveVerification/g) || []).length;
    const singleResolver = resolverDefs === 1;
    const CUR = "doctor-selftest-fp";
    const pass = C.makeReceipt({ checkId: "c-build", command: "b", exitCode: 0, requirementKind: "cmd", sourceFingerprint: CUR, startedAt: 1, finishedAt: 2 });
    const copyFail = C.makeReceipt({ checkId: "c-build", command: "b", exitCode: 1, requirementKind: "cmd", sourceFingerprint: "copy-fp", startedAt: 3, finishedAt: 4, fpScope: "copy" });
    const run = { status: "VERIFYING", sourceFingerprint: CUR, faults: [], receipts: [copyFail, pass], contract: { criteria: [{ id: "ENG", required: true, checks: ["c-build"], status: "PASS" }], gates: [{ id: "c-build", required: true, status: "FAIL" }], lossTarget: 0 } };
    const copyIgnored = C.effectiveStatus(run, "c-build", CUR) === "PASS";
    const unreviewedBlocked = C.canComplete(run, { currentFingerprint: CUR }).reason === "completion_review_required";
    run.status = "PAUSED";
    const reviewed = C.recordCompletionReview(run, { verdict: "accept", reason: "In-memory doctor self-test only; never product evidence.",
      reviewId: "doctor-selftest", currentFingerprint: CUR, expectedBasis: C.completionReviewBasis(run, CUR) });
    const gateRecomputed = C.canComplete(run, { currentFingerprint: CUR }).complete === true;
    const noMask = (() => { const r2 = JSON.parse(JSON.stringify(run)); r2.receipts = [pass, C.makeReceipt({ checkId: "c-build", command: "b", exitCode: 1, requirementKind: "cmd", sourceFingerprint: CUR, startedAt: 5, finishedAt: 6 })]; return C.effectiveStatus(r2, "c-build", CUR) === "FAIL"; })();
    rm = { singleSource: present && singleResolver, singleResolver, copySabotageIgnored: copyIgnored, gateRecomputedToComplete: gateRecomputed, failMasksOldPass: noMask };
    rm.unreviewedCompletionBlocked = unreviewedBlocked;
    rm.reviewedCompletionAllowed = reviewed.ok === true && gateRecomputed;
    rm.ok = present && singleResolver && copyIgnored && gateRecomputed && noMask && unreviewedBlocked && reviewed.ok === true;
    if (!rm.ok) { res.ok = false; res.degraded.push("receipt model self-test failed (effective-receipt / gate recomputation not intact)"); }
  } catch (e) {
    rm = { present: false, ok: false, error: String((e && e.message) || e) };
    res.ok = false; res.degraded.push("receipt model check threw: " + rm.error);
  }
  res.receiptModel = rm;
  res.continuationDefault = "OFF";
  res.compactionIntegration = { mode: "native-auto + checkpoint/recovery (experimental.session.compacting supplements the prompt; does NOT replace it)", realCompactionVerified: false, trustedTelemetry: false, note: "no trustworthy per-call token counter; 75% custom trigger intentionally NOT implemented; auto-continuation disabled until a real Stop/abort discriminator is proven" };

  // ---- LIVE-READINESS mode: needs evidence from a running desktop backend, not from disk. ----
  // Trust rules (v1.1.2): a record counts ONLY with the non-forgeable provenance the plugin
  // writes inside a REAL host process: nonce + toolsBuilt + live pid + fresh + hook activity,
  // not flagged test. Legacy/probe-shaped, dead-pid, stale or test records are rejected —
  // Node tests/probes can never satisfy the live check, and hook records without a genuine
  // load nonce never pass.
  if (live) {
    const loadDir = path.join(stateDir(), "load");
    let files = [];
    try { files = fs.readdirSync(loadDir).map((f) => { try { return { f, r: JSON.parse(fs.readFileSync(path.join(loadDir, f), "utf8")) }; } catch { return null; } }).filter(Boolean); } catch {}
    const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const now = Date.now();
    const rejectReason = (r) => {
      if (!r || typeof r !== "object") return "unparseable";
      if (r.test === true) return "test-context";
      if (!r.nonce || typeof r.nonce !== "string") return "missing-load-nonce";
      if (r.toolsBuilt !== true) return "unverified-build";
      // a record written by a process sharing this checker's node binary is a probe, not the app
      if (!r.exec || typeof r.exec !== "string" || r.exec === process.execPath) return "checker-runtime-exec";
      if (typeof r.pid !== "number" || !pidAlive(r.pid)) return "dead-or-missing-pid";
      if (now - (r.at || 0) >= 15 * 60 * 1000) return "stale";
      if ((r.hookActivity || 0) <= 0) return "no-hook-activity";
      return null;
    };
    const genuine = [], rejected = [];
    for (const { f, r } of files) { const why = rejectReason(r); if (why) rejected.push({ file: f, why }); else genuine.push(r); }
    const freshGenuine = genuine.filter((r) => now - (r.at || 0) < 15 * 60 * 1000 && (r.hookActivity || 0) > 0);
    res.liveEvidence = { loadRecords: files.length, rejectedUntrusted: rejected };
    if (files.length === 0) {
      res.ok = false; res.status = "AWAITING_RESTART"; res.live = "NOT_VERIFIED";
      res.failures.push("No runtime load record observed: the plugin was not loaded by the running backend (it predates install). Restart required.");
    } else if (freshGenuine.length === 0) {
      res.ok = false; res.status = "STALE_LOAD_RECORD"; res.live = "NOT_VERIFIED";
      for (const x of rejected) res.failures.push(`load record ${x.file} rejected (${x.why}): untrusted as live evidence`);
      if (rejected.length === files.length && rejected.length > 0 && !rejected.some((x) => x.why === "dead-or-missing-pid" || x.why === "stale")) {
        res.failures.push("Load record(s) exist but none are fresh with hook activity; treat as not currently loaded.");
      }
    } else {
      const last = freshGenuine[freshGenuine.length - 1];
      res.status = "LIVE_DETECTED"; res.live = "OBSERVED";
      res.liveEvidence = { loadRecords: files.length, rejectedUntrusted: rejected, lastLoad: last, note: "plugin observed active in a current backend instance" };
      res.notes.push("A live load was observed; still confirm cancellation/compaction legs separately before trusting bounded mode.");
    }
  }
  return res;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const json = rest.includes("--json");
  const live = rest.includes("--live");
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const { C, I } = await loadMods();
  const out = { cmd };

  if (cmd === "doctor") {
    const r = await doctor({ live });
    Object.assign(out, r);
  } else if (cmd === "review") {
    const proj = flag("--project"), runId = flag("--run"), reasonFile = flag("--reason-file");
    if (!proj || !runId || !reasonFile) Object.assign(out, { ok: false, error: "REVIEW_ARGUMENTS_REQUIRED", detail: "Specify --project, --run, --verdict accept|reject, --expected-basis, --review-id and --reason-file. Read the current completionReview.basis from status first. Review is an operator action, not model self-approval." });
    else {
      const reason = fs.readFileSync(reasonFile, "utf8");
      const key = C.stateKey(C.projectIdentity(proj), runId);
      const result = await C.operatorCompletionReview(new C.Store(stateDir()), key, {
        directory: proj, runId, verdict: flag("--verdict"), reason,
        expectedBasis: flag("--expected-basis"), reviewId: flag("--review-id") });
      Object.assign(out, { ok: !result.error, ...result });
    }
  } else if (cmd === "amend") {
    // Operator-only: a finite additional candidate allowance and/or a new absolute deadline for an
    // already-paused run whose original limits are exhausted/expired. Read the current basis and
    // revision from `status --json` (amendmentBasis / controlRevision) first. This never resumes a
    // run, never resets counters and never grants acceptance. The native model tool surface has no
    // amendment action; a model must not self-amend through this CLI or by editing state.
    const proj = flag("--project"), runId = flag("--run");
    const authFile = flag("--authorization-file"), reasonFile = flag("--reason-file");
    const amendmentId = flag("--amendment-id"), additionalCandidates = flag("--additional-candidates");
    const newDeadline = flag("--new-deadline"), expectedBasis = flag("--expected-basis"), expectedRevision = flag("--expected-revision");
    if (!proj || !runId || !authFile || !reasonFile || !amendmentId || !additionalCandidates || !newDeadline || !expectedBasis || !expectedRevision)
      Object.assign(out, { ok: false, error: "AMENDMENT_ARGUMENTS_REQUIRED", detail: "Specify --project, --run, --amendment-id, --additional-candidates, --new-deadline (ISO-8601 absolute), --authorization-file, --reason-file, --expected-basis and --expected-revision. Read amendmentBasis/controlRevision from status --json first. This is an operator action, not model self-approval." });
    else {
      try {
        const authorization = fs.readFileSync(authFile, "utf8");
        const reason = fs.readFileSync(reasonFile, "utf8");
        const key = C.stateKey(C.projectIdentity(proj), runId);
        const result = await C.operatorBudgetAmendment(new C.Store(stateDir()), key, {
          directory: proj, runId, amendmentId, authorization, reason,
          additionalCandidates: Number(additionalCandidates), newDeadlineAt: Date.parse(newDeadline),
          expectedBasis, expectedRevision: Number(expectedRevision) });
        Object.assign(out, { ok: !result.error, ...result });
      } catch (e) { Object.assign(out, { ok: false, error: "AMENDMENT_IO_ERROR", detail: String((e && e.message) || e) }); }
    }
  } else if (cmd === "status" || cmd === "pause") {
    const proj = flag("--project") || process.cwd();
    const id = C.projectIdentity(proj);
    const key = C.stateKey(id, flag("--run") || "default");
    const store = new C.Store(stateDir());
    const found = store.readRun(key), run = found.run;
    if (found.error === "NO_RUN") { Object.assign(out, { ok: true, state: "NO_RUN", project: id.root }); }
    else if (found.error) { Object.assign(out, { ok: false, ...found }); }
    else if (cmd === "pause") {
      // Re-read under the same writer lock used by verification. Never write
      // this earlier status snapshot over a concurrent receipt/result commit.
      const paused = store.mutate(key, C.pauseRun);
      Object.assign(out, { ok: !paused.error, ...paused });
    }
    else Object.assign(out, { ok: true, ...C.deriveRunView(run, { currentFingerprint: C.sourceFingerprint(proj), projectMemoryStatus: C.memory.assessStaleness(proj, C.memory.readMemoryIndex(proj)) }) });
  } else if (cmd === "disable") { Object.assign(out, I ? I.disable({ configDir: cfgDir() }) : { error: "install lib missing" }); }
  else if (cmd === "enable") { Object.assign(out, I ? I.enable({ configDir: cfgDir() }) : { error: "install lib missing" }); }
  else if (cmd === "uninstall") { Object.assign(out, I ? I.uninstall({ configDir: cfgDir() }) : { error: "install lib missing" }); }
  else { Object.assign(out, { error: "unknown command", usage: "doctor [--live]|status|pause|review|amend|disable|enable|uninstall [--json] [--project PATH]" }); }

  if (json) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else {
    process.stdout.write(`cmd=${cmd} mode=${out.mode || "n/a"} ok=${out.ok} status=${out.status || "n/a"} live=${out.live || "n/a"}\n`);
    if (out.runLifecycleSchema) process.stdout.write(`  lifecycle schema ${out.runLifecycleSchema.version}: ${out.runLifecycleSchema.actions.join("|")}\n`);
    if (out.memorySubsystem) process.stdout.write(`  memory: ${out.memorySubsystem.present ? "present" : "MISSING"} (maxDepth ${out.memorySubsystem.maxDepth}); index ${out.memoryIndex ? out.memoryIndex.status : "n/a"}\n`);
    if (out.evidenceSchema) process.stdout.write(`  evidence classes: ${out.evidenceSchema.classes.join("/") || "MISSING"}; continuation=${out.continuationDefault}\n`);
    if (out.receiptModel) process.stdout.write(`  receipt model: ${out.receiptModel.ok ? "ok" : "CHECK FAILED"} (singleSource=${out.receiptModel.singleSource}, singleResolver=${out.receiptModel.singleResolver}, copySabotageIgnored=${out.receiptModel.copySabotageIgnored}, gateRecomputed=${out.gateRecomputedToComplete ?? out.receiptModel.gateRecomputedToComplete})\n`);
    for (const d of (out.degraded || [])) process.stdout.write(`  DEGRADED ${d}\n`);
    for (const f of (out.failures || [])) process.stdout.write(`  FAIL ${f}\n`);
    for (const n of (out.notes || [])) process.stdout.write(`  note ${n}\n`);
  }
  // Preserve the exit status while letting asynchronous stdout writes drain to pipes.
  process.exitCode = out.ok === false ? 2 : 0;
}
main().catch((e) => { process.stdout.write("ERROR " + (e && e.message) + "\n"); process.exitCode = 3; });
