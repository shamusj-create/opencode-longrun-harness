// Long-run Harness — evidence-strength model + precise candidate accounting + negative controls.
// Dependency-free (node builtins). Copied into the built install and imported by controller.js.
// This is the EVIDENCE (plane C) + candidate-accounting logic. It models WHAT a piece of evidence
// can prove, not the command execution itself (that lives in the controller/plugin).

export const EVIDENCE_CLASSES = ["STATIC", "UNIT", "INTEGRATION", "SYSTEM", "BROWSER", "VISION", "HUMAN/EXTERNAL"];
// Classes that prove something only exists, never that it is correct or visible.
export const PROXY_ONLY = new Set([
  "object_exists", "mesh_count", "canvas_nonblank", "dom_exists", "file_exists", "symbol_exists",
]);
// Classes that satisfy a "must be visibly distinguishable at runtime" criterion.
export const RENDER_CLASSES = new Set(["BROWSER", "VISION", "HUMAN/EXTERNAL"]);
export const VISUAL_REQUIRED = "VISUAL"; // marker used when a criterion is visual

export function rank(cls) { const i = EVIDENCE_CLASSES.indexOf(cls); return i < 0 ? -1 : i; }
export function isKnownClass(cls) { return EVIDENCE_CLASSES.includes(cls); }

// ---- Evidence strength: can a receipt of class `provided` satisfy a criterion requiring
// `required`? A criterion may require a specific class (evidenceClass) or a set (requiresEvidence).
// Rules:
//  * A criterion with NO declared required class is class-agnostic (back-compat with v1.1.2): a
//    PASS is enough on class grounds (staleness/counts are enforced in the controller).
//  * Proxy-only evidence (object/mesh/canvas/DOM existence) NEVER satisfies a VISUAL/render class.
//  * A provided class weaker than the highest required class is WEAK_EVIDENCE (rejected).
//  * Non-visual UNIT/INTEGRATION criteria do NOT require vision.
export function classSatisfies(provided, criterion = {}) {
  const req = new Set();
  if (criterion.evidenceClass) req.add(criterion.evidenceClass);
  for (const r of criterion.requiresEvidence || []) req.add(r);
  const visual = criterion.visual === true || RENDER_CLASSES.has(criterion.evidenceClass) ||
    (criterion.requiresEvidence || []).some((r) => RENDER_CLASSES.has(r)) || req.has(VISUAL_REQUIRED);

  if (provided && PROXY_ONLY.has(provided) && visual) {
    return { satisfied: false, kind: "PROXY_INSUFFICIENT", note: `${provided} (existence-only) cannot prove a VISUAL/render requirement` };
  }
  if (req.size === 0) {
    // No class gate; but a proxy must never satisfy a VISUAL-marked criterion.
    if (visual && provided && rank(provided) < rank("BROWSER")) {
      return { satisfied: false, kind: "PROXY_INSUFFICIENT", note: `visual criterion needs BROWSER/VISION/HUMAN, got ${provided}` };
    }
    return { satisfied: true, kind: "CLASS_AGNOSTIC" };
  }
  // Class-gated: the provided class must be one of the accepted classes AND at least as strong as
  // the strongest required class (so a UNIT receipt cannot satisfy a SYSTEM/BROWSER requirement).
  const maxReq = Math.max(...[...req].filter((r) => isKnownClass(r)).map((r) => rank(r)));
  if (provided && req.has(provided)) {
    if (maxReq >= 0 && rank(provided) < maxReq) return { satisfied: false, kind: "WEAK_EVIDENCE", note: `${provided} weaker than required (needs >= ${EVIDENCE_CLASSES[maxReq]})` };
    return { satisfied: true, kind: "MATCH" };
  }
  if (provided && rank(provided) >= 0) {
    if (rank(provided) < maxReq) return { satisfied: false, kind: "WEAK_EVIDENCE", note: `${provided} weaker than required class ${EVIDENCE_CLASSES[maxReq]}` };
    return { satisfied: false, kind: "WRONG_CLASS", note: `${provided} is not an accepted class (${[...req].join("/")})` };
  }
  return { satisfied: false, kind: "UNKNOWN_CLASS", note: `unrecognised evidence class: ${provided}` };
}

// Outstanding evidence gaps for a criterion: which required classes have no satisfying receipt.
export function evidenceGap(criterion, receipts = []) {
  const req = [...new Set([criterion.evidenceClass, ...(criterion.requiresEvidence || [])].filter(Boolean))];
  if (req.length === 0 && !criterion.visual) return { gap: false, missing: [] };
  const missing = req.filter((r) => !receipts.some((x) => x.status === "PASS" && classSatisfies(x.evidenceClass || x.class, criterion).satisfied && (x.evidenceClass || x.class) === r));
  if (criterion.visual && missing.length === 0 && !receipts.some((x) => x.status === "PASS" && RENDER_CLASSES.has(x.evidenceClass || x.class))) missing.push(VISUAL_REQUIRED);
  return { gap: missing.length > 0, missing };
}

