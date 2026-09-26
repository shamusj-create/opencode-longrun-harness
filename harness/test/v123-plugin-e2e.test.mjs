import { reviewProjectFixture } from "./helper.mjs";
// v1.2.3 end-to-end reproduction through the REAL plugin tool factory + controller (LONGRUN_TEST
// armed; isolated state dir). Reproduces the class of failure at the tool surface:
// a hard gate must be decided by its own CURRENT evidence, a negative control against a copied
// fixture must not become a project failure, and a passing build must let the run complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../src/controller.js";

process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, "..", "src", "controller.js");
const PLUG_URL = "../plugin/longrun.js";
const { F } = await import("./helper.mjs");

function freshState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "lr123-st-")); process.env.LONGRUN_STATE_DIR = d; return d; }

const VERIFY_ALL = `
import fs from "node:fs";
const src = fs.readFileSync("./app.txt", "utf8");
console.log("checks run: 3");
process.exit(src.includes("BROKEN") ? 1 : 0);
`;
function project(good = true) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lr123-proj-"));
  fs.writeFileSync(path.join(d, "app.txt"), good ? "GOOD hero scene" : "BROKEN nothing");
  fs.writeFileSync(path.join(d, "typecheck.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(d, "build.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(d, "verify-all.mjs"), VERIFY_ALL);
  return d;
}
const CAT = {
  "c-typecheck": { command: ["node", "typecheck.mjs"], kind: "cmd", gate: true },
  "c-build": { command: ["node", "build.mjs"], kind: "cmd", gate: true },
  "c-verify-all": { command: ["node", "verify-all.mjs"], kind: "cmd", gate: true, negativeControl: true },
};
// ENG is class-agnostic (no evidenceClass) so the criterion is satisfied by ANY clean receipt and
// the ONLY thing under test is the hard-gate recomputation. Criteria supplied as a JSON STRING to
// prove the single MTPLX-input normalizer; the gate checks are all NON-test (kind cmd).
const START = {
  action: "start", request: "Verify the v1.2.3 build/gate reliability release",
  criteria: JSON.stringify([{ id: "ENG", required: true, weight: 1, checks: ["c-typecheck", "c-build", "c-verify-all"] }]),
  hardGates: JSON.stringify(["c-typecheck", "c-build", "c-verify-all"]),
  checkCatalogue: JSON.stringify(CAT),
};
const CTX = (d) => ({ sessionID: "s123", agent: "longrun", directory: d, worktree: d });

async function tools() { freshState(); return (await F(PLUG_URL, { client: null })).tool; }
const gateRow = (st, id) => st.gates.find((g) => g.id === id);

test("start accepts JSON-string criteria/hardGates/checkCatalogue and creates a real run", async () => {
  const t = await tools(); const d = project(); const c = CTX(d);
  const start = JSON.parse(await t.longrun.execute({ ...START }, c));
  assert.ok(start.runId, "run created from stringified structured params");
  assert.equal(start.initialLoss, 1);
  const st = JSON.parse(await t.longrun.execute({ action: "status" }, c));
  assert.equal(st.runId, start.runId, "the stringified catalogue bound correctly (status resolves the run)");
  assert.equal(st.gates.length, 3, "the three hard gates are surfaced in the status readout");
});

test("SABOTAGE (isolated fixture) records a negative control, NOT a project failure", async () => {
  const t = await tools(); const d = project(true); const c = CTX(d);
  const start = JSON.parse(await t.longrun.execute({ ...START }, c));
  const RUN = start.runId;
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "lr123-fx-"));
  fs.writeFileSync(path.join(fx, "app.txt"), "BROKEN nothing");
  fs.writeFileSync(path.join(fx, "verify-all.mjs"), VERIFY_ALL);
  const neg = JSON.parse(await t.longrun_verify.execute({ checkId: "c-verify-all", mode: "negative", fixture: fx, runId: RUN }, c));
  assert.equal(neg.kind, "negative_control", "the sabotage ran through the dedicated negative-control channel");
  assert.equal(neg.ok, true, "the broken fixture correctly failed the verifier");
  const run = new C.Store(process.env.LONGRUN_STATE_DIR).readJSON(C.stateKey(C.projectIdentity(d), RUN), "run.json");
  assert.equal((run.receipts || []).filter((r) => r.checkId === "c-verify-all").length, 0, "no positive receipt was made from the sabotage");
  assert.ok((run.evidence || []).some((e) => e.kind === "negative_control" && e.checkId === "c-verify-all"), "negative control lives in its own channel");
});

