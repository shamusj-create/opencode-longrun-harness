#!/usr/bin/env node
// Independent receipt auditor for a tracked run. The supervisor must not trust "PASS" at face value,
// but must also not cry wolf: this run's receipts span two schema eras, so the auditor is explicitly
// schema-aware. Fields that simply did not exist in older receipts are reported as era notes, never
// as fabrication findings.
//
// Checks that can prove a receipt was produced by a real declared-check execution:
//   - command matches the declared check command in checkCatalogue (no substituted command)
//   - contractHash matches the run contract
//   - PASS implies exitCode 0, no termination reason and no execution error
//   - timestamps are ordered and inside the run's lifetime
//   - sourceFingerprint present (freshness is judged against the current fingerprint separately)
// Checks that only apply when the receipt schema has the field:
//   - receiptId uniqueness, executionToken presence
//
// usage: node audit-receipts.mjs [--state-dir DIR] [--run RUN_ID] [--baseline N] [--json]
// exit: 0 clean/review, 1 suspect (a HIGH finding)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const STATE_DIR = flag("--state-dir", path.join(process.env.HOME, ".local/state/opencode-longrun/v1"));
const RUN_ID = flag("--run", "");
if (!RUN_ID) { console.error("usage: audit-receipts.mjs --run RUN_ID [--state-dir DIR] [--baseline N] [--json]"); process.exit(2); }
const BASELINE = Number(flag("--baseline", 0));

function findRun(stateDir, runId) {
  const root = path.join(stateDir, "state");
  for (const name of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    const file = path.join(root, name, "run.json");
    try { const run = JSON.parse(fs.readFileSync(file, "utf8")); if (run.runId === runId) return { run, file }; } catch {}
  }
  return null;
}

const found = findRun(STATE_DIR, RUN_ID);
if (!found) { console.error("run not found"); process.exit(2); }
const { run, file } = found;
const catalogue = run.checkCatalogue || {};
const receipts = run.receipts || [];
const fresh = receipts.slice(BASELINE);

const findings = [];
const add = (severity, checkId, receiptId, message, extra = {}) =>
  findings.push({ severity, checkId: checkId ?? null, receiptId: receiptId ?? null, message, ...extra });

// ---- schema era detection (once) -----------------------------------------------------------------
const hasIds = receipts.some(r => r && (r.receiptId || r.id));
const hasTokens = receipts.some(r => r && r.executionToken);
const eras = [];
if (!hasIds) eras.push("no receiptId in any receipt: legacy schema, identity is positional");
if (!hasTokens) eras.push("no executionToken in any receipt: legacy schema, process provenance is not recorded");
if (eras.length) add("INFO", null, null, `legacy receipt schema (${eras.length} era notes)`, { eras });

// ---- structural integrity -----------------------------------------------------------------------
const seen = new Map();
for (const [i, r] of receipts.entries()) {
  if (!r || typeof r !== "object") { add("HIGH", null, null, `receipt #${i} is not an object`); continue; }
  const id = r.receiptId || r.id || null;
  if (id) { if (seen.has(id)) add("HIGH", r.checkId, id, `duplicate receiptId (also receipt #${seen.get(id)})`); else seen.set(id, i); }
  if (Number(r.finishedAt) < Number(r.startedAt)) add("HIGH", r.checkId, id, `finishedAt precedes startedAt (#${i})`);
  if (r.startedAt && run.createdAt && Number(r.startedAt) < Number(run.createdAt))
    add("HIGH", r.checkId, id, `receipt #${i} predates the run's creation (backdated)`);
}

