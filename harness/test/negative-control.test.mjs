import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../src/controller.js";

const CONTROLLER = path.resolve(import.meta.dirname, "..", "src", "controller.js");
process.env.LONGRUN_CONTROLLER_FILE = CONTROLLER;
const PLUG_URL = "../plugin/longrun.js";
const { F } = await import("./helper.mjs");

function freshState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "lrnc-st-")); process.env.LONGRUN_STATE_DIR = d; return d; }

// A read-only protected runner: it only READS ./app.mjs (never writes anything).
const RUNNER = `
import { Widget } from "./app.mjs";
let fail = 0;
try { const w = new Widget(); if (!w.render().includes("hero")) { fail++; } } catch { fail++; }
console.log("RESULT " + (fail === 0 ? "PASS" : "FAIL"));
process.exit(fail === 0 ? 0 : 1);
`;
const APP_FIXED = `export class Widget { render(){ return "hero + scene"; } }`;
const APP_BROKEN = `export class Widget { render(){ return "nothing attached"; } }`; // hero missing => runner fails

function fixture(app) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-")); fs.writeFileSync(path.join(d, "app.mjs"), app); fs.writeFileSync(path.join(d, "run_acceptance.mjs"), RUNNER); return d; }
function project(app) { const d = fixture(app); return d; } // project layout identical to a fixture

function safeRuns(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, "runs.json"), "utf8")); } catch { return {}; } }

async function seededRun({ app, check = { command: ["node", "run_acceptance.mjs"], kind: "test", integration: true, gate: true, negativeControl: true } }) {
  freshState();
  const dir = project(app);
  const h = await F(PLUG_URL, { client: null });
  const id = C.projectIdentity(dir);
  const key = C.stateKey(id, "run1");
  const store = new C.Store(process.env.LONGRUN_STATE_DIR);
  const run = C.startRun({ request: "t", contract: { criteria: [{ id: "c1", required: true, checks: ["acc"], status: "FAIL", visual: true }], gates: [{ id: "render-gate", required: true, status: "FAIL" }], lossTarget: 0 }, budgets: C.defaultBudget(), sourceFingerprint: C.sourceFingerprint(dir).hash, directory: dir, checkCatalogue: { acc: check } }).run;
  store.writeJSON(key, "run.json", run);
  const runs = safeRuns(process.env.LONGRUN_STATE_DIR);
  runs["sess-1"] = { runKey: key, directory: dir, checkCatalogue: { acc: check } };
  fs.writeFileSync(path.join(process.env.LONGRUN_STATE_DIR, "runs.json"), JSON.stringify(runs));
  return { h, dir, key, store };
}
const CTX = (dir) => ({ sessionID: "sess-1", agent: "longrun", directory: dir, worktree: dir });

// ---- a known-broken fixture makes the protected verifier FAIL (live verifier) --------------
test("negative control: a known-broken fixture causes the protected verifier to fail", async () => {
  const { h, dir } = await seededRun({ app: APP_FIXED });
  const brokenFixture = fixture(APP_BROKEN); // isolated temp copy of the BROKEN implementation
  const res = JSON.parse(await h.tool.longrun_verify.execute({ checkId: "acc", mode: "negative", fixture: brokenFixture }, CTX(dir)));
  assert.equal(res.kind, "negative_control");
  assert.equal(res.ok, true, "verifier correctly failed on the broken fixture (proving it is live)");
});

// ---- a negative run must NOT be satisfied by the healthy app, and cannot touch production --
test("a negative control against the HEALTHY app is not a valid negative + never mutates production", async () => {
  const { h, dir } = await seededRun({ app: APP_FIXED });
  const fpBefore = C.sourceFingerprint(dir).hash;
  const res = JSON.parse(await h.tool.longrun_verify.execute({ checkId: "acc", mode: "negative", fixture: project(APP_FIXED) }, CTX(dir)));
  assert.equal(res.kind, "negative_control");
  assert.equal(res.ok, false, "the verifier passed a healthy fixture => NOT a valid negative control (warning)");
  // production state must be byte-identical afterwards (isolated fixture cwd only)
  assert.equal(C.sourceFingerprint(dir).hash, fpBefore, "negative run must not mutate the active project");
});

// ---- a negative control without an isolated fixture is refused (no destructive path) -------
test("negative control without a fixture is refused (never edits the active source)", async () => {
  const { h, dir } = await seededRun({ app: APP_FIXED });
  const res = JSON.parse(await h.tool.longrun_verify.execute({ checkId: "acc", mode: "negative" }, CTX(dir)));
  assert.equal(res.error, "no_fixture");
});

// ---- restored (healthy) app passes the normal verifier -------------------------------------
test("the restored/healthy implementation passes the normal verifier (positive control)", async () => {
  freshState();
  const dir = project(APP_FIXED); // project contains the FIXED app + runner
  const h = await F(PLUG_URL, { client: null });
  const id = C.projectIdentity(dir);
  const key = C.stateKey(id, "run1");
  const store = new C.Store(process.env.LONGRUN_STATE_DIR);
  // baseline fingerprint differs from the live source -> this eval is an evaluated CHANGED state
  const run = C.startRun({ request: "t", contract: { criteria: [{ id: "c1", required: true, checks: ["acc"], status: "FAIL" }], gates: [], lossTarget: 0 }, budgets: C.defaultBudget(), sourceFingerprint: "baseline-before-edit", directory: dir, checkCatalogue: { acc: { command: ["node", "run_acceptance.mjs"], kind: "cmd" } } }).run;
  store.writeJSON(key, "run.json", run);
  const runs = safeRuns(process.env.LONGRUN_STATE_DIR);
  runs["sess-1"] = { runKey: key, directory: dir, checkCatalogue: { acc: { command: ["node", "run_acceptance.mjs"], kind: "cmd" } } };
  fs.writeFileSync(path.join(process.env.LONGRUN_STATE_DIR, "runs.json"), JSON.stringify(runs));
  const res = JSON.parse(await h.tool.longrun_verify.execute({ checkId: "acc" }, CTX(dir)));
  assert.equal(res.status, "PASS", "healthy app passes; candidateCounted should follow a real eval");
  assert.equal(res.candidateCounted, true);
});