test("passing build + restored verify-all complete a gate-bound run (the reported failure is fixed)", async () => {
  const t = await tools(); const d = project(true); const c = CTX(d);
  const start = JSON.parse(await t.longrun.execute({ ...START }, c));
  const RUN = start.runId;
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "lr123-fx-"));
  fs.writeFileSync(path.join(fx, "app.txt"), "BROKEN nothing"); fs.writeFileSync(path.join(fx, "verify-all.mjs"), VERIFY_ALL);
  await t.longrun_verify.execute({ checkId: "c-verify-all", mode: "negative", fixture: fx, runId: RUN }, c); // sabotage first
  for (const id of ["c-typecheck", "c-build", "c-verify-all"]) {
    const v = JSON.parse(await t.longrun_verify.execute({ checkId: id, runId: RUN }, c));
    assert.equal(v.status, "PASS", `${id} passes as a non-test gate (no test receipt required)`);
    assert.equal(v.fpScope, "project", "a project-run receipt is recorded against the project scope");
  }
  const st = JSON.parse(await t.longrun.execute({ action: "status" }, c));
  assert.deepEqual(st.gates.filter((g) => !g.satisfied).map((g) => g.id), [], "all hard gates now read satisfied");
  reviewProjectFixture(d, RUN);
  const done = JSON.parse(await t.longrun.execute({ action: "complete" }, c));
  assert.equal(done.complete, true, "a passing build/tests gate the run -> completion, no longer stuck FAIL");
});

test("REGRESSION GUARD: a genuinely newer failure is not masked by an earlier PASS", async () => {
  const t = await tools(); const d = project(true); const c = CTX(d);
  const start = JSON.parse(await t.longrun.execute({ ...START }, c));
  const RUN = start.runId;
  for (const id of ["c-typecheck", "c-build"]) await t.longrun_verify.execute({ checkId: id, runId: RUN }, c);
  await t.longrun_verify.execute({ checkId: "c-verify-all", runId: RUN }, c); // PASS on the healthy source
  fs.writeFileSync(path.join(d, "app.txt"), "BROKEN nothing"); // regress, WITHOUT completing
  const fail = JSON.parse(await t.longrun_verify.execute({ checkId: "c-verify-all", runId: RUN }, c));
  assert.equal(fail.status, "FAIL", "the re-run honestly fails on the broken source");
  const st = JSON.parse(await t.longrun.execute({ action: "status" }, c));
  assert.equal(gateRow(st, "c-verify-all").status, "FAIL", "the gate reads the newest FAIL, not the older PASS");
  const done = JSON.parse(await t.longrun.execute({ action: "complete" }, c));
  assert.equal(done.complete, false, "completion re-blocks; the older PASS does not mask the regression");
});

test("STALE GUARD: an old PASS does not survive a source change (blocked until re-verified)", async () => {
  const t = await tools(); const d = project(true); const c = CTX(d);
  const start = JSON.parse(await t.longrun.execute({ ...START }, c));
  const RUN = start.runId;
  for (const id of ["c-typecheck", "c-build", "c-verify-all"]) await t.longrun_verify.execute({ checkId: id, runId: RUN }, c);
  fs.writeFileSync(path.join(d, "extra.txt"), "changed"); // unrelated source edit changes the fingerprint
  const done = JSON.parse(await t.longrun.execute({ action: "complete" }, c));
  assert.equal(done.complete, false, "after the source changed the earlier gate passes are stale");
  assert.equal(done.reason, "stale_evidence", "reported distinctly as stale evidence, not a silent pass");
});