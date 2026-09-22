import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as C from "../src/controller.js";
process.env.LONGRUN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "recstate-"));
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname, "..", "src", "controller.js");
// The plugin entrypoint now default-exports exactly one value: the V1 async factory.
const PLUG = await import("../plugin/longrun.js");
const { F, readRuns, writeRuns } = await import("./helper.mjs");
const PLUG_URL = "../plugin/longrun.js";

function seedRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recproj-"));
  fs.writeFileSync(path.join(dir, "a.js"), "x");
  const id = C.projectIdentity(dir);
  const key = C.stateKey(id, "default");
  const store = new C.Store(process.env.LONGRUN_STATE_DIR);
  const run = {
    status: "IMPLEMENTING",
    originalRequest: "Build task-list feature",
    contractHash: "contract-hash-abc", evaluatorHash: "eval-hash-def",
    contract: { criteria: [
      { id: "c1", required: true, checks: ["accept"], status: "PASS" },
      { id: "c2", required: true, checks: ["accept"], status: "FAIL" },
    ], gates: [], lossTarget: 0 },
    state: {
      iterations: 3, noProgressStreak: 1, sameFailureStreak: 1,
      currentSlice: "c2-persistence", nextAction: "fix persistence then re-run accept",
      failedHypotheses: ["assumed in-memory store was enough"],
      budgets: { autoDispatches: 2 },
    },
  };
  store.writeJSON(key, "run.json", run);
  const runs = readRuns();
  runs["sess-1"] = { runKey: key, directory: dir, checkCatalogue: {} };
  writeRuns(runs);
  return { dir, key, store };
}
const CTX = (dir) => ({ sessionID: "sess-1", agent: "longrun", directory: dir, worktree: dir });

// SIMULATED: compaction event flips state to recovery; NOT a real summarize/compaction.
test("SIMULATED compaction -> recovery: state + budgets + contract survive", async () => {
  const { dir, key, store } = seedRun();
  const hooks = await F(PLUG_URL);
  const before = store.readJSON(key, "run.json");

  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "sess-1" } } });
  const afterCompact = store.readJSON(key, "run.json");
  assert.equal(afterCompact.status, "RECOVERY_REQUIRED", "compaction requires reconciliation before edits");

  // reconcile: resume-context must reproduce contract IDs, budgets, failed hypotheses
  const packet = await hooks.tool.longrun.execute({ action: "resume-context" }, CTX(dir));
  assert.match(packet, /REMAINING CRITERIA: c2/, "remaining criterion IDs survive");
  assert.match(packet, /contract-hash-abc/, "contract hash survives");
  assert.match(packet, /assumed in-memory store/, "unsuccessful approaches survive");
  assert.match(packet, /fix persistence then re-run accept/, "next action survives");
  assert.match(packet, /iters=3/, "budget counters persist across compaction");

  // cancellation stays authoritative through recovery
  const paused = structuredClone(before); paused.status = "PAUSED"; store.writeJSON(key, "run.json", paused);
  const hooks2 = await F(PLUG_URL, { client: {} });
  const out = { enabled: true };
  const runs = readRuns(); runs["sess-1"].paused = true; writeRuns(runs);
  await hooks2["experimental.compaction.autocontinue"]({ sessionID: "sess-1" }, out);
  assert.equal(out.enabled, false, "a paused/cancelled run is not auto-resumed after compaction");
});
