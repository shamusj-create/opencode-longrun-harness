// Long-run Harness plugin — the ONE loader-facing entry point.
// Installed file is a COPY of this. The file exposes exactly ONE module export: `default`, in the
// OpenCode V1 server-plugin shape `{ id, server }`, where `server` is the async factory. All
// helpers/state/records stay internal; nothing runs at module scope.
//
// Auto-continuation is OFF by default. Live-evidence records are emitted ONLY when the factory has
// successfully built BOTH required tools inside a genuine host process — never at import, never
// under a test/probe context, and never inside a plain `node` process.
//
// v1.2.0 changes: the native `longrun` tool exposes a COMPLETE explicit action enum (no ellipsis,
// no hidden guessing); `start` creates an authoritative run; candidate accounting is exact and
// persisted; `verify` enforces evidence-strength; negative-control runs target isolated fixtures.
//
// v1.2.1 changes: `start` REJECTS an incomplete contract (INVALID_CONTRACT, no run created);
// `memory_status`/`memory_init`/`memory_refresh` work WITHOUT an active run; `action=verify` is a
// read-only readout while execution stays exclusively in `longrun_verify` (no shell bypass).
//
// v1.2.2 changes: ONE canonical run resolver (in the controller) is shared by BOTH native tools, so
// the lifecycle and the verifier never disagree about which run is "active". `longrun_verify` and the
// control plane accept an explicit runId and resolve via session binding + canonical project/worktree
// identity (never a cross-project/arbitrary run). State maps to EXPLICIT codes (RUN_PAUSED /
// RUN_COMPLETE / RUN_CANCELLED / RUN_STALLED / NO_RUN / AMBIGUOUS_RUN) — never a generic
// "no_active_run". `resume` re-binds so a NEW conversation can continue verifying the same run.
// `cancel` is a terminal action. Lifecycle verification records a real receipt but does NOT count a
// source candidate (candidate accounting is unchanged and reserved for real candidate evaluation).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

let CONTROLLER = null;
let TOOL_HELPER; // undefined = untried, null = unavailable, fn = available
const CANDIDATES = [];
if (process.env.LONGRUN_CONTROLLER_FILE) CANDIDATES.push("file://" + process.env.LONGRUN_CONTROLLER_FILE);
const BAKED = "__LONGRUN_CONTROLLER_URL__";
if (!/^\w+$/.test(BAKED)) CANDIDATES.push(BAKED); // replaced at install time
CANDIDATES.push(new URL("./_controller.js", import.meta.url).href);
const VERSION = "1.2.24";

// ---- tool-discovery contract: the authoritative action list (shared with controller) --------
const ACTIONS = ["help", "start", "status", "receipts", "next", "checkpoint", "verify", "pause", "resume", "cancel", "complete", "reconcile", "memory_init", "memory_refresh", "memory_status", "resume-context"];
const DEFAULT_PARAMS = { help: ["session"], start: ["request", "criteria", "hardGates", "candidateBudget", "timeBudgetHours", "deadlineHours", "toolActionCap", "sameFailureThreshold", "noProgressThreshold", "autoContinue", "checkCatalogue"], status: ["runId"], receipts: ["runId", "checkId", "receiptId", "offset", "limit"], next: ["runId"], checkpoint: ["runId", "progress"], verify: ["checkId", "evidenceClass", "mode", "fixture", "runId"], pause: ["runId"], resume: ["runId"], cancel: ["runId", "reason"], complete: ["runId"], reconcile: ["runId"], memory_init: ["maxDepth", "dryRun", "regenerate"], memory_refresh: ["maxDepth"], memory_status: [], "resume-context": ["runId"] };

function isTestContext() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_OPTIONS?.includes("--test") || process.env.LONGRUN_TEST);
}
function isHostProcess() {
  if (isTestContext()) return false;
  if (process.env.OPENCODE_CLIENT) return true;
  if (process.versions.electron) return true;
  const ep = process.execPath || "";
  return /[.]app[\/]/i.test(ep) || /(^|[\/-])opencode([\/.\-]|$)/i.test(path.basename(ep));
}
const DEFAULT_STATE = path.join(os.homedir() || os.tmpdir(), ".local", "state", "opencode-longrun", "v1");
function stateDir() { if (process.env.LONGRUN_STATE_DIR) return process.env.LONGRUN_STATE_DIR; return isHostProcess() ? DEFAULT_STATE : null; }
async function loadController() { if (CONTROLLER) return CONTROLLER; for (const u of CANDIDATES) { try { const m = await import(u); if (m && m.STATES) { CONTROLLER = m; return m; } } catch {} } return null; }
async function getToolHelper() { if (TOOL_HELPER !== undefined) return TOOL_HELPER; try { const m = await import("@opencode-ai/plugin"); TOOL_HELPER = m.tool || null; } catch { TOOL_HELPER = null; } return TOOL_HELPER; }
function sanitizeEnv() { const c = { ...process.env }; delete c.NODE_OPTIONS; delete c.NODE_REPL_MODE; return c; }

