import { test } from "node:test";
import assert from "node:assert/strict";
import * as EV from "../src/evidence.mjs";

// ---- weak evidence cannot satisfy a stronger required class --------------------------------
test("weak UNIT evidence cannot satisfy a BROWSER-required criterion", () => {
  const c = { evidenceClass: "BROWSER" };
  const r = EV.classSatisfies("UNIT", c);
  assert.equal(r.satisfied, false);
  assert.match(r.kind, /WEAK_EVIDENCE|WRONG_CLASS/);
});
test("strong BROWSER evidence satisfies a BROWSER-required criterion", () => {
  const r = EV.classSatisfies("BROWSER", { evidenceClass: "BROWSER" });
  assert.equal(r.satisfied, true, r.note);
});

// ---- a visual criterion cannot pass from mesh/object existence ----------------------------
test("object-existence / mesh / canvas / DOM proxies never satisfy a VISUAL criterion", () => {
  const visual = { visual: true };
  for (const proxy of ["object_exists", "mesh_count", "canvas_nonblank", "dom_exists"]) {
    const r = EV.classSatisfies(proxy, visual);
    assert.equal(r.satisfied, false, `${proxy} must not satisfy visual: ${JSON.stringify(r)}`);
    assert.equal(r.kind, "PROXY_INSUFFICIENT");
  }
});
test("a unit-level STATIC/UNIT pass also fails a VISUAL criterion (needs render class)", () => {
  assert.equal(EV.classSatisfies("UNIT", { visual: true }).satisfied, false);
  assert.equal(EV.classSatisfies("BROWSER", { visual: true }).satisfied, true);
});

// ---- a non-visual unit criterion does NOT require vision -----------------------------------
test("non-visual UNIT criterion is satisfied by a UNIT receipt (no vision forced)", () => {
  const c = { evidenceClass: "UNIT" };
  assert.equal(EV.classSatisfies("UNIT", c).satisfied, true);
  // an over-strong VISION receipt is not WRONG for a UNIT criterion (no forced ceiling), just not
  // the matched class; a UNIT one matches.
  assert.equal(EV.classSatisfies("STATIC", c).satisfied, false);
});

// ---- evidence gap stays separate from a plain test failure --------------------------------
test("evidenceGap reports missing required classes, not the exit status", () => {
  const c = { evidenceClass: "BROWSER", checks: ["ui"] };
  const gapOnly = EV.evidenceGap(c, [{ status: "PASS", checkId: "ui", evidenceClass: "UNIT" }]);
  assert.equal(gapOnly.gap, true, "a UNIT pass leaves a BROWSER gap open");
  assert.deepEqual(gapOnly.missing, ["BROWSER"]);
  const satisfied = EV.evidenceGap(c, [{ status: "PASS", checkId: "ui", evidenceClass: "BROWSER" }]);
  assert.equal(satisfied.gap, false, "browser evidence closes the gap");
});

// ---- rank ordering --------------------------------------------------------------------------
test("evidence classes are ordered weakest -> strongest", () => {
  assert.ok(EV.rank("STATIC") < EV.rank("UNIT"));
  assert.ok(EV.rank("UNIT") < EV.rank("INTEGRATION"));
  assert.ok(EV.rank("INTEGRATION") < EV.rank("SYSTEM"));
  assert.ok(EV.rank("SYSTEM") < EV.rank("BROWSER"));
  assert.ok(EV.rank("BROWSER") < EV.rank("VISION"));
});