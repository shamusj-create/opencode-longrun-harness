import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the plugin at the shared controller + an isolated state dir BEFORE import.
const CONTROLLER = path.resolve(import.meta.dirname, "..", "src", "controller.js");
process.env.LONGRUN_CONTROLLER_FILE = CONTROLLER;
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "lrplug-"));
process.env.LONGRUN_STATE_DIR = STATE;

// The plugin entrypoint now exposes ONE export (the async factory). Tests use it via helper.F.
const PLUG_URL = "../plugin/longrun.js";
const SRC_PLUG = await import(PLUG_URL);
const { F, readRuns, writeRuns } = await import("./helper.mjs");
const { install } = await import("../src/install.mjs");
const C = await import("../src/controller.js");

// ---- 1) ARTIFACT-LEVEL LOADER CONTRACT (the real bug: a non-function / non-plugin export made
// the desktop loader throw "Plugin export is not a function" and skip the whole plugin).
// Faithful re-implementation of the backend loader: EVERY module export must be a server plugin —
// a callable function OR a strict `{ id, server }` descriptor whose server is callable — or throw.
const isServerPlugin = (v) => typeof v === "function" || (v !== null && typeof v === "object" && typeof v.server === "function");
function loaderCollect(mod) { const seen = new Set(); const out = []; for (const e of Object.values(mod)) { if (seen.has(e)) continue; seen.add(e); if (!isServerPlugin(e)) throw new TypeError("Plugin export is not a function"); out.push(typeof e === "function" ? e : e.server); } return out; }

function assertLoaderInvariant(mod, label) {
  const keys = Object.keys(mod);
  assert.deepEqual(keys, ["default"], `${label}: exactly ONE module export (default) — found: ${keys.join(",") || "(none)"}`);
  assert.equal(typeof mod.default, "object", `${label}: default must be the V1 { id, server } descriptor`);
  assert.equal(mod.default.id, "longrun", `${label}: descriptor id must be "longrun"`);
  assert.equal(typeof mod.default.server, "function", `${label}: descriptor server must be callable`);
  assert.doesNotThrow(() => loaderCollect(mod), `${label}: desktop loader must accept every export`);
}
test("LOADER CONTRACT: bad module shapes throw (negative control)", () => {
  assert.throws(() => loaderCollect({ default: { hooks: {} } }), TypeError, "object export without callable server");
  assert.throws(() => loaderCollect({ default: { id: "x" } }), TypeError, "descriptor without callable server");
  assert.throws(() => loaderCollect({ helper: 42 }), TypeError, "non-plugin value");
});
test("ARTIFACT invariant: SOURCE plugin exposes exactly one function export", async () => {
  assertLoaderInvariant(SRC_PLUG, "source");
});
test("ARTIFACT invariant: INSTALLER-COPIED plugin passes the same loader contract", async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "install-"));
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  const rep = install({ configDir: cfg }); // run the ACTUAL installer -> generates the copied artifact
  const built = path.join(cfg, "plugins", "longrun.js");
  assert.ok(fs.existsSync(built), "installer produced plugins/longrun.js");
  assert.ok(!rep.conflicts.some((c) => c.rel.includes("longrun.js")));
  const BUILT = await import("file://" + built); // import the GENERATED artifact, not the source
  assertLoaderInvariant(BUILT, "built/copy");
  // the baked controller must resolve, and the built factory must build real hooks
  const hooks = await BUILT.default.server({ client: { app: { log: () => {} } } });
  assert.ok(hooks.tool && hooks.tool.longrun && hooks.tool.longrun_verify, "built plugin still exposes both tools");
});

// ---- v1.1.2: evidence discipline — an import is not a load; probes cannot fabricate. ----
const { spawnSync } = await import("node:child_process");
const PLUG_FILE = path.resolve(import.meta.dirname, "..", "plugin", "longrun.js").split(path.sep).join("/");
// Isolated probe children: state dir IS set, and the test context is explicitly disarmed.
// OPENCODE_CLIENT is stripped too — the harness runs inside a desktop backend whose env would
// otherwise make any inherited child process look like a host. A genuine probe is NOT a host.
const CHILD_ENV = (state) => { const e = { ...process.env, LONGRUN_STATE_DIR: state }; delete e.LONGRUN_TEST; delete e.NODE_TEST_CONTEXT; delete e.OPENCODE_CLIENT; return e; }
test("importing the plugin writes NO live evidence (import != load)", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "noev-"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import("file://${PLUG_FILE}");`], { env: CHILD_ENV(state) });
  assert.equal(r.status, 0, "child import ran: " + r.stderr);
  assert.deepEqual(fs.readdirSync(state), [], "module import must not create any state");
});
test("a plain-node probe calling server() creates no live evidence (isolated state)", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "noev2-"));
  const code = `const m = await import("file://${PLUG_FILE}"); await m.default.server({ client: null });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: CHILD_ENV(state) });
  assert.equal(r.status, 0, "child factory ran: " + r.stderr);
  assert.deepEqual(fs.readdirSync(state), [], "probe factory call must write nothing, even with state dir set");
});