class RoutingError extends Error {
  constructor(detail, code = "ROUTING_STORE_ERROR") { super(`${code}: ${detail}`); this.code = code; }
}
function readIndex(dir, name) {
  if (!dir) return {};
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object map");
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid index entry");
      if (name === "projects.json" && (!Array.isArray(entry.runs) || entry.runs.some(key => !/^[a-f0-9]{32}$/.test(key)))) throw new Error("invalid project run list");
      if (name === "runs.json" && !/^[a-f0-9]{32}$/.test(entry.runKey || "")) throw new Error("invalid session run key");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new RoutingError(`${name} could not be read safely (${error.code || error.name}); original bytes preserved`);
  }
}
function writeIndex(dir, name, value) {
  if (!dir) throw new RoutingError("state directory unavailable");
  const final = path.join(dir, name), temp = `${final}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, final); }
  catch (error) { throw new RoutingError(`${name} write failed (${error.code || error.name}); a canonical lifecycle change may already be committed. Inspect status and resume the SAME run after storage recovery; never start a replacement.`); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
const readRuns = dir => readIndex(dir, "runs.json");
const writeRuns = (dir, value) => writeIndex(dir, "runs.json", value);
const readProj = dir => readIndex(dir, "projects.json");
const writeProj = (dir, value) => writeIndex(dir, "projects.json", value);

// Serialize the short admission/index transaction across hosts. The canonical run
// remains authoritative; the two indices are recoverable routing hints. No lock is
// held over inference or a verification subprocess. An abandoned/invalid lock fails
// closed, rather than racing another host by unlinking a possibly replaced lock.
async function withRoutingLock(dir, callback) {
  const C = await loadController();
  return C.withStoreRoutingLock(dir, () => {
    readRuns(dir); readProj(dir); // detect corrupt indices before any lifecycle mutation
    return callback();
  });
}
function runFor(dir, sid) { const e = readRuns(dir)[sid]; if (!e || e.disabled) return null; return e; }
function keyOf(v) { return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 24); }
function tail(s, n) { return s && s.length > n ? "..." + s.slice(-n) : s; }
function isDisabledGlobally() { try { return fs.existsSync(path.join(process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode"), "longrun-harness", "DISABLED")); } catch { return false; } }

// ---- trustworthy live-evidence records (unchanged from v1.1.2 trust rules) -----------------
function writeLoadRecord(ctx) {
  if (!isHostProcess()) return;
  const dir = stateDir(); if (!dir) return;
  try {
    const ld = path.join(dir, "load"); fs.mkdirSync(ld, { recursive: true });
    const exec = (() => { try { return fs.realpathSync(process.execPath); } catch { return process.execPath; } })();
    const nonce = process.pid + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    const f = path.join(ld, "host-" + keyOf(process.pid + "|" + (ctx?.project?.id || "global")) + ".json");
    fs.writeFileSync(f, JSON.stringify({
      harnessVersion: VERSION, at: Date.now(), nonce, hookActivity: 0, toolsBuilt: true, test: false,
      project: ctx?.project?.id || ctx?.directory || "global",
      pid: process.pid, runtime: process.version, exec,
      client: process.env.OPENCODE_CLIENT || null,
    }));
  } catch {}
}
function bumpActivity(ctx, sid) {
  if (!isHostProcess()) return;
  const dir = stateDir(); if (!dir) return;
  try {
    const ld = path.join(dir, "load"); if (!fs.existsSync(ld)) return;
    const want = "host-" + keyOf(process.pid + "|" + (ctx?.project?.id || "global"));
    for (const name of fs.readdirSync(ld)) {
      if (!name.startsWith(want)) continue;
      const f = path.join(ld, name);
      let rec; try { rec = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
      if (!rec || !rec.nonce || rec.toolsBuilt !== true) continue;
      rec.hookActivity = (rec.hookActivity || 0) + 1; rec.at = Date.now();
      fs.writeFileSync(f, JSON.stringify(rec)); return;
    }
  } catch {}
}

const server = async (input) => {
  const C = await loadController();
  const helper = await getToolHelper();
  try { input?.client?.app?.log?.({ body: { service: "longrun", level: C && !isDisabledGlobally() ? "info" : "warn", message: !C ? "controller NOT found; plugin inert" : isDisabledGlobally() ? "DISABLED" : "loaded" } }); } catch {}
  if (!C || isDisabledGlobally()) return {};
  const SD = stateDir();
  const mkTool = (def) => helper ? helper(def) : { ...def, __plain: true };
  const enumArg = (arr) => helper ? helper.schema.enum(arr) : { type: "string", enum: arr };

  // ---- ONE canonical run resolver for BOTH native tools (delegates eligibility + state codes to
  // the controller). It gathers candidate runs from (a) this session's authorised binding, (b) the
  // canonical project/worktree identity run list, and (c) an explicit runId, deduped by store key.
  function buildCandidates(ctx, explicitRunId) {
    const out = []; const seen = new Set();
    const identities = new Set([ctx.directory, ctx.worktree].filter(Boolean).map(d => C.projectIdentity(d).id));
    const add = (key, dir, cat) => {
      if (!key || !/^[a-f0-9]{32}$/.test(key) || seen.has(key)) return;
      let r;
      try {
        r = JSON.parse(fs.readFileSync(path.join(SD, "state", key, "run.json"), "utf8"));
        if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("invalid canonical record");
      } catch (error) {
        if (error.code === "ENOENT" && !dir) return;
        throw new RoutingError(`canonical record ${key} unreadable (${error.code || error.name}); preserve it, never create a replacement from an empty fallback`);
      }
      const canonicalDir = r.directory || dir;
      if (!canonicalDir || !identities.has(C.projectIdentity(canonicalDir).id)) return;
      seen.add(key);
      out.push({ key, run: r, dir: canonicalDir, cat: r.checkCatalogue || cat || null });
    };
    // (a) session binding (authorised routing metadata only; absent in a fresh conversation)
    const e = runFor(SD, ctx.sessionID);
    if (e && e.runKey) add(e.runKey, e.directory, e.checkCatalogue);
    // (b) canonical project/worktree identity -> its recorded run list
    for (const d of [ctx.directory, ctx.worktree]) {
      if (!d) continue;
      let id; try { id = C.projectIdentity(d); } catch { continue; }
      const p = readProj(SD)[keyOf(id.id)];
      if (p && Array.isArray(p.runs)) for (const rk of p.runs.slice().reverse()) add(rk, d, null);
    }
    // A crash can persist run.json before either index. Discover canonical records
    // as well, so an incomplete index cannot hide a run or admit its replacement.
    let storedKeys = [];
    try { storedKeys = fs.readdirSync(path.join(SD, "state")); }
    catch (error) { if (error.code !== "ENOENT") throw new RoutingError(`canonical run directory unreadable (${error.code || error.name})`); }
    for (const key of storedKeys) add(key, null, null);
    // (c) explicit runId must be one of the above (NEVER a cross-project / arbitrary fallback)
    if (explicitRunId) {
      const hit = out.find((x) => x.run.runId === explicitRunId);
      if (hit) return { entries: [hit], exact: true };
      // fall through so resolveVerification reports NO_RUN for an id not in this project
      return { entries: out, exact: false };
    }
    return { entries: out, exact: false };
  }

  // A wrong explicit ID must still fail, but loss of the ID during compaction
  // must not hide the canonical project run. Offer bounded read-only discovery;
  // never substitute another run into the requested lifecycle/check operation.
  function runDiscovery(entries) {
    const runs = entries.map(e => e.run);
    const open = runs.filter(r => !C.RUN_TERMINAL_STATES.includes(r.status));
    const target = open.length === 1 ? open[0] : open.length === 0 && runs.length === 1 ? runs[0] : null;
    const ordered = [...open, ...runs.filter(r => C.RUN_TERMINAL_STATES.includes(r.status))];
    return {
      totalRuns: runs.length,
      availableRuns: ordered.slice(0, 5).map(r => ({ runId: r.runId, state: r.status })),
      truncated: runs.length > 5,
      suggestedRead: target ? { action: C.RUN_TERMINAL_STATES.includes(target.status) ? "status" : "resume-context", runId: target.runId } : null,
      detail: open.length > 1 ? "Multiple nonterminal project runs; identify the intended run from canonical context. Never guess an ID or create a replacement to bypass recovery."
        : target && open.length ? "The requested ID was not selected. Read the suggested canonical resume-context, then explicitly resume the SAME run only for already-authorized work and within its original limits. Never treat a copied checkpoint as current run authority or create a replacement to bypass recovery."
        : runs.length ? "Only terminal project runs remain; inspect status with an exact ID. Terminal runs cannot resume. Never rewrite their state or create a replacement to bypass limits."
        : "No canonical run was found in this project/worktree. Check the project and state-store context; never guess IDs or create a replacement to bypass recovery.",
    };
  }

  // A session binding routes to a run; its cached paused/disabled flags cannot
  // authorize continuation after another host changes that run. Both compaction
  // callbacks converge on the same persisted state transition under its lock.
  async function recordCompaction(entry, sessionID) {
    if (!entry.runKey) return { error: "NO_RUN" };
    const store = new C.Store(SD);
    let result;
    for (let attempt = 0; attempt < 30; attempt++) {
      result = store.mutate(entry.runKey, latest => {
        if (latest.compactionSessionID && latest.compactionSessionID !== sessionID) return { ok: true, staleSession: true, state: latest.status };
        if (C.RUN_VERIFY_STATES.includes(latest.status) || latest.status === "COMPACTING") {
          latest.status = "RECOVERY_REQUIRED";
          latest.controlGeneration = (latest.controlGeneration || 0) + 1;
        }
        return { ok: true, state: latest.status };
      });
      if (result.error !== "STATE_BUSY") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return result;
  }

  // ------- longrun: the control plane (read-only; never arbitrary shell) -------
  const longrunTool = mkTool({
    description: "Long-run lifecycle, memory and checkpoint control for the CURRENT authorised run; never arbitrary shell. Call action=help if unsure of the action name — do NOT guess. For tracked workflows keep the runId returned by start and pass it here (optional; single active run may auto-resolve).",
    args: {
      action: enumArg(ACTIONS),
      request: helper ? helper.schema.string().optional() : { type: "string" },
      criteria: helper ? helper.schema.union([helper.schema.array(helper.schema.any()), helper.schema.string()]).optional() : { type: ["array", "string"] },
      checkCatalogue: helper ? helper.schema.any().optional() : { type: "object" },
      hardGates: helper ? helper.schema.union([helper.schema.array(helper.schema.any()), helper.schema.string()]).optional() : { type: ["array", "string"] },
      candidateBudget: helper ? helper.schema.union([helper.schema.number(), helper.schema.string()]).optional() : { type: ["number", "string"] },
      timeBudgetHours: helper ? helper.schema.union([helper.schema.number(), helper.schema.string()]).optional() : { type: ["number", "string"] },
      deadlineHours: helper ? helper.schema.union([helper.schema.number(), helper.schema.string()]).optional() : { type: ["number", "string"] },
      toolActionCap: helper ? helper.schema.union([helper.schema.number(), helper.schema.string()]).optional() : { type: ["number", "string"] },
      sameFailureThreshold: helper ? helper.schema.union([helper.schema.number(), helper.schema.string()]).optional() : { type: ["number", "string"] },
      noProgressThreshold: helper ? helper.schema.union([helper.schema.number(), helper.schema.string()]).optional() : { type: ["number", "string"] },
      autoContinue: helper ? helper.schema.union([helper.schema.boolean(), helper.schema.string()]).optional() : { type: ["boolean", "string"] },
      checkId: helper ? helper.schema.string().optional() : { type: "string" },
      receiptId: helper ? helper.schema.string().optional() : { type: "string" },
      offset: helper ? helper.schema.number().optional() : { type: "number" },
      limit: helper ? helper.schema.number().optional() : { type: "number" },
      evidenceClass: helper ? helper.schema.string().optional() : { type: "string" },
      mode: helper ? helper.schema.enum(["normal", "negative"]).optional() : { type: "string" },
      runId: helper ? helper.schema.string().optional() : { type: "string" },
      reason: helper ? helper.schema.string().optional() : { type: "string" },
      progress: helper ? helper.schema.union([
        helper.schema.object({
          currentSlice: helper.schema.string().max(240).optional(),
          nextAction: helper.schema.string().max(1000).optional(),
          decisions: helper.schema.array(helper.schema.string().max(500)).max(12).optional(),
          failedHypotheses: helper.schema.array(helper.schema.string().max(500)).max(12).optional(),
          memoryNodes: helper.schema.array(helper.schema.string().max(500)).max(12).optional(),
          artifacts: helper.schema.array(helper.schema.string().max(500)).max(12).optional(),
        }).strict(),
        helper.schema.string(), // local tool adapters may encode a nested object as JSON
      ]).optional() : { type: ["object", "string"] },
      maxDepth: helper ? helper.schema.number().optional() : { type: "number" },
      dryRun: helper ? helper.schema.boolean().optional() : { type: "boolean" },
      regenerate: helper ? helper.schema.boolean().optional() : { type: "boolean" },
    },
    async execute(args, context) {
      bumpActivity(context, context.sessionID);
      const dir = context.directory || context.worktree || process.cwd();
      const a = (args && args.action) || "";
      const rid = (args && (args.runId || args.run)) || null;
      if (a === "help") {
        const { entries } = buildCandidates(context, rid);
        const cur = C.pickCurrentRun(entries);
        const mem = C.memory.assessStaleness(dir, C.memory.readMemoryIndex(dir));
        return JSON.stringify({
          harnessVersion: VERSION, lifecycleSchema: C.LIFECYCLE_SCHEMA_VERSION,
          actions: ACTIONS, params: DEFAULT_PARAMS,
          run: cur && cur.run ? { runId: cur.run.runId, state: cur.run.status } : null,
          continuation: { enabled: false, note: "automatic continuation is OFF by default in v1.2.24" },
          criteriaSchema: "criteria: [{id, required?(default true), weight?(default 1), evidenceClass?, checks:[checkId,...]}]. Every REQUIRED criterion MUST map to >=1 declared check, else start returns INVALID_CONTRACT and creates NO run.",
          checkCatalogueSchema: "checkCatalogue: {checkId:{command:[...argv], kind:'cmd'|'test', timeoutMs?, countTests?, proxyOnly?, integration?, visual?, security?, determinism?, negativeControl?, gate?}}; evidenceClass STATIC is accepted; kind:'test' needs discovered test counts (zero tests cannot satisfy a test criterion).",
          mappingFields: "the mapping from a criterion to its evidence is criterion.checks -> checkCatalogue keys; longrun_verify(checkId=...) executes ONLY those declared checks.",
          executionLimits: "Declared checks enforce candidate, absolute deadline, measured check-time and check-attempt limits. toolActionCap counts declared-check attempts; it does not count help, status, checkpoint or all host-tool calls. Ordinary host-tool admission is refused after the absolute deadline, including fresh sessions in the same project; native status/checkpoint/pause and explicit check refusal remain available. This cannot interrupt an already-running ordinary tool or model inference. Time/actions outside declared checks are unmetered; historical usage may be incomplete. A candidate already admitted can finish its checks within the other limits. Verifier BUDGET_EXHAUSTED atomically leaves the run PAUSED/OFF without a new command attempt or receipt. Reaching the candidate cap alone does not block ordinary edits before a verifier refusal. Preserve the stop; do not bypass through bash, reset budgets or create a replacement run. VERIFY_IN_FLIGHT means wait; after a finished result or absent owner, use action=reconcile(runId). RESULT_COMMIT_PENDING and EXECUTION_RECOVERY_REQUIRED require reconciliation before retrying. Reconcile commits only a consistent finished execution record once, never launches a check, and preserves pause/terminal state. Each declared check runs in a finite Node executor that can clean up and journal an actual result after its host disconnects. It never commits or schedules another check; explicit reconciliation owns recovery. Missing evidence, executor failure or unconfirmed cleanup stays blocked. Same-failure/no-progress thresholds remain workflow guidance, not enforcement on this path.",
          receiptInspection: "status and action=verify provide summaries and receipt references. Use action=receipts with offset/limit (1..20), optionally checkId, to page recorded metadata; use receiptId to retrieve one actual command/argv, exit, timestamps, output tail and termination details. Absent legacy fields remain null. Inspect recorded evidence before searching files or rerunning a check.",
          lifecycleGuidance: C.LIFECYCLE_GUIDANCE,
          completionReview: "Tracked runs require both current passing declared evidence and a current independent operator completion review. Checks alone cannot authorize complete. Save a checkpoint and pause for that review; do not approve your own work through the maintenance CLI or state edits. The operator may be an authorized supervising agent, not necessarily a human. Approval becomes stale when its source, contract, budget or recorded evidence changes. Only an explicit operator rejection can archive a premature COMPLETE and return that same run to PAUSED without resetting its limits; ordinary resume/pause cannot reopen terminal runs. CANCELLED remains terminal. This is an auditable workflow boundary, not an OS security sandbox.",
          budgetAmendment: "A finite additional candidate allowance and/or a new absolute deadline may only be granted through the installed operator maintenance CLI (amend), never through this tool surface. There is no native amendment action, and a model must not grant, request through tool arguments, reset or rewrite its own limits, or self-approve. A grant preserves the original limits/usage/receipts/contract/failure history byte-for-byte, is recorded append-only with the explicit authorization, invalidates any prior completion approval, is bounded and finite, and never resumes the run. Do not bypass an exhausted or expired budget through another tool, session, state edit or replacement run.",
          progressSchema: C.progressSchema(),
          verifyExec: "longrun_verify performs/records declared verification checks; longrun action=verify is a READ-ONLY readout of declared checks + outstanding gaps (it never executes anything). When evidenceClass is omitted the receipt inherits the class required by the single criterion that maps this check; an explicit evidenceClass always wins, and a check mapped with conflicting classes (or unmapped) needs an explicit class because the harness will not guess.",
          lifecycleAdmission: "Canonical paused/stalled/terminal states also block ordinary execution, edits, delegation and memory writes. Read tools and native control stay available; native verification/resume keep their own eligibility checks. Pausing from another host or opening a fresh session cannot bypass that state. Native start remains available for a genuinely new authorized task after a terminal run, never as a budget workaround. This does not interrupt an ordinary tool already running.",
          compactionRecovery: "After actual compaction, the current authorized session enters RECOVERY_REQUIRED. Read resume-context then explicitly resume before verifying. Paused/terminal/blocked runs, expired budgets, in-flight checks, unknown legacy bindings and stale older sessions cannot auto-continue. A legacy active run needs an authorized resume to establish its session binding. This governs OpenCode compaction of the active turn; Longrun autonomous scheduling stays OFF.",
          checkpointProgress: "checkpoint accepts optional progress as an object or JSON-encoded object: {currentSlice, nextAction, decisions:[], failedHypotheses:[], memoryNodes:[], artifacts:[]}. Limits: currentSlice 240 characters, nextAction 1000; each array at most 12 strings of 500 characters; combined fields at most 6000 characters. Partial updates merge; arrays replace. Advisory context only, never acceptance/status/budget/receipt fields. Reference exact artifact paths. Saved context survives session changes and supplements compaction. After INVALID_PROGRESS correct only the payload; do not search for a CLI workaround or edit the state files.",
          runResolution: "ONE canonical resolver is shared by longrun + longrun_verify: session binding -> canonical project/worktree identity -> optional explicit runId. It never verifies an arbitrary or cross-project run. State codes: OK/ELIGIBLE | RUN_PAUSED | RUN_COMPLETE | RUN_CANCELLED | RUN_STALLED | NO_RUN | AMBIGUOUS_RUN. After a new conversation call resume(runId) to re-bind, then verify(runId). Use cancel for abandoned/impossible runs; never overwrite a non-terminal run; never brute-force run IDs. An unknown explicit ID remains NO_RUN and offers bounded canonical project discovery plus a suggested read when unambiguous; it never silently selects another run or executes a check.",
          routingIntegrity: "Lifecycle admission and routing writes are serialized across hosts. Canonical run records remain discoverable after missing/partial indices; authorized resume repairs that same run's binding. ROUTING_STORE_ERROR preserves corrupt bytes and may report a partially committed lifecycle change: inspect storage and status, never create a replacement. ROUTING_BUSY is bounded contention; retry after the owner finishes. Abandoned locks require inspected maintenance recovery, never a guessed PID kill or unconditional deletion. These are offline-tested controls, not a claim of an OS sandbox or total host accounting.",
          completionRequires: "complete is blocked until every required criterion has a current PASS receipt strong enough for its evidence class AND every required gate PASSes AND loss<=target(0); a reduced soft loss cannot beat a failed hard gate/required check.",
          memoryStatus: mem.status,
        }, null, 2);
      }
      if (!ACTIONS.includes(a)) {
        return JSON.stringify({ error: "unknown_action", detail: "Do NOT brute-force action names. Supported actions and parameters:", actions: ACTIONS, params: DEFAULT_PARAMS });
      }
      const store = new C.Store(SD);
      if (a === "start") {
        const budgetValidation = C.validateBudgetArgs(args);
        if (budgetValidation.error) return JSON.stringify(budgetValidation);
        const A = C.normalizeStartArgs(args); // v1.2.3: one place normalizes stringified arrays/objects + string budgets/booleans
        if (A.autoContinue === true) return JSON.stringify({ error: "AUTO_CONTINUATION_UNAVAILABLE", detail: "automatic continuation is OFF; start with autoContinue=false" });
        const req = A.request || context.request || "";
        const crit = Array.isArray(A.criteria) ? A.criteria : [];
        const catalogue = A.checkCatalogue || {};
        if (!req || !crit.length) return JSON.stringify({ error: "no_contract", detail: "start needs request text + >=1 acceptance criterion; refusing an untracked run" });
        // Resolve any existing project run. A NON-terminal run may NOT be overwritten; a terminal
        // (COMPLETE/CANCELLED) run does NOT block a new run. Never silently overwrite nonterminal.
        const { entries } = buildCandidates(context, null);
        const nonterm = entries.filter((x) => x.run && !C.RUN_TERMINAL_STATES.includes(x.run.status));
        if (nonterm.length === 1) {
          const r = nonterm[0].run;
          const match = (catalogue && r.checkCatalogue && keyOf(JSON.stringify(catalogue)) === keyOf(JSON.stringify(r.checkCatalogue))) || null;
          return JSON.stringify({ error: "EXISTING_RUN", runId: r.runId, state: r.status, contractHashMatch: match, candidates: `${C.candidateCount(r)}/${(r.budget && r.budget.iterations) || 40}`, nextActions: ["resume", "status", "cancel"], note: "a non-terminal run already exists for this project; cancel it or resume it before starting a new one (a non-terminal run is never overwritten)" });
        }
        if (nonterm.length > 1) {
          return JSON.stringify({ error: "AMBIGUOUS_RUN", ids: nonterm.map((x) => x.run.runId), nextActions: ["cancel", "status"], detail: "multiple non-terminal runs; pass an explicit runId — never guess" });
        }
        const vchk = C.validateStartContract({ criteria: crit, checkCatalogue: catalogue });
        if (!vchk.ok) return JSON.stringify({ error: "INVALID_CONTRACT", detail: "every REQUIRED criterion must map (via its checks field) to at least one declared check in checkCatalogue; criterion text alone is not verifiable and cannot reach loss=0. NO run was created — add the missing check mappings and retry action=start.", problems: vchk.problems });
        const contract = C.makeContract({ criteria: crit, hardGates: A.hardGates || [] });
        const fp = C.sourceFingerprint(dir);
        const mem = C.memory.assessStaleness(dir, C.memory.readMemoryIndex(dir));
        const budgets = C.defaultBudget();
        if (A.candidateBudget) budgets.iterations = A.candidateBudget;
        if (A.timeBudgetHours) budgets.activeSeconds = A.timeBudgetHours * 3600;
        if (A.deadlineHours) budgets.deadlineSeconds = A.deadlineHours * 3600;
        if (A.toolActionCap) budgets.toolActionCap = A.toolActionCap;
        if (A.sameFailureThreshold) budgets.sameFailureLimit = A.sameFailureThreshold;
        if (A.noProgressThreshold) budgets.noProgressLimit = A.noProgressThreshold;
        const out = C.startRun({ request: req, contract, budgets, sourceFingerprint: fp.hash, memoryStatus: mem.status, continuation: A.autoContinue === true, directory: dir, checkCatalogue: catalogue });
        if (out.error) return JSON.stringify(out);
        const run = out.run;
        run.compactionSessionID = context.sessionID;
        const key = C.stateKey(C.projectIdentity(dir), run.runId);
        store.writeJSON(key, "run.json", run);
        const runs = readRuns(SD); runs[context.sessionID] = { runKey: key, directory: dir, runId: run.runId, active: true, paused: false, checkCatalogue: catalogue, contractHash: run.contractHash }; writeRuns(SD, runs);
        const pk = keyOf(C.projectIdentity(dir).id); const proj = readProj(SD); const p = proj[pk] || { runs: [] }; if (!p.runs.includes(key)) p.runs.push(key); proj[pk] = p; writeProj(SD, proj);
        return JSON.stringify({ runId: run.runId, contractHash: run.contractHash, initialLoss: run.loss, budgets, memoryStatus: mem.status, sourceFingerprint: fp.hash, nextAction: "inspect code + choose first slice; then longrun_verify(checkId=..., runId=this)", continuation: false });
      }
      // v1.2.1: hierarchical-memory ops are STRUCTURAL and run WITHOUT an active tracked run.
      if (a === "memory_status") { const m = C.memory.assessStaleness(dir, C.memory.readMemoryIndex(dir)); return JSON.stringify({ state: "MEMORY", ...m, run: null }); }
      if (a === "memory_init") { const rep = C.memory.initDeep(dir, { maxDepth: args.maxDepth, dryRun: args.dryRun, regenerate: args.regenerate, harnessVersion: VERSION }); return JSON.stringify({ state: "MEMORY", dryRun: !!args.dryRun, created: rep.created.map((c) => ({ rel: c.rel, action: c.action })), preserved: rep.preserved.map((c) => c.rel), skipped: rep.skipped.length, run: null }); }
      if (a === "memory_refresh") { const rep = C.memory.initDeep(dir, { maxDepth: args.maxDepth, harnessVersion: VERSION }); return JSON.stringify({ state: "MEMORY", updated: rep.updated.map((c) => c.rel), unchanged: rep.unchanged.map((c) => c.rel), preserved: rep.preserved.map((c) => c.rel), created: rep.created.map((c) => c.rel), run: null }); }

      // ---- resolve the CURRENT project run (may be terminal; state codes handled per action) ----
      const { entries, exact } = buildCandidates(context, rid);
      if (rid && !exact) return JSON.stringify({ state: "NO_RUN", runId: rid, detail: "explicit runId is not bound to this project", discovery: runDiscovery(entries) }, null, 2);
      const cur = C.pickCurrentRun(entries);
      if (!cur || !cur.run) return JSON.stringify({ state: "NO_RUN", detail: "no active tracked run; call action=start (a prompt alone is NOT a tracked run). Project memory: memory_status/memory_init work without a run." });
      const run = cur.run; const rkey = cur.key;
      const observedFingerprint = C.sourceFingerprint(dir);
      const view = C.deriveRunView(run, { currentFingerprint: observedFingerprint,
        projectMemoryStatus: C.memory.assessStaleness(dir, C.memory.readMemoryIndex(dir)) });
      if (a === "status") return JSON.stringify(C.summarizeRunView(view), null, 2);
      if (a === "receipts") return JSON.stringify(C.receiptReadout(run, { ...args, currentFingerprint: observedFingerprint }), null, 2);
      if (a === "resume-context" || a === "next") return C.buildRecoveryPacket(run, 1500, view).packet;
      if (a === "verify") return JSON.stringify({ ...C.summarizeRunView(view), note: "no check executed (readout only)", execVia: "longrun_verify",
        declaredChecks: Object.keys(cur.cat || run.checkCatalogue || {}), detail: "Call longrun_verify with a declared checkId and runId." }, null, 2);
      if (a === "reconcile") {
        const recovered = store.mutate(rkey, latest => {
          const active = latest.execution?.inFlight;
          if (!active) return { ok: true, reconciled: false, nothingPending: true };
          if (!/^[a-f0-9-]{36}$/.test(active.token || "")) return { error: "INVALID_EXECUTION_RECORD", detail: "invalid reservation token" };
          if (C.execution.ownedWorkAlive(active.childPid)) return { error: "VERIFY_IN_FLIGHT" };
          const journal = store.readJSON(rkey, `execution-${active.token}.json`);
          if (!journal) return { error: C.execution.alive(active.executorPid) || !active.childPid && C.execution.alive(active.ownerPid) ? "VERIFY_IN_FLIGHT" : "EXECUTION_RECORD_MISSING", detail: "No finished result is available; keep the reservation and inspect execution evidence. Never infer a PASS or rerun concurrently." };
          const valid = C.validateExecutionRecord(latest, journal);
          if (!valid.ok) return valid;
          const result = C.commitExecutionResult(latest, journal, { currentFingerprint: C.sourceFingerprint(dir) });
          return result.error ? result : { ...result, reconciled: true, executionToken: active.token, state: latest.status };
        });
        return JSON.stringify({ runId: run.runId, ...recovered });
      }
      if (C.RUN_TERMINAL_STATES.includes(run.status)) {
        return JSON.stringify({ ok: false, error: run.status === "COMPLETE" ? "RUN_COMPLETE" : "RUN_CANCELLED", runId: run.runId, state: run.status, detail: `run ${run.runId} is ${run.status}; ordinary controls cannot modify it. An independent operator may explicitly reject and archive a premature COMPLETE for same-run correction; CANCELLED stays terminal. A new run is only for a genuinely new authorized task, never a budget or review bypass.` });
      }
      // Recheck terminal status under the same lock as the mutation: another host
      // can complete/cancel between our readout above and acquiring that lock.
      const mutateActive = callback => store.mutate(rkey, latest => {
        if (C.RUN_TERMINAL_STATES.includes(latest.status)) return { error: latest.status === "COMPLETE" ? "RUN_COMPLETE" : "RUN_CANCELLED", state: latest.status };
        return callback(latest);
      });
      if (a === "checkpoint") {
        if (args.progress !== undefined) {
          const saved = mutateActive(latest => C.saveAgentProgress(latest, args.progress, { sessionID: context.sessionID, fingerprint: view.currentFingerprint }));
          if (saved.error) return JSON.stringify(saved);
        }
        const current = store.readJSON(rkey, "run.json");
        const currentView = C.deriveRunView(current, { currentFingerprint: observedFingerprint, projectMemoryStatus: view.memory });
        store.writeJSON(rkey, "checkpoint.json", { at: Date.now(), state: current.status, candidates: C.candidateCount(current), fingerprint: currentView.currentFingerprint, view: currentView, packet: C.buildRecoveryPacket(current, 1500, currentView).packet });
        return args.progress === undefined ? "checkpointed" : JSON.stringify({ checkpointed: true, runId: current.runId, agentProgress: current.agentProgress });
      }
      if (a === "pause") {
        const changed = mutateActive(C.pauseRun);
        if (changed.error) return JSON.stringify(changed);
        const runs = readRuns(SD); if (runs[context.sessionID]) { runs[context.sessionID].paused = true; writeRuns(SD, runs); }
        return "paused";
      }
      if (a === "resume") {
        const okR = C.canResume(run, "user_session_command");
        if (!okR.ok) return JSON.stringify({ resumed: false, reason: okR.reason });
        const changed = mutateActive(latest => {
          const guard = C.execution.budgetGuard(latest, { fingerprint: observedFingerprint, canCount: false });
          if (!guard.ok) return { error: "BUDGET_EXHAUSTED", spent: guard.spent, detail: guard.note };
          if (latest.execution?.inFlight) return { error: "VERIFY_IN_FLIGHT", detail: "wait for the owned check to finish or reconcile its recorded result" };
          latest.status = "IMPLEMENTING"; latest.controlGeneration = (latest.controlGeneration || 0) + 1;
          latest.compactionSessionID = context.sessionID;
          return { ok: true };
        });
        if (changed.error) return JSON.stringify({ resumed: false, ...changed });
        // RE-BIND (v1.2.2): re-establish the current-session + current-worktree routing so a NEW
        // conversation can continue verifying the SAME run after compaction/restart.
        const runs = readRuns(SD); runs[context.sessionID] = { runKey: rkey, directory: dir, runId: run.runId, active: true, paused: false, checkCatalogue: run.checkCatalogue || {}, contractHash: run.contractHash }; writeRuns(SD, runs);
        const pk = keyOf(C.projectIdentity(dir).id); const proj = readProj(SD); const p = proj[pk] || { runs: [] }; if (!p.runs.includes(rkey)) p.runs.push(rkey); proj[pk] = p; writeProj(SD, proj);
        return JSON.stringify({ resumed: true, runId: run.runId, state: "IMPLEMENTING", rebound: true, note: "session+worktree binding re-established; pass runId to longrun_verify to continue in this new conversation" });
      }
      if (a === "cancel") {
        const changed = mutateActive(latest => {
          latest.status = "CANCELLED"; latest.autoEnabled = false; latest.controlGeneration = (latest.controlGeneration || 0) + 1;
          latest.state = latest.state || {}; latest.state.cancellation = { reason: args.reason || "cancelled", at: Date.now() }; return { ok: true };
        });
        if (changed.error) return JSON.stringify(changed);
        // preserve the record (no delete). disable further verification/modification + continuation,
        // and free the project so a future `start` may create a NEW run.
        const runs = readRuns(SD); if (runs[context.sessionID]) { runs[context.sessionID].paused = true; runs[context.sessionID].disabled = true; writeRuns(SD, runs); }
        return JSON.stringify({ cancelled: true, runId: run.runId, state: "CANCELLED", reason: args.reason || "cancelled", detail: "terminal; receipts/candidates/history preserved; further verification is RUN_CANCELLED; a new run may now be started" });
      }
      if (a === "complete") {
        const cc = C.canComplete(run, { view });
        if (!cc.complete) return JSON.stringify(C.summarizeRunView(cc), null, 2);
        const changed = mutateActive(latest => {
          if (latest.execution?.inFlight) return { error: "VERIFY_IN_FLIGHT" };
          const finalView = C.deriveRunView(latest, { currentFingerprint: C.sourceFingerprint(dir), projectMemoryStatus: view.memory });
          if (!C.canComplete(latest, { view: finalView }).complete) return { error: "EVIDENCE_CHANGED", detail: "refresh status before completing" };
          latest.status = "COMPLETE"; latest.controlGeneration = (latest.controlGeneration || 0) + 1; return { ok: true };
        });
        if (changed.error) return JSON.stringify(changed);
        const runs = readRuns(SD); if (runs[context.sessionID]) { runs[context.sessionID].active = false; writeRuns(SD, runs); }
        return JSON.stringify({ ...C.summarizeRunView(cc), state: "COMPLETE" }, null, 2);
      }
      return "handled";
    },
  });

  // ------- longrun_verify: declared-catalogue execution + evidence class + negative controls -------
  const verifyTool = mkTool({
    description: "Run a DECLARED project check by id against the authoritative tracked run and record an evidence receipt. Refuses arbitrary commands. Optional runId selects the run (strongly preferred for tracked workflows; a single active run may auto-resolve). Optional mode='negative' runs a NEGATIVE CONTROL against an isolated fixture (never the active source).",
    args: {
      checkId: helper ? helper.schema.string() : { type: "string" },
      evidenceClass: helper ? helper.schema.enum(["STATIC", "UNIT", "INTEGRATION", "SYSTEM", "BROWSER", "VISION", "HUMAN/EXTERNAL", "proxy"]).optional() : { type: "string" },
      mode: helper ? helper.schema.enum(["normal", "negative"]).optional() : { type: "string" },
      fixture: helper ? helper.schema.string().optional() : { type: "string" },
      runId: helper ? helper.schema.string().optional() : { type: "string" },
    },
    async execute(args, context) {
      bumpActivity(context, context.sessionID);
      const checkId = args.checkId;
      const rid = (args && (args.runId || args.run)) || null;
      const { entries, exact } = buildCandidates(context, rid);
      // single authoritative run, resolved the SAME way the control plane resolves it; state -> code.
      const rr = C.resolveVerification({ entries, explicitRunId: rid });
      if (!rr.ok) return JSON.stringify({ ok: false, error: rr.code, state: rr.state || null, runId: rr.runId || rid || null, ids: rr.ids || undefined, detail: rr.detail || "no eligible active run to verify", ...(rid && !exact ? { discovery: runDiscovery(entries) } : {}) }, null, 2);
      const entry = rr.entry || {}; const run = rr.run; const rkey = entry.key;
      const catalogue = entry.cat || run.checkCatalogue || {};
      const cwd = context.directory || context.worktree || entry.dir;
      const check = catalogue[checkId];
      if (!check || !Array.isArray(check.command)) return JSON.stringify({ ok: false, error: "undeclared_check", detail: "not in the resolved run's declared catalogue (no shell bypass)" });
      const store = new C.Store(SD), negative = args.mode === "negative";
      let fixture;
      if (negative) {
        if (!C.evidence.negativeControlAllowed(check)) return JSON.stringify({ ok: false, error: "not_eligible", detail: "negative controls are for declared eligible checks" });
        if (!args.fixture || !fs.existsSync(args.fixture)) return JSON.stringify({ ok: false, error: "no_fixture", detail: "provide a physically isolated fixture" });
        const isolated = C.validateNegativeFixture(args.fixture, [run.directory, entry.dir, context.directory, context.worktree]);
        if (!isolated.ok) return JSON.stringify(isolated);
        fixture = isolated.fixture;
      }
      const projectRoot = run.directory || entry.dir || cwd;
      const fpBefore = C.sourceFingerprint(cwd || entry.dir);
      const ranInProject = projectRoot && path.resolve(cwd || "") === path.resolve(projectRoot);
      const fpScope = ranInProject ? "project" : "copy";
      const targetFingerprint = negative ? C.sourceFingerprint(fixture).hash : null;
      const productionBefore = negative ? C.sourceFingerprint(projectRoot).hash : null;
      const token = crypto.randomUUID();
      const reservation = store.mutate(rkey, latest => {
        const category = C.runVerifyCategory(latest);
        if (!category.eligible) return { error: category.code, state: latest.status };
        const active = latest.execution?.inFlight;
        if (active) {
          if (C.execution.alive(active.ownerPid) || C.execution.alive(active.executorPid) || C.execution.ownedWorkAlive(active.childPid)) return { error: "VERIFY_IN_FLIGHT", execution: active, detail: "the recorded owner or owned check is still live; do not launch a competing check" };
          return { error: "EXECUTION_RECOVERY_REQUIRED", execution: active, detail: "owner/executor/owned check are absent; call longrun action=reconcile with this runId before retrying, never infer a PASS" };
        }
        const guard = C.execution.budgetGuard(latest, { fingerprint: fpBefore, mode: args.mode, canCount: ranInProject });
        if (!guard.ok) {
          const paused = C.pauseRun(latest);
          // Store.mutate commits only non-error callback results. Commit the
          // canonical pause before exposing the refusal; never reserve a check
          // or depend on the model to stop after it receives the budget error.
          return { refused: { error: "BUDGET_EXHAUSTED", state: paused.state,
            cancelledContinuations: paused.cancelledContinuations, spent: guard.spent, usage: guard.usage,
            detail: `Run paused; no check launched or usage added. Preserve the original limits and evidence; do not bypass through another tool/session or a replacement run. ${guard.note}` } };
        }
        const usage = C.execution.initialize(latest);
        usage.commandAttempts++;
        usage.inFlight = { token, ownerPid: process.pid, childPid: null, sessionID: context.sessionID,
          checkId, declaredCheck: structuredClone(check), mode: negative ? "negative" : "normal", startedAt: Date.now(), generation: latest.controlGeneration || 0 };
        return { guard, generation: latest.controlGeneration || 0 };
      });
      if (reservation.error) return JSON.stringify({ ok: false, runId: run.runId, ...reservation });
      if (reservation.refused) return JSON.stringify({ ok: false, runId: run.runId, ...reservation.refused });
      const worker = await C.execution.runDurableCheck({ stateDir: SD, runKey: rkey, token, runId: run.runId, checkId,
        cwd: cwd || entry.dir, projectRoot, fixture, fpBefore, fpScope, targetFingerprint, productionBefore,
        evidenceClass: C.defaultEvidenceClass(run, checkId, args.evidenceClass), timeout: C.execution.timeoutFor(check, reservation.guard),
        deadlineAt: C.execution.timing(run).deadlineAt,
      }, { env: sanitizeEnv(), signal: context.abort,
        onExecutor: pid => store.mutate(rkey, latest => {
          if (latest.execution?.inFlight?.token !== token) return { error: "RESERVATION_CHANGED" };
          latest.execution.inFlight.executorPid = pid || null; return { ok: true };
        }),
      });
      const journal = store.readJSON(rkey, `execution-${token}.json`);
      if (!journal) return JSON.stringify({ ok: false, error: "EXECUTION_RECORD_MISSING", runId: run.runId, executionToken: token,
        worker, detail: "The executor left no completed evidence. Reservation retained; inspect/reconcile, never infer a result or rerun concurrently." });
      const { receipt, negativeControl, fingerprintAfter: fp } = journal;
      let committed;
      for (let attempt = 0; attempt < 30; attempt++) {
        committed = store.mutate(rkey, latest => C.commitExecutionResult(latest, journal));
        if (committed.error !== "STATE_BUSY") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!committed?.ok) return JSON.stringify({ ok: false, error: "RESULT_COMMIT_PENDING", runId: run.runId, executionToken: token, detail: "actual execution evidence saved; call longrun action=reconcile with this runId; do not rerun the command", cause: committed?.error });
      if (negative) return JSON.stringify({ ...negativeControl, runId: run.runId, executionUsage: committed.usage,
        detail: negativeControl.ok ? "Fixture exited nonzero; review output for the intended assertion failure." : "Expected defect detection was not demonstrated; inspect execution details." });
      return JSON.stringify({ status: receipt.status, statusIfStale: C.resolveReceiptStatus(receipt, fp.hash), fpScope,
        runId: run.runId, candidateCounted: committed.apply.candidate.counted, candidateCount: committed.candidateCount,
        gap: committed.apply.gaps, outputTail: receipt.outputTail, receipt: C.checkDiagnostics(store.readJSON(rkey, "run.json"), checkId, fp).historicalReceipts.at(-1), executionUsage: committed.usage });
    },
  });

  const result = {
    tool: { longrun: longrunTool, longrun_verify: verifyTool },

    "tool.execute.before": async (call, output) => {
      if (!SD) return; // no configured store outside an actual host/test context
      readProj(SD); // corrupt routing cannot silently disable the recovery guard
      const entry = readRuns(SD)[call.sessionID];
      let run;
      if (entry?.runKey) {
        // Store.readJSON deliberately has a fallback for other callers. Admission
        // cannot treat missing/corrupt canonical bytes as an untracked session.
        try {
          run = JSON.parse(fs.readFileSync(path.join(SD, "state", entry.runKey, "run.json"), "utf8"));
          if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("invalid canonical record");
        } catch (error) {
          throw new RoutingError(`bound canonical record ${entry.runKey} unreadable (${error.code || error.name}); preserve it and recover storage before execution`);
        }
      }
      const hostDirectories = [input?.directory, input?.worktree].filter(Boolean);
      if (run && hostDirectories.length) {
        const canonicalDirectory = run.directory || entry.directory;
        if (!canonicalDirectory || !hostDirectories.some(dir => C.projectIdentity(dir).id === C.projectIdentity(canonicalDirectory).id)) run = null;
      }
      if (!run && hostDirectories.length) {
        // A fresh host session must not evade the project's deadline merely by
        // lacking a binding. Use the real factory directory and canonical discovery,
        // not model-supplied tool arguments or another project's cached metadata.
        const { entries } = buildCandidates({ directory: input.directory, worktree: input.worktree, sessionID: call.sessionID }, null);
        const open = entries.filter(e => !C.RUN_TERMINAL_STATES.includes(e.run.status));
        const expired = open.find(e => C.execution.timing(e.run).expired);
        run = expired?.run || C.pickCurrentRun(open)?.run;
      }
      if (!run) return;
      const timing = C.execution.timing(run);
      if (timing.expired) {
        const action = output?.args?.action;
        const bookkeeping = ["help", "status", "receipts", "next", "resume-context", "verify", "checkpoint", "pause", "cancel", "complete", "reconcile", "resume", "memory_status"];
        const nativeControl = call.tool === "longrun" && (bookkeeping.includes(action) || (action === "start" && C.RUN_TERMINAL_STATES.includes(run.status)));
        // The verifier remains callable so it can return its structured refusal;
        // it already rechecks admission under the run's writer lock. Control-plane
        // resume also keeps its own budget check. No counter or receipt is changed here.
        if (!nativeControl && call.tool !== "longrun_verify") throw new Error(`LONGRUN_DEADLINE_EXPIRED: run ${run.runId}; deadline ${new Date(timing.deadlineAt).toISOString()}, observed ${new Date(timing.observedAt).toISOString()}. Stop implementation and checks; use native longrun status/checkpoint/pause. Do not bypass through another tool/session, reset budgets or create a replacement run. This admission guard cannot stop an ordinary tool already executing.`);
      }
      if (C.isVerifyEligible(run.status)) return;
      // The canonical lifecycle, not a cached active flag or a model's summary,
      // controls ordinary implementation too. Reads and native recovery remain
      // available; memory regeneration is a write even though it is a native tool.
      const readsAndControl = ["read", "glob", "grep", "list", "skill", "question", "todowrite", "longrun", "longrun_verify"];
      const memoryWrite = call.tool === "longrun" && ["memory_init", "memory_refresh"].includes(output?.args?.action);
      if (readsAndControl.includes(call.tool) && !memoryWrite) return;
      if (run.status === "RECOVERY_REQUIRED") throw new Error(`LONGRUN_RECOVERY_REQUIRED: run ${run.runId}; call longrun action=resume-context with this runId, then authorized action=resume before execution or edits. Do not bypass through bash, another tool or a replacement run.`);
      const category = C.runVerifyCategory(run);
      throw new Error(`LONGRUN_${category.code}: run ${run.runId} is ${run.status}; ordinary execution, edits and memory writes are stopped. Native status/resume-context/checkpoint remain available. Resume the SAME nonterminal run only for authorized work; terminal runs remain terminal. Do not bypass through another tool or session.`);
    },

    event: async ({ event }) => {
      if (!event || !event.properties) return; const sid = event.properties.sessionID; if (!sid) return;
      const e = runFor(SD, sid); if (!e || e.paused) return;
      if (event.type === "session.compacted") {
        return recordCompaction(e, sid);
      }
    },

    "experimental.session.compacting": async (input, output) => {
      const e = runFor(SD, input.sessionID); if (!e) return;
      const store = new C.Store(SD); const run = store.readJSON(e.runKey, "run.json"); if (!run) return;
      const dir = e.directory || run.directory; if (!dir) return;
      // Compaction needs the same current-source view as explicit recovery. The run's
      // persisted fingerprint describes its last verification, not necessarily today's files.
      const view = C.deriveRunView(run, { currentFingerprint: C.sourceFingerprint(dir),
        projectMemoryStatus: C.memory.assessStaleness(dir, C.memory.readMemoryIndex(dir)) });
      const preface = `## Long-run recovery\nPRE-COMPACTION SNAPSHOT: the state below precedes the completed-compaction event. After compaction, first call longrun action=resume-context with runId=${run.runId}, then, only for authorized active work, action=resume for the SAME run before execution or edits. Do not infer continued IMPLEMENTING from this snapshot. Paused/terminal runs stay stopped; budget refusals are not permission to bypass. Preserve this recovery instruction in the summary.\n`;
      const { packet } = C.buildRecoveryPacket(run, 1500 - preface.split(/\s+/).filter(Boolean).length, view);
      if (Array.isArray(output.context)) output.context.push(preface + packet); // supplement, do not replace the default prompt
    },

    "experimental.compaction.autocontinue": async (input, output) => {
      let e;
      try { readProj(SD); e = readRuns(SD)[input.sessionID]; }
      catch (error) { if (error instanceof RoutingError) { if (output) output.enabled = false; return; } throw error; }
      if (!e) return;
      if (e.paused || e.disabled) { if (output) output.enabled = false; return; }
      // This is OpenCode's continuation of an already active user turn, not the
      // Longrun scheduler (which remains OFF). Preserve another plugin's veto.
      // Repeat the idempotent transition here in case event delivery was delayed
      // or its writer lock stayed busy. Uncertain state must not start more work.
      const recorded = await recordCompaction(e, input.sessionID);
      if (!recorded?.ok || recorded.staleSession) { if (output) output.enabled = false; return; }
      const store = new C.Store(SD);
      const checked = store.mutate(e.runKey, latest => {
        // Legacy runs without this explicit start/resume binding need an authorized
        // resume before continuing; never guess an owner from cached routing flags.
        if (latest.compactionSessionID !== input.sessionID || latest.status !== "RECOVERY_REQUIRED" || latest.execution?.inFlight) return { allowed: false };
        let fingerprint;
        try { fingerprint = C.sourceFingerprint(latest.directory || e.directory); }
        catch { return { allowed: false }; }
        const guard = C.execution.budgetGuard(latest, { fingerprint });
        return { allowed: guard.ok };
      });
      if (!checked.allowed && output) output.enabled = false;
    },
  };

  const executeControl = longrunTool.execute;
  longrunTool.execute = async (args, context) => {
    try {
      if (["start", "resume", "pause", "cancel", "complete"].includes(args?.action)) {
        return await withRoutingLock(SD, () => executeControl(args, context));
      }
      return await executeControl(args, context);
    } catch (error) {
      if (error instanceof RoutingError || ["ROUTING_BUSY", "ROUTING_STORE_ERROR"].includes(error.code)) return JSON.stringify({ error: error.code, detail: error.message });
      throw error;
    }
  };

  if (result.tool && result.tool.longrun && result.tool.longrun_verify) { try { writeLoadRecord(input || {}); } catch {} }
  return result;
};

export default { id: "longrun", server };
