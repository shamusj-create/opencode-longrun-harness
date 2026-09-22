import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as M from "../src/memory.mjs";

const mk = (...p) => { const d = path.join(...p); fs.mkdirSync(d, { recursive: true }); return d; };
const tmp = (p = "mem") => fs.mkdtempSync(path.join(os.tmpdir(), p + "-"));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ---- tiny repo -> root only (do not create unnecessary hierarchy) --------------------------
test("tiny repo: init-deep creates ONLY the root AGENTS.md", () => {
  const d = tmp();
  write(path.join(d, "main.cjs"), "module.exports=1;");
  const sel = M.selectTargets(M.scanTree(d));
  assert.deepEqual(sel.filter((t) => t.selected).map((t) => t.rel), [""], "only root selected");
  const r = M.initDeep(d, { harnessVersion: "1.2.0" });
  assert.deepEqual(r.created.map((c) => c.rel).sort(), [""], "only root written");
  assert.ok(fs.existsSync(path.join(d, "AGENTS.md")));
});

// ---- monorepo -> appropriate nested memory --------------------------------------------------
test("monorepo: high-complexity package gets a child AGENTS.md", () => {
  const d = tmp("mono");
  for (let i = 0; i < 14; i++) write(path.join(d, "packages", "core", "f" + i + ".ts"), "export const v" + i + " = 1;\n// NEVER inline secrets\n");
  write(path.join(d, "packages", "core", "index.ts"), "export * from './f0';\n");
  write(path.join(d, "packages", "core", "core.test.ts"), "//test\n");
  write(path.join(d, "packages", "core", "package.json"), JSON.stringify({ name: "core" }));
  write(path.join(d, "package.json"), JSON.stringify({ name: "mono", scripts: { test: "node --test" } }));
  const created = M.initDeep(d, {}).created.map((c) => c.rel).sort();
  assert.ok(created.includes(""), "root present");
  assert.ok(created.includes("packages/core"), "packages/core got child memory");
});

// ---- child must NOT merely repeat parent ----------------------------------------------------
test("child memory does not repeat parent content and contains no generic advice", () => {
  const d = tmp("dedup");
  // root has a broad structure section; child should not echo it verbatim, no generic advice.
  write(path.join(d, "AGENTS.md"), "## STRUCTURE\n- top: layout of everything at the repo root for overview purposes\n");
  for (let i = 0; i < 8; i++) write(path.join(d, "svc", "f" + i + ".ts"), "export const q = 1;");
  write(path.join(d, "svc", "package.json"), JSON.stringify({ name: "svc" }));
  const r = M.initDeep(d, { regenerate: true }); // regenerate so the child gets generated
  const childPath = path.join(d, "svc", "AGENTS.md");
  const child = fs.readFileSync(childPath, "utf8");
  assert.ok(!/generic|write clean code|follow best practices|keep it simple/i.test(child), "no generic advice in child");
  assert.ok(!child.includes("layout of everything at the repo root for overview purposes"), "child does not copy the parent's overview line");
  assert.ok(r.created.some((c) => c.rel === "svc"));
});

// ---- high selected, low skipped -------------------------------------------------------------
test("high-complexity dir selected; low-complexity dir skipped (parent sufficient)", () => {
  const d = tmp("tier");
  for (let i = 0; i < 20; i++) write(path.join(d, "big", "f" + i + ".ts"), "export const v=1;\n// ALWAYS validate\n");
  write(path.join(d, "big", "package.json"), JSON.stringify({ name: "big" }));
  write(path.join(d, "big", "index.ts"), "//entry");
  write(path.join(d, "big", "a.test.ts"), "//t");
  write(path.join(d, "tiny", "single.ts"), "x=1;");
  const sel = Object.fromEntries(M.selectTargets(M.scanTree(d)).filter((t) => t.rel && !t.rel.includes("/")).map((t) => [t.rel, { s: t.selected, tier: t.tier }]));
  assert.equal(sel.big.s, true, "big selected"); assert.equal(sel.big.tier, "high");
  assert.equal(sel.tiny.s, false, "tiny skipped"); assert.equal(sel.tiny.tier, "low");
});

// ---- existing human AGENTS.md preserved -----------------------------------------------------
test("existing human-written AGENTS.md (no managed markers) is preserved, not overwritten", () => {
  const d = tmp("preserve");
  for (let i = 0; i < 12; i++) write(path.join(d, "a" + i + ".ts"), "export const v=1;");
  write(path.join(d, "AGENTS.md"), "# My hand-written notes\nIMPORTANT: never edit generated files.\n");
  const r = M.initDeep(d, {});
  const content = fs.readFileSync(path.join(d, "AGENTS.md"), "utf8");
  assert.match(content, /My hand-written notes/, "human content preserved");
  assert.ok(r.preserved.some((p) => p.rel === ""), "reported as preserved");
  assert.ok(!r.created.some((c) => c.rel === ""), "not recreated");
});