function setupRun({ checkCatalogue, status = "IMPLEMENTING", extra = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrproj-"));
  fs.writeFileSync(path.join(dir, "a.js"), "x");
  const id = C.projectIdentity(dir);
  const key = C.stateKey(id, "default");
  const store = new C.Store(STATE);
  const run = {
    status,
    originalRequest: "do the thing",
    contract: { criteria: [{ id: "c1", required: true, checks: ["pass"], status: "FAIL", weight: 1 }], gates: [], lossTarget: 0 },
    state: {}, budget: C.defaultBudget(),
  };
  store.writeJSON(key, "run.json", run);
  const runs = readRuns();
  runs["sess-1"] = { runKey: key, directory: dir, checkCatalogue, ...extra };
  writeRuns(runs);
  return { dir, key, store };
}
const CTX = (dir) => ({ sessionID: "sess-1", agent: "longrun", directory: dir, worktree: dir });

// 6 + 4: verification must come from the declared catalogue; no arbitrary shell bypass.
test("longrun_verify refuses an undeclared check (no shell bypass)", async () => {
  const { dir } = setupRun({ checkCatalogue: { pass: { command: ["node", "-e", "process.exit(0)"], kind: "cmd" } } });
  const tools = (await F(PLUG_URL, { client: null })).tool;
  const res = JSON.parse(await tools.longrun_verify.execute({ checkId: "rm -rf /" }, CTX(dir)));
  assert.equal(res.error, "undeclared_check", "arbitrary command rejected");
});

test("longrun_verify runs a declared check and records PASS", async () => {
  const { dir } = setupRun({ checkCatalogue: { pass: { command: ["node", "-e", "process.exit(0)"], kind: "cmd" } } });
  const tools = (await F(PLUG_URL, { client: null })).tool;
  const res = JSON.parse(await tools.longrun_verify.execute({ checkId: "pass" }, CTX(dir)));
  assert.equal(res.status, "PASS");
});
test("longrun_verify reports FAIL from exit code, not console text", async () => {
  const { dir } = setupRun({ checkCatalogue: { fail: { command: ["node", "-e", "console.log('ALL PASSED');process.exit(1)"], kind: "cmd" } } });
  const tools = (await F(PLUG_URL, { client: null })).tool;
  const res = JSON.parse(await tools.longrun_verify.execute({ checkId: "fail" }, CTX(dir)));
  assert.equal(res.status, "FAIL", "optimistic text ignored");
});

// 9: compaction supplements (does not replace) the default prompt with a bounded packet.
test("compacting hook appends a recovery packet to context", async () => {
  const { dir } = setupRun({ checkCatalogue: {} });
  const hooks = await F(PLUG_URL, { client: null });
  const out = { context: [], prompt: undefined };
  await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, out);
  assert.ok(out.context.some((c) => c.includes("Long-run recovery")), "packet appended");
  assert.equal(out.prompt, undefined, "default compaction prompt NOT replaced");
});
test("compacting hook is a no-op for inactive sessions", async () => {
  const hooks = await F(PLUG_URL, { client: null });
  const out = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "nope" }, out);
  assert.equal(out.context.length, 0, "inactive -> nothing");
});

// 8 + 10: paused/cancelled session suppresses synthetic auto-continue.
test("autocontinue requires an authorized legacy rebind and stays disabled for a paused run", async () => {
  const { dir } = setupRun({ checkCatalogue: {} });
  const hooks = await F(PLUG_URL, { client: null });
  const legacy = { enabled: true };
  await hooks["experimental.compaction.autocontinue"]({ sessionID: "sess-1" }, legacy);
  assert.equal(legacy.enabled, false, "a legacy routing flag alone cannot authorize continuation");
  assert.equal(JSON.parse(await hooks.tool.longrun.execute({ action: "resume" }, CTX(dir))).resumed, true);
  const a = { enabled: true };
  await hooks["experimental.compaction.autocontinue"]({ sessionID: "sess-1" }, a);
  assert.equal(a.enabled, true, "active run keeps default");
  // now pause it (paused is still recognised, unlike fully-disabled)
  await hooks.tool.longrun.execute({ action: "pause" }, CTX(dir));
  const b = { enabled: true };
  await hooks["experimental.compaction.autocontinue"]({ sessionID: "sess-1" }, b);
  assert.equal(b.enabled, false, "paused/cancelled suppresses auto-continue");
  // a fully-inactive session leaves the default untouched
  const c = { enabled: true };
  await hooks["experimental.compaction.autocontinue"]({ sessionID: "ghost" }, c);
  assert.equal(c.enabled, true, "inactive -> no change");
});

// 9 + 10: session.compacted flips RECOVERY_REQUIRED, not a loop, only inside a run.
test("session.compacted sets RECOVERY_REQUIRED inside a run", async () => {
  const { dir, key, store } = setupRun({ checkCatalogue: {} });
  const hooks = await F(PLUG_URL, { client: null });
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "sess-1" } } });
  assert.equal(store.readJSON(key, "run.json").status, "RECOVERY_REQUIRED");
});
test("session.compacted is a no-op for inactive sessions", async () => {
  const hooks = await F(PLUG_URL, { client: null });
  // must not throw and must not touch any state
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ghost" } } });
  assert.ok(true);
});
