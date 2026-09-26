import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// v1.2.23 — loading the plugin STRAIGHT FROM THE PACKAGE (the Desktop Plugins pane, or
// `opencode plugin opencode-longrun-harness -g`) must produce a WORKING plugin.
//
// The directory-convention installer bakes an absolute controller URL into the copy it writes to
// <config>/plugins/longrun.js. Nothing bakes anything when OpenCode resolves the npm package, so the
// only candidate left is the sibling ./_controller.js — which must therefore ship inside the package.
// Without it the controller never resolves and the plugin goes INERT: it registers zero tools and
// logs one warning. Installed, enabled, silently doing nothing.
//
// These tests deliberately DO NOT set LONGRUN_CONTROLLER_FILE. That override is exactly what masked
// the gap: plugin.test.mjs sets it process-wide, so the sibling candidate was never exercised.
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "lr-pkg-cfg-"));
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "lr-pkg-state-"));
process.env.OPENCODE_CONFIG_DIR = CONFIG; // never consult the operator's real config dir
process.env.LONGRUN_STATE_DIR = STATE;
process.env.OPENCODE_CLIENT = "1"; // behave as the OpenCode host process
delete process.env.LONGRUN_CONTROLLER_FILE; // no override: the package must stand on its own

const SRC = path.resolve(import.meta.dirname, "..", "plugin", "longrun.js");
const SHIM = path.resolve(import.meta.dirname, "..", "plugin", "_controller.js");

async function loadPlugin(file) {
  const logs = [];
  const mod = await import("file://" + file);
  const hooks = await mod.default.server({ client: { app: { log: (a) => logs.push(a?.body?.message || "") } } });
  return { hooks, logs, tools: hooks?.tool ? Object.keys(hooks.tool) : [] };
}

test("v1.2.23 the sibling controller shim ships and resolves the packaged controller", async () => {
  assert.ok(fs.existsSync(SHIM), "harness/plugin/_controller.js must ship, or packaged installs go inert");
  const shim = await import("file://" + SHIM);
  const C = await import("../src/controller.js");
  assert.ok(Array.isArray(shim.STATES) && shim.STATES.length > 0, "shim re-exports the controller STATES");
  assert.deepEqual(shim.STATES, C.STATES, "shim exposes the same lifecycle states as the controller");
});

test("v1.2.23 package layout resolves and registers BOTH native tools", async () => {
  const { tools, logs } = await loadPlugin(SRC);
  assert.deepEqual(tools.sort(), ["longrun", "longrun_verify"], "packaged plugin exposes the native tool surface");
  assert.ok(logs.includes("loaded"), `expected a 'loaded' log, got ${JSON.stringify(logs)}`);
  assert.ok(!logs.some((m) => /inert/i.test(m)), "plugin must not report itself inert");
});

test("v1.2.23 NEGATIVE CONTROL: without the sibling shim the plugin is inert", async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "lr-bare-"));
  fs.copyFileSync(SRC, path.join(bare, "longrun.js")); // the entry alone — what published 1.2.22 shipped
  const { tools, logs } = await loadPlugin(path.join(bare, "longrun.js"));
  assert.deepEqual(tools, [], "no resolvable controller => zero tools");
  assert.ok(logs.some((m) => /inert/i.test(m)), "and it reports inert rather than pretending to work");
});

test("v1.2.23 the shim is a plain re-export, never a plugin entry", async () => {
  const shim = await import("file://" + SHIM);
  assert.equal(typeof shim.default, "undefined", "no default export: the desktop loader only ever loads the package main");
});

test("v1.2.23 the installer still bakes plugins/longrun.js and never copies the shim into plugins/", async () => {
  const { install } = await import("../src/install.mjs");
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "lr-inst-"));
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  install({ configDir: cfg });
  const dir = fs.readdirSync(path.join(cfg, "plugins"));
  assert.deepEqual(dir, ["longrun.js"], "a stray _controller.js in plugins/ would be loaded as a plugin and throw");
  const built = fs.readFileSync(path.join(cfg, "plugins", "longrun.js"), "utf8");
  assert.ok(!built.includes("__LONGRUN_CONTROLLER_URL__"), "installer must substitute the placeholder");
  const BUILT = await import("file://" + path.join(cfg, "plugins", "longrun.js"));
  const hooks = await BUILT.default.server({ client: { app: { log: () => {} } } });
  assert.ok(hooks.tool?.longrun && hooks.tool?.longrun_verify, "directory-convention install still works");
});