// ---- managed-section refresh (incremental, not wholesale) ------------------------------------
test("incremental refresh updates the managed block but keeps human prose outside it", () => {
  const d = tmp("refresh");
  for (let i = 0; i < 12; i++) write(path.join(d, "a" + i + ".ts"), "export const v=1;");
  write(path.join(d, "AGENTS.md"), "Human preamble: talk to alice before changing.\n" + M.MANAGED_BEGIN + "\nstale content\n" + M.MANAGED_END + "\nHuman epilogue: run make fmt.\n");
  const r = M.initDeep(d, {});
  const content = fs.readFileSync(path.join(d, "AGENTS.md"), "utf8");
  assert.match(content, /talk to alice before changing/, "human preamble kept");
  assert.match(content, /run make fmt/, "human epilogue kept");
  assert.ok(!content.includes("stale content"), "stale managed block replaced");
  assert.equal(r.updated.find((c) => c.rel === "").action, "updated");
});

// ---- staleness: ordinary source edit does not stale all memory ------------------------------
test("ordinary body edit does not mark all memory stale", () => {
  const d = tmp("fresh");
  for (let i = 0; i < 10; i++) write(path.join(d, "src", "f" + i + ".ts"), "export const v=1;");
  write(path.join(d, "index.ts"), "export * from './src/f0';");
  write(path.join(d, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test" } }));
  M.initDeep(d, {});
  const idx = M.readMemoryIndex(d);
  fs.writeFileSync(path.join(d, "src", "f3.ts"), "export const v=changed-but-same-shape;");
  fs.writeFileSync(path.join(d, "src", "f4.ts"), "export const v=changed-too;");
  const s = M.assessStaleness(d, idx);
  assert.ok(s.status === "FRESH" || s.status === "POSSIBLY_STALE", "not full STALE: " + JSON.stringify(s));
  assert.notEqual(s.status, "STALE", "a body edit is not a structural change");
});

// ---- staleness: structural changes ARE detected ---------------------------------------------
test("structural change (new package + manifest edit) is reported STALE with reasons", () => {
  const d = tmp("stale");
  for (let i = 0; i < 10; i++) write(path.join(d, "packages", "a", "f" + i + ".ts"), "export const v=1;");
  write(path.join(d, "packages", "a", "package.json"), JSON.stringify({ name: "a" }));
  write(path.join(d, "package.json"), JSON.stringify({ name: "root", scripts: { test: "node --test" } }));
  M.initDeep(d, {});
  const idx = M.readMemoryIndex(d);
  // add a new package + change root manifest (add a build command)
  for (let i = 0; i < 8; i++) write(path.join(d, "packages", "b", "g" + i + ".ts"), "export const v=1;");
  write(path.join(d, "packages", "b", "package.json"), JSON.stringify({ name: "b" }));
  write(path.join(d, "package.json"), JSON.stringify({ name: "root", scripts: { test: "node --test", build: "tsc" } }));
  const s = M.assessStaleness(d, idx);
  assert.equal(s.status, "STALE");
  assert.ok(s.reasons.length >= 1, "reasons present");
});

// ---- dry-run does not modify files ----------------------------------------------------------
test("dry-run lists proposed locations but writes nothing", () => {
  const d = tmp("dry");
  for (let i = 0; i < 12; i++) write(path.join(d, "pkg", "f" + i + ".ts"), "export const v=1;");
  write(path.join(d, "pkg", "package.json"), JSON.stringify({ name: "pkg" }));
  const before = fs.readdirSync(d, { recursive: true }).slice().sort();
  const r = M.initDeep(d, { dryRun: true });
  const after = fs.readdirSync(d, { recursive: true }).slice().sort();
  assert.deepEqual(after, before, "no files created/removed on dry-run");
  assert.ok(!fs.existsSync(path.join(d, M.MEMORY_PATH)), "no memory index written on dry-run");
  assert.ok(r.willWrite.length > 0, "dry-run still reports proposed locations");
});

// ---- memory index carries staleness inputs --------------------------------------------------
test("memory-index.json records schema version, commit, node scores + manifest fingerprints", () => {
  const d = tmp("idx");
  for (let i = 0; i < 12; i++) write(path.join(d, "pkg", "f" + i + ".ts"), "export const v=1;");
  write(path.join(d, "pkg", "package.json"), JSON.stringify({ name: "pkg" }));
  const r = M.initDeep(d, {});
  const idx = M.readMemoryIndex(d);
  assert.equal(idx.schemaVersion, 1);
  assert.ok(typeof idx.structuralKey === "string" && idx.structuralKey.length === 64);
  assert.ok(idx.nodes.some((n) => n.selected && n.signature.manifests && Object.keys(n.signature.manifests).length), "manifest fingerprint recorded for a package node");
  assert.ok(idx.nodes.every((n) => typeof n.tier === "string"), "tiers recorded (score/reason kept in index, not prose)");
});