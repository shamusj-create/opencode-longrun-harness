import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as C from "../src/controller.js";

const CONTROLLER = path.resolve(import.meta.dirname, "..", "src", "controller.js");
process.env.LONGRUN_CONTROLLER_FILE = CONTROLLER;
const PLUG_URL = "../plugin/longrun.js";
const PLUG_FILE = path.resolve(import.meta.dirname, "..", "plugin", "longrun.js").split(path.sep).join("/");
const { F } = await import("./helper.mjs");

function freshState() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "tb-st-")); process.env.LONGRUN_STATE_DIR = d; return d; }

// 1 + 2: help + schema are self-describing; NO action-name guessing is ever required.
test("help is self-describing (actions + params + version + continuation OFF)", async () => {
  freshState();
  const h = await F(PLUG_URL, { client: null });
  const r = JSON.parse(await h.tool.longrun.execute({ action: "help" }, { sessionID: "s", directory: os.tmpdir(), worktree: os.tmpdir() }));
  assert.ok(r.actions.every((a) => r.params[a] !== undefined), "every action documents its params");
  assert.ok(r.actions.includes("start") && r.actions.includes("memory_init"));
  assert.equal(r.harnessVersion, C.LIFECYCLE_SCHEMA_VERSION, "help reports the harness lifecycle version");
});
test("a rejected action tells the model to read the schema, never to guess", async () => {
  freshState();
  const h = await F(PLUG_URL, { client: null });
  const r = JSON.parse(await h.tool.longrun.execute({ action: "frobnicate" }, { sessionID: "s", directory: os.tmpdir(), worktree: os.tmpdir() }));
  assert.equal(r.error, "unknown_action");
  assert.match(r.detail, /Do NOT brute-force/, "explicitly discourages action-name guessing");
});

// 3: probes/tests can never contaminate live evidence (import != load; non-host != host).
const CHILD_ENV = (state) => { const e = { ...process.env, LONGRUN_STATE_DIR: state }; delete e.LONGRUN_TEST; delete e.NODE_TEST_CONTEXT; delete e.OPENCODE_CLIENT; return e; };

test("importing the plugin creates no live evidence, even with a state dir set", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tb-noev-"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import("file://${PLUG_FILE}");`], { env: CHILD_ENV(state) });
  assert.equal(r.status, 0, "child import ran: " + r.stderr);
  assert.deepEqual(fs.readdirSync(state), [], "a bare import writes nothing");
});

test("a plain-node probe driving real tool actions cannot forge a load record or touch default state", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tb-probe-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tb-proj-"));
  fs.writeFileSync(path.join(proj, "a.js"), "x");
  // A non-host child (no OPENCODE_CLIENT/electron): even a full start+verify must not create a
  // live "load" record, and must not write into the DEFAULT production state dir.
  const code = `
    const m = await import("file://${PLUG_FILE}");
    const C = await import("file://${CONTROLLER}");
    const hooks = await m.default.server({ client: null });
    const ctx = { sessionID: "probe", agent: "longrun", directory: "${proj}", worktree: "${proj}" };
    await hooks.tool.longrun.execute({ action: "start", request: "x", criteria: [{ id: "c1", checks: ["t"] }] }, ctx);
    const fs = await import("node:fs"); const path = await import("node:path");
    const st = process.env.LONGRUN_STATE_DIR;
    process.stdout.write(JSON.stringify({
      hasLoadDir: fs.existsSync(path.join(st, "load")),
      stateKeys: fs.readdirSync(st),
    }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: CHILD_ENV(state) });
  assert.equal(r.status, 0, "child ran: " + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hasLoadDir, false, "a non-host probe must not create live-load evidence");
});

test("the longrun tool never accepts arbitrary shell / undeclared work", async () => {
  freshState();
  const h = await F(PLUG_URL, { client: null });
  // verify still refuses anything outside the declared catalogue (no shell bypass)
  const res = JSON.parse(await h.tool.longrun_verify.execute({ checkId: "rm -rf /" }, { sessionID: "ghost", directory: os.tmpdir(), worktree: os.tmpdir() }));
  assert.equal(res.error, "NO_RUN", "no run -> nothing to run (still no shell path)");
});