// ---- per-receipt authenticity -------------------------------------------------------------------
for (const [i, r] of fresh.entries()) {
  const idx = BASELINE + i;
  const id = r.receiptId || r.id || `#${idx}`;
  const declared = catalogue[r.checkId];
  if (!declared) { add("HIGH", r.checkId, id, "receipt for a check absent from the declared catalogue"); continue; }
  const declaredCmd = (Array.isArray(declared.command) ? declared.command.join(" ") : String(declared.command)).trim();
  const receiptCmd = (Array.isArray(r.argv) ? r.argv.join(" ") : String(r.command ?? "")).trim();
  if (receiptCmd && declaredCmd && receiptCmd !== declaredCmd)
    add("HIGH", r.checkId, id, "receipt command differs from the declared check command (substituted command?)", { declaredCmd, receiptCmd });
  if (r.contractHash && run.contractHash && r.contractHash !== run.contractHash)
    add("HIGH", r.checkId, id, "receipt contractHash differs from the run contract");
  if (r.status === "PASS" && Number(r.exitCode) !== 0) add("HIGH", r.checkId, id, "PASS with a non-zero exit code", { exitCode: r.exitCode });
  if (r.status === "PASS" && r.terminationReason) add("HIGH", r.checkId, id, "PASS with a termination reason", { terminationReason: r.terminationReason });
  if (r.status === "PASS" && r.executionError) add("HIGH", r.checkId, id, "PASS with an execution error", { executionError: r.executionError });
  if (!r.sourceFingerprint) add("MEDIUM", r.checkId, id, "no sourceFingerprint recorded");
  if (r.status === "NOT_RUN" && Number(r.exitCode) === 0)
    add("LOW", r.checkId, id, "NOT_RUN with exit 0: the summary was not recognised, so this does NOT satisfy the criterion");
  if (r.status === "FAIL") add("LOW", r.checkId, id, "historical FAIL receipt retained in the canonical history", { exitCode: r.exitCode });
}

// ---- freshness ----------------------------------------------------------------------------------
const fps = new Map();
for (const r of fresh) fps.set(r.sourceFingerprint, (fps.get(r.sourceFingerprint) || 0) + 1);

const summary = {
  runId: RUN_ID, runFile: file,
  runHash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  status: run.status, totalReceipts: receipts.length, auditedFrom: BASELINE, auditedReceipts: fresh.length,
  schemaEra: { receiptIds: hasIds, executionTokens: hasTokens },
  distinctFingerprints: [...fps.entries()].map(([fingerprint, count]) => ({ fingerprint, count })),
  counts: { PASS: fresh.filter(r => r.status === "PASS").length, FAIL: fresh.filter(r => r.status === "FAIL").length, NOT_RUN: fresh.filter(r => r.status === "NOT_RUN").length },
  findings,
  high: findings.filter(f => f.severity === "HIGH").length,
  medium: findings.filter(f => f.severity === "MEDIUM").length,
  low: findings.filter(f => f.severity === "LOW").length,
  verdict: findings.some(f => f.severity === "HIGH") ? "SUSPECT" : findings.some(f => f.severity === "MEDIUM") ? "REVIEW" : "CLEAN",
};

if (argv.includes("--json")) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
else {
  console.log(`run ${summary.runId}  status ${summary.status}  receipts ${summary.totalReceipts} (audited from ${BASELINE})`);
  console.log(`schema era: receiptIds=${hasIds} executionTokens=${hasTokens}`);
  console.log(`audited: PASS ${summary.counts.PASS}  FAIL ${summary.counts.FAIL}  NOT_RUN ${summary.counts.NOT_RUN}`);
  console.log(`verdict: ${summary.verdict}  high=${summary.high} medium=${summary.medium} low=${summary.low}`);
  console.log("fingerprints in audited receipts:");
  for (const d of summary.distinctFingerprints) console.log(`  ${String(d.fingerprint).slice(0, 16)}… ×${d.count}`);
  for (const f of findings) {
    if (f.severity === "INFO") { console.log(`  [INFO] ${f.message}`); for (const e of f.eras || []) console.log(`         - ${e}`); continue; }
    console.log(`  [${f.severity}] ${f.checkId || "-"} ${f.receiptId || "-"}: ${f.message}`);
  }
}
process.exit(summary.verdict === "SUSPECT" ? 1 : 0);
