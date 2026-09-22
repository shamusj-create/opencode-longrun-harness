// Shared test plumbing. NOT an OpenCode plugin entry point — it is only ever imported by
// harness/test/*. The plugin entrypoint (harness/plugin/longrun.js) deliberately exposes ONE
// export (the V1 `{ id, server }` descriptor), so anything the tests need is provided here.
// Importing this module also hard-arms LONGRUN_TEST: no test helper can ever write live
// evidence into a production state dir.
import fs from "node:fs";
import path from "node:path";
import * as C from "../src/controller.js";
process.env.LONGRUN_TEST = "1";

// Explicit independent-review fixture for positive completion tests. It neither
// creates receipts nor repairs failing gates; the controller refuses unready data.
export function approveFixtureReview(run, fingerprint = run.sourceFingerprint) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("test-only completion review");
  run.status = "PAUSED";
  const result = C.recordCompletionReview(run, { verdict: "accept", reason: "Independent harness fixture review; no product acceptance claim.",
    reviewId: `test-review-${(run.completionReviews || []).length + 1}`,
    currentFingerprint: fingerprint, expectedBasis: C.completionReviewBasis(run, fingerprint) });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return run;
}
export function approveStoredFixtureReview(store, key, fingerprint) {
  const result = store.mutate(key, run => { approveFixtureReview(run, fingerprint || C.sourceFingerprint(run.directory)); return { ok: true }; });
  if (!result.ok) throw new Error(JSON.stringify(result));
}
export function reviewProjectFixture(directory, runId) {
  approveStoredFixtureReview(new C.Store(process.env.LONGRUN_STATE_DIR), C.stateKey(C.projectIdentity(directory), runId));
}

const stateDir = () => process.env.LONGRUN_STATE_DIR;
export function readRuns() { try { return JSON.parse(fs.readFileSync(path.join(stateDir(), "runs.json"), "utf8")); } catch { return {}; } }
export function writeRuns(r) { const p = path.join(stateDir(), "runs.json"); fs.writeFileSync(p, JSON.stringify(r)); }

// Load the plugin under test and return its hooks object, driven through the V1 shape: the
// default export must be `{ id, server }` (or a bare function) with a callable server factory.
export async function F(url, ctx = { client: { app: { log: () => {} } } }) {
  const m = await import(url);
  const s = typeof m.default === "function" ? m.default : m.default && m.default.server;
  if (typeof s !== "function") throw new Error("plugin exposes no callable server factory");
  return s(ctx);
}
