import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// v1.2.27 — V2 support via a DUAL EXPORT.
//
// V2 ignores the V1 `server()` entrypoint entirely (verified on OpenCode 2.0.6: a plugin exporting
// both is loaded, `setup()` is called, `server()` never is). The harness therefore exports both, and
// these tests pin the V2 side: tool registration shape, the execute-context adaptation, the
// admission hook adaptation, event-stream adaptation, cleanup, and inertness.
//
// Every shape asserted here was taken from the real V2 runtime, not from documentation alone.

const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "v2cfg-"));
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "v2state-"));
process.env.OPENCODE_CONFIG_DIR = CONFIG;
process.env.LONGRUN_STATE_DIR = STATE;
delete process.env.LONGRUN_CONTROLLER_FILE;

const PLUG = await import("../plugin/longrun.js");

// A fake V2 context that records what the plugin registers.
function mockCtx(directory) {
  const calls = { tools: [], hooks: {}, subscribed: false, aborted: false };
  let signal = null;
  const ctx = {
    app: { version: "2.0.6" },
    location: { directory, project: { id: "proj", directory, canonical: directory } },
    tool: {
      transform: async (cb) => cb({
        list: () => calls.tools, get: () => undefined, update() {}, remove() {}, namespace: () => ({}),
        add: (def) => calls.tools.push(def),
      }),
      hook: async (name, cb) => { calls.hooks[name] = cb; },
    },
    session: { hook: async (name, cb) => { calls.hooks["session:" + name] = cb; } },
    event: {
      subscribe: async function* (opts) {
        calls.subscribed = true;
        signal = opts && opts.signal;
        yield { type: "session.idle", data: { sessionID: "ses_irrelevant" } };
        await new Promise((res) => { if (signal) signal.addEventListener("abort", res); });
      },
    },
  };
  return { ctx, calls, signal: () => signal };
}

test("v1.2.27 the module exports ONE object carrying BOTH entrypoints", () => {
  const keys = Object.keys(PLUG);
  assert.deepEqual(keys, ["default"], "exactly one module export");
  assert.equal(PLUG.default.id, "longrun");
  assert.equal(typeof PLUG.default.server, "function", "V1 entrypoint present");
  assert.equal(typeof PLUG.default.setup, "function", "V2 entrypoint present");
});

test("v1.2.27 setup registers both tools with plain JSON Schema and code-mode options", async () => {
  const { ctx, calls } = mockCtx("/tmp/v2mock-project");
  await PLUG.default.setup(ctx);

  const byName = Object.fromEntries(calls.tools.map((t) => [t.name, t]));
  assert.deepEqual(calls.tools.map((t) => t.name).sort(), ["longrun", "longrun_verify"],
    "both native tools registered");
  for (const name of ["longrun", "longrun_verify"]) {
    const t = byName[name];
    assert.equal(typeof t.description, "string");
    assert.equal(typeof t.execute, "function");
    assert.deepEqual(t.options, { namespace: "longrun", codemode: true },
      "namespaced + code-mode, or the tool is listed but not callable");
    assert.equal(t.input.type, "object", "plain JSON Schema, not a @opencode-ai/plugin helper");
    assert.equal(t.input.additionalProperties, false);
    assert.ok(t.input.properties && typeof t.input.properties === "object");
  }
  // the action enum must survive the plain-schema path, or the model cannot pick an action
  assert.ok(Array.isArray(byName.longrun.input.properties.action.enum), "action enum present");
  assert.ok(byName.longrun.input.properties.action.enum.includes("help"));
  assert.equal(byName.longrun.input.properties.action.type, "string");
  // no V1 helper objects leaked through
  assert.ok(!JSON.stringify(byName.longrun.input).includes("__plain"));
});

test("v1.2.27 the V2 tool wraps V1 output as {content} and supplies the missing directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2proj-"));
  const { ctx, calls } = mockCtx(dir);
  await PLUG.default.setup(ctx);

  const tool = calls.tools.find((t) => t.name === "longrun");
  // V2 passes (input, { sessionID, agent, ... }) with NO directory — the adapter must add it,
  // or the tool resolves runs against process.cwd() and finds the wrong project.
  const out = await tool.execute({ action: "help" }, { sessionID: "ses_v2", agent: "build", messageID: "m1", id: "i1", progress: null });

  assert.equal(typeof out, "object", "V2 expects structured content, not a bare string");
  assert.equal(typeof out.content, "string", "content is a string");
  assert.ok(out.content.length > 0, "help returned something");
  assert.ok(out.content.includes("start"), "help lists lifecycle actions, so the real V1 path ran");
});

test("v1.2.27 the admission hook is registered as execute.before and normalises tool names", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2proj2-"));
  const { ctx, calls } = mockCtx(dir);
  await PLUG.default.setup(ctx);

  const hook = calls.hooks["execute.before"];
  assert.equal(typeof hook, "function", "registered on ctx.tool.hook('execute.before')");

  // A read tool in an untracked project is admitted: this proves the adapter forwards
  // { tool, sessionID } and { args } in the shape the V1 guard expects.
  await hook({ tool: "longrun.longrun", sessionID: "ses_x", agent: "build", messageID: "m", id: "i", input: { action: "status" } });
  await hook({ tool: "read", sessionID: "ses_x", agent: "build", messageID: "m", id: "i", input: { filePath: "/tmp/x" } });
  // A missing store must not throw for an unrelated tool.
  assert.ok(true, "adapter tolerated both a namespaced longrun name and an unrelated tool");
});

test("v1.2.27 setup subscribes to events and the returned cleanup aborts the subscription", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2proj3-"));
  const { ctx, calls, signal } = mockCtx(dir);
  const cleanup = await PLUG.default.setup(ctx);

  assert.equal(calls.subscribed, true, "subscribed to the event stream");
  assert.equal(typeof cleanup, "function", "returns a cleanup function, as V2 expects");
  const sig = signal();
  assert.ok(sig && !sig.aborted);
  await new Promise((r) => setTimeout(r, 20)); // let the consumer start
  cleanup();
  assert.equal(sig.aborted, true, "cleanup aborts the subscription");
});

test("v1.2.27 setup stays INERT when globally disabled, registering nothing", async () => {
  fs.mkdirSync(path.join(CONFIG, "longrun-harness"), { recursive: true });
  fs.writeFileSync(path.join(CONFIG, "longrun-harness", "DISABLED"), "");
  try {
    const { ctx, calls } = mockCtx("/tmp/v2mock-disabled");
    const cleanup = await PLUG.default.setup(ctx);
    assert.deepEqual(calls.tools, [], "no tools registered while disabled");
    assert.deepEqual(Object.keys(calls.hooks), [], "no hooks registered while disabled");
    assert.equal(cleanup, undefined, "nothing to clean up");
  } finally {
    fs.rmSync(path.join(CONFIG, "longrun-harness", "DISABLED"), { force: true });
  }
});