// ---- Precise candidate accounting ----------------------------------------------------------
// A candidate = a DISTINCT relevant source state that receives an evaluation capable of changing
// acceptance status/loss. NOT counted: every tool call, every screenshot, every test command,
// unchanged-source retries, pure inspection. The ledger lives in run.state.candidates so it
// survives compaction/restart/resume/replan and is NEVER reset by a new conversation.
export function considerCandidate(run, evt) {
  const st = (run.state = run.state || {});
  st.candidates = st.candidates || [];
  const fingerprint = evt.fingerprint || null;
  const evaluated = evt.evaluated === true && evt.diagnosticOnly !== true;
  const number = st.candidates.length + 1;
  const changeable = evt.statusChanged === true || evt.canChangeAcceptance === true;
  let counted = false, reason;
  if (!evt.evaluated) { reason = "inspection_not_evaluation"; }
  else if (evt.diagnosticOnly) { reason = "diagnostic_only"; }
  else if (fingerprint && (fingerprint === st.lastEvalFingerprint || (evt.fingerprintAliases || []).includes(st.lastEvalFingerprint) || st.candidates.some(c => c.counted && c.fingerprint === fingerprint))) { reason = "unchanged_source_retry"; }
  else if (!changeable) { reason = "no_status_change_capability"; }
  else { counted = true; reason = "evaluated_new_source_state"; }
  const candidate = {
    n: number, runId: run.runId || null, fingerprint, ts: Date.now(),
    hypothesis: evt.hypothesis || null, receiptIds: evt.receiptIds || [],
    criteriaChanged: evt.criteriaChanged || [], lossBefore: evt.lossBefore ?? null,
    lossAfter: evt.lossAfter ?? null, bestLoss: st.best ? st.best.loss ?? st.best.lossAfter ?? null : null,
    result: evt.result || null, diagnosticOnly: !!evt.diagnosticOnly,
    elapsedMs: evt.elapsedMs || 0, counted, reason,
  };
  if (evaluated && fingerprint && (counted || reason === "unchanged_source_retry")) {
    if (!counted && fingerprint !== st.lastEvalFingerprint && (evt.fingerprintAliases || []).includes(st.lastEvalFingerprint)) {
      st.fingerprintMigrations = st.fingerprintMigrations || [];
      st.fingerprintMigrations.push({ previous: st.lastEvalFingerprint, current: fingerprint, reason: "observed_same_source_under_new_fingerprint_policy" });
    }
    st.lastEvalFingerprint = fingerprint;
  }
  if (counted) {
    st.candidates.push(candidate);
    if (candidate.result === "PASS" && (!st.best || (candidate.lossAfter != null && candidate.lossAfter <= (st.best.loss ?? st.best.lossAfter ?? Infinity)))) st.best = candidate;
    st.current = candidate;
  }
  return { counted, reason, candidate };
}

export function candidateCount(run) {
  const st = (run && run.state) || {};
  return (st.candidates || []).filter((c) => c.counted).length;
}

// ---- Negative controls (verify the verifiers) ----------------------------------------------
// Records that a KNOWN-BROKEN state makes a protected verifier fail, proving the verifier is
// live (not self-satisfied). Recorded OUTSIDE the criteria/gates, separately, and NEVER allowed
// to mutate the user's active source. The plugin runs these against isolated fixtures / temp
// copies with cwd in the copy, so the active worktree is untouched.
export const NEGATIVE_PRIORITY = ["hard_gate", "missed_bug", "integration", "visual", "security", "determinism"];
export function negativeControlAllowed(check = {}) {
  // Prioritise gates + historically-missed + complex integration + visual + security + determinism.
  if (check.negativeControl === false) return false;
  if (check.gate) return true;
  if (check.kind === "test" && (check.integration || check.visual || check.security || check.determinism || check.historicalMiss)) return true;
  if (check.negativeControl === true) return true;
  return false;
}
export function makeNegativeControl({ checkId, mode = "isolation", fixture, targetFingerprint, expected = "FAIL", observed, ok, mutatedProduction = false, command = null, exitCode = null, signal = null, error = null, startedAt = null, finishedAt = null, outputTail = null, productionFingerprintBefore = null, productionFingerprintAfter = null }) {
  const executed = !error && !signal && (observed === "PASS" || observed === "FAIL");
  return {
    kind: "negative_control", checkId, mode, fixture: fixture || null, targetFingerprint: targetFingerprint || null,
    expected, observed, ok: !!ok && executed && !mutatedProduction, mutatedProduction: !!mutatedProduction, at: Date.now(),
    command, exitCode, signal, error, startedAt, finishedAt, outputTail, productionFingerprintBefore, productionFingerprintAfter,
    // A negative control that mutated the active source is INVALID evidence (must be isolated).
    valid: !mutatedProduction && executed,
  };
}
