// Long-run Harness — hierarchical project memory (structural memory plane A).
// Dependency-free (node builtins only). Deterministic. Copied verbatim into the built install
// next to controller.js and imported by it. Produces AGENTS.md + .longrun/memory-index.json and
// assesses staleness. It never writes transient run state (that is the episodic plane).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_DEPTH = 3;

export const CODE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".go", ".rs", ".py", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".rb", ".php", ".swift", ".scala", ".ex", ".exs", ".zig", ".sql",
]);
export const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "Cargo.toml", "go.mod", "go.sum", "pom.xml", "build.gradle", "build.gradle.kts",
  "pyproject.toml", "setup.py", "requirements.txt", "Makefile", "CMakeLists.txt",
]);
// directories that never get their own memory node and are skipped during discovery
export const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "target", "build", "dist", "out",
  "bin", "__pycache__", ".venv", "venv", ".next", ".nuxt", "coverage", ".longrun",
  ".cache", ".turbo", ".parcel-cache", ".idea", ".vscode", "tmp", "fixtures", "__tests__",
]);
const TEST_HINT_RE = /(^|[-_.])(test|spec|tests|specs)([-_.]|$)/i;
const ENTRY_RE = /(^|\/)(index|main|mod|lib|server|app|application|cli|entry|router)(\.[a-z]+)?$/i;

// Generic advice that must NEVER appear in generated memory (dedup/trim strips it).
export const GENERIC_ADVICE = [
  "write clean code", "follow best practices", "write tests", "keep it simple",
  "be careful", "use common sense", "read the documentation", "document your code",
  "single source of truth", "don't repeat yourself", "solid principles",
];

export const MANAGED_BEGIN = "<!-- BEGIN longrun:managed -->";
export const MANAGED_END = "<!-- END longrun:managed -->";

function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function relSlash(root, p) { return path.relative(root, p).split(path.sep).join("/"); }
function readIfExists(p, max = 256 * 1024) { try { const b = fs.readFileSync(p); return b.length > max ? b.subarray(0, max) : b; } catch { return null; } }
function isCode(f) { return CODE_EXT.has(path.extname(f).toLowerCase()); }
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
function listDirs(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).sort(byName); } catch { return []; } }
function listFiles(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).sort(byName); } catch { return []; } }

export function gitHeadAt(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r && r.status === 0 ? r.stdout.trim() : null;
}

// ---- Complexity scoring model (documented; max 100) ---------------------------------------
// file count (HIGH) 1/file cap25 | subdirs 2/subdir cap12 | code ratio 15*ratio
// package boundary 15 | entry points 8 | exports 1/export cap10 | local rules 10 | tests 5 | centrality 5
// tier: >=45 HIGH, 20..44 MEDIUM, <20 LOW
export function scoreDir(info) {
  const reasons = [];
  let score = 0;
  const fp = Math.min(25, info.fileCount); score += fp;
  if (info.fileCount >= 8) reasons.push(`file_count=${info.fileCount}(+${fp})`);
  const sp = Math.min(12, info.subdirCount * 2); score += sp;
  if (info.subdirCount >= 4) reasons.push(`subdir_count=${info.subdirCount}(+${sp})`);
  const cr = Math.round(15 * (info.codeRatio || 0)); score += cr;
  if (cr > 0) reasons.push(`code_ratio=${(info.codeRatio || 0).toFixed(2)}(+${cr})`);
  if (info.hasManifest) { score += 15; reasons.push("package_boundary(+15)"); }
  if (info.entryPoints.length) { score += 8; reasons.push(`entry_points=${info.entryPoints.length}(+8)`); }
  const xp = Math.min(10, info.exportCount); score += xp;
  if (info.exportCount >= 3) reasons.push(`exports=${info.exportCount}(+${xp})`);
  if (info.ruleMarkers.length) { score += 10; reasons.push(`local_rules=${info.ruleMarkers.length}(+10)`); }
  if (info.testFileCount >= 2) { score += 5; reasons.push(`tests=${info.testFileCount}(+5)`); }
  if (info.centrality >= 2) { score += 5; reasons.push(`centrality=${info.centrality}(+5)`); }
  const tier = score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  return { score, tier, reasons };
}

function computeCentrality(root, dirRel, budget) {
  if (!dirRel) return 0;
  const base = path.posix.basename(dirRel);
  let hits = 0;
  const stack = [root];
  let files = budget;
  const re = new RegExp(`from ["'][^"']*${base}/`, "i");
  while (stack.length && files-- > 0) {
    const d = stack.pop();
    for (const it of listFiles(d)) {
      if (!isCode(it.name)) continue;
      const buf = readIfExists(path.join(d, it.name), 64 * 1024);
      if (buf && re.test(buf.toString("utf8"))) hits++;
      if (hits > 12) return hits;
    }
    for (const sd of listDirs(d)) { if (!SKIP_DIRS.has(sd.name)) stack.push(path.join(d, sd.name)); }
  }
  return hits;
}

// Inspect ONE directory (non-recursive beyond listing its immediate children).
export function scanDir(root, absDir, opts = {}) {
  const dirRel = relSlash(root, absDir);
  // Generated memory must not change its own counts/selection on the next refresh.
  const files = listFiles(absDir).filter(f => f.name !== "AGENTS.md");
  const dirs = listDirs(absDir);
  const subdirNames = dirs.map((d) => d.name).filter((n) => !SKIP_DIRS.has(n));
  const fileNames = files.map((f) => f.name);
  let codeCount = 0;
  let exportCount = 0;
  let testFileCount = 0;
  const ruleMarkers = new Set();
  const budget = opts.fileBudget || 200;
  let inspected = 0;
  for (const it of files) {
    if (!isCode(it.name)) continue;
    codeCount++;
    if (TEST_HINT_RE.test(it.name)) testFileCount++;
    if (inspected++ >= budget) continue;
    const buf = readIfExists(path.join(absDir, it.name), 64 * 1024);
    if (!buf) continue;
    const txt = buf.toString("utf8");
    const ex = txt.match(/^\s*export\s/gm);
    if (ex) exportCount += ex.length;
    for (const [n, line] of txt.split("\n").entries()) {
      if (!/\b(DO NOT|NEVER|ALWAYS|DEPRECATED|FIXME|HACK|XXX)\b/.test(line)) continue;
      // Retain the subject and source location, not only the imperative fragment.
      // These are excerpts to inspect, not independently verified project-wide rules.
      const excerpt = line.trim();
      ruleMarkers.add(`Source excerpt (${it.name}:${n + 1}; inspect in context): ${excerpt.slice(0, 300)}${excerpt.length > 300 ? " [excerpt truncated]" : ""}`);
    }
  }
  const entryPoints = fileNames.filter((f) => ENTRY_RE.test(f));
  const hasManifest = fileNames.some((f) => MANIFEST_NAMES.has(f)) || fileNames.includes("README.md");
  const total = fileNames.length;
  const codeRatio = total ? Math.min(1, codeCount / total) : 0;
  return {
    dir: absDir, rel: dirRel, depth: dirRel ? dirRel.split("/").length : 0,
    fileCount: total, codeCount, subdirCount: subdirNames.length, subdirs: subdirNames,
    codeRatio, entryPoints, exportCount, testFileCount,
    ruleMarkers: [...ruleMarkers],
    hasManifest,
    manifestFiles: fileNames.filter((f) => MANIFEST_NAMES.has(f)),
    fileNames,
    centrality: computeCentrality(root, dirRel, opts.centralityBudget || 120),
  };
}

// Walk up to maxDepth collecting dir infos (bounded total dirs to keep inference cost low).
export function scanTree(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const dirBudget = opts.dirBudget || 80;
  const infos = [];
  const stack = [root];
  let budget = dirBudget;
  while (stack.length && budget-- > 0) {
    const d = stack.pop();
    const relp = relSlash(root, d);
    const depth = relp ? relp.split("/").length : 0;
    if (depth > maxDepth) continue;
    infos.push(scanDir(root, d, opts));
    for (const sd of listDirs(d)) {
      if (SKIP_DIRS.has(sd.name)) continue;
      stack.push(path.join(d, sd.name));
    }
  }
  infos.sort((a, b) => a.rel.localeCompare(b.rel));
  return infos;
}

// ---- Selection: which directories receive a (nested) AGENTS.md ---------------------------
export function isDistinctDomain(info) {
  if (info.hasManifest) return true;
  if (info.depth === 1 && info.testFileCount >= 1 && info.entryPoints.length >= 1) return true;
  return false;
}

export function selectTargets(infos, opts = {}) {
  const out = [];
  for (const info of infos) {
    const { score, tier, reasons } = scoreDir(info);
    const node = { rel: info.rel, dir: info.dir, depth: info.depth, score, tier, reasons };
    if (info.rel === "") { node.selected = true; node.reason = "root always receives AGENTS.md"; out.push(node); continue; }
    if (tier === "high") { node.selected = true; node.reason = "high complexity"; }
    else if (tier === "medium" && isDistinctDomain(info)) { node.selected = true; node.reason = "medium + distinct domain (own boundary/tests)"; }
    else if (tier === "medium") { node.selected = false; node.reason = "medium but not a distinct domain -> parent guidance sufficient"; }
    else { node.selected = false; node.reason = "low complexity -> parent guidance sufficient"; }
    out.push(node);
  }
  return out;
}

// ---- AGENTS.md generation (root + nested) -------------------------------------------------
function section(title, lines) {
  const body = lines.filter((l) => l && String(l).trim().length);
  if (!body.length) return "";
  return `## ${title}\n${body.map((l) => `- ${l}`).join("\n")}\n`;
}
function isGeneric(line) {
  const l = line.toLowerCase();
  return GENERIC_ADVICE.some((g) => l.includes(g)) || l.trim().length < 6;
}
function uniqueLines(arr) { const seen = new Set(); const out = []; for (const x of arr) { const k = x.trim().toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); out.push(x.trim()); } return out; }
function countCode(byRel, subdir) { let n = 0; for (const [rel, info] of byRel) if (rel.startsWith(subdir + "/") || rel === subdir) n += info.codeCount; return n; }

export function stripParentDuplicates(childLines, parentLines) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const parentSet = new Set(parentLines.map(norm));
  return childLines.filter((l) => !parentSet.has(norm(l)) && !isGeneric(l));
}

export function wrapManaged(body) { return `${MANAGED_BEGIN}\n${body}${MANAGED_END}\n`; }

export function buildRootMemory(info, ctx) {
  const lines = [];
  lines.push(`# Project Memory (${ctx.harnessVersion})`);
  lines.push(section("OVERVIEW", [
    ctx.overview,
    info.entryPoints.length ? `Entry points: ${info.entryPoints.join(", ")}` : null,
    `Top-level modules: ${info.subdirs.join(", ") || "(flat)"}`,
  ]));
  lines.push(section("STRUCTURE", info.subdirs.map((d) => `${d}/ — inspect AGENTS.md there if present`)));
  lines.push(section("WHERE TO LOOK", ctx.whereToLook));
  lines.push(section("CODE MAP", ctx.codeMap));
  lines.push(section("PROJECT INVARIANTS", ctx.invariants));
  lines.push(section("ANTI-PATTERNS", ctx.antiPatterns));
  lines.push(section("COMMANDS", ctx.commands));
  lines.push(section("VERIFICATION", ctx.verification));
  lines.push(section("MEMORY CHILDREN", info.subdirs.filter((d) => ctx.childDirs && ctx.childDirs.includes(d))));
  return wrapManaged(uniqueLines(lines).join("\n").trim() + "\n");
}

export function buildChildMemory(info, ctx, parentLines = []) {
  const all = [
    `local overview: ${ctx.overview || ""}`,
    ...info.entryPoints.map((e) => `entry point: ${e}`),
    ...ctx.whereToLook, ...ctx.invariants, ...ctx.conventions, ...ctx.antiPatterns,
    ...ctx.tests.map((t) => `local tests: ${t}`),
  ];
  const kept = stripParentDuplicates(all, parentLines).filter((l) => !isGeneric(l));
  const lines = [`# ${info.rel} — local memory`, ""];
  if (kept.length) lines.push(kept.map((l) => `- ${l}`).join("\n"));
  else lines.push(`- responsibilities: ${info.fileCount} files, ${info.subdirCount} subdirs, ${info.codeCount} code files`);
  return wrapManaged(uniqueLines(lines).join("\n").trim() + "\n");
}

// Preserve human content: only the managed block is generated/updated. A file with no managed
// markers is pure human content (preserved unless regenerate is set).
export function mergeManaged(existing, newManaged, { regenerate = false } = {}) {
  if (!existing) return { created: true, content: newManaged };
  const has = existing.includes(MANAGED_BEGIN);
  if (!has) {
    if (regenerate) return { created: true, content: newManaged };
    return { preserved: true, content: existing };
  }
  const i = existing.indexOf(MANAGED_BEGIN);
  const end = existing.indexOf(MANAGED_END, i);
  if (end < 0 || existing.indexOf(MANAGED_BEGIN, i + MANAGED_BEGIN.length) >= 0 ||
      existing.indexOf(MANAGED_END, end + MANAGED_END.length) >= 0) {
    return { preserved: true, content: existing, note: "ambiguous managed markers; preserved for review" };
  }
  const j = end + MANAGED_END.length;
  const merged = existing.slice(0, i) + newManaged.trimEnd() + existing.slice(j);
  return { updated: merged !== existing, unchanged: merged === existing, content: merged };
}

// ---- Memory index (.longrun/memory-index.json) --------------------------------------------
export function nodeSignature(root, info) {
  const abs = path.join(root, info.rel);
  const manifests = {};
  for (const m of (info.manifestFiles || [])) {
    const buf = readIfExists(path.join(abs, m));
    if (buf) manifests[m] = sha256(buf);
  }
  return {
    rel: info.rel, fileCount: info.fileCount, subdirCount: info.subdirCount,
    files: info.fileNames.filter(f => f !== "AGENTS.md").sort(), subdirs: [...info.subdirs].sort(),
    codeRatio: Math.round((info.codeRatio || 0) * 100) / 100, hasManifest: !!info.hasManifest,
    entryPoints: [...info.entryPoints].sort(), exportCount: info.exportCount,
    testFileCount: info.testFileCount, rules: info.ruleMarkers.length, manifests,
  };
}

export function structuralDependencies(root) {
  const dependencies = {};
  const stack = [root];
  let budget = 400;
  while (stack.length && budget-- > 0) {
    const d = stack.pop();
    for (const f of listFiles(d)) {
      if (MANIFEST_NAMES.has(f.name) || ENTRY_RE.test(f.name)) {
        const buf = readIfExists(path.join(d, f.name), 64 * 1024);
        dependencies[relSlash(root, path.join(d, f.name))] = buf ? sha256(buf).slice(0, 16) : "gone";
      }
    }
    for (const sd of listDirs(d)) if (!SKIP_DIRS.has(sd.name)) stack.push(path.join(d, sd.name));
  }
  return { dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))), truncated: stack.length > 0 };
}
export function structuralSignature(root) {
  return sha256(Object.entries(structuralDependencies(root).dependencies).map(([p, hash]) => `${p}:${hash}`).sort().join("\n"));
}

export function buildMemoryIndex(root, infos, targets, { commit = null, harnessVersion = "", generatedAt = Date.now() } = {}) {
  const byRel = new Map(infos.map((i) => [i.rel, i]));
  const nodes = targets.map((t) => {
    const info = byRel.get(t.rel);
    return { rel: t.rel, selected: !!t.selected, tier: t.tier, score: t.score, reasons: t.reasons, signature: nodeSignature(root, info) };
  });
  return {
    schemaVersion: SCHEMA_VERSION, memorySchemaVersion: SCHEMA_VERSION, harnessVersion, generatedByHarnessVersion: harnessVersion, generatedAt,
    commit: commit || null, maxDepth: DEFAULT_MAX_DEPTH,
    structuralKey: structuralSignature(root), structuralDependencies: structuralDependencies(root).dependencies, nodes,
  };
}

export const MEMORY_PATH = ".longrun/memory-index.json";
export function readMemoryIndex(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, MEMORY_PATH), "utf8")); } catch { return null; }
}

// ---- Staleness assessment (no full rewrite on ordinary edits) -----------------------------
export function assessStaleness(root, index) {
  if (!index) return { status: "NO_MEMORY", reasons: ["no memory index; run init-deep"], perNode: {} };
  const reasons = [];
  const perNode = {};
  const changedDependencies = [];
  const memorySchemaVersion = index.memorySchemaVersion ?? index.schemaVersion;
  let worst = "FRESH";
  const bump = (s) => { const order = { FRESH: 0, POSSIBLY_STALE: 1, STALE: 2 }; if (order[s] > order[worst]) worst = s; };
  if (memorySchemaVersion !== SCHEMA_VERSION) {
    bump("STALE"); reasons.push("incompatible memory schema; refresh required");
    changedDependencies.push({ path: `${MEMORY_PATH}#memorySchemaVersion`, previousFingerprint: memorySchemaVersion, currentFingerprint: SCHEMA_VERSION, reason: "MEMORY_SCHEMA_INCOMPATIBLE" });
  }
  const current = structuralDependencies(root);
  const curKey = structuralSignature(root);
  if (current.truncated) {
    bump("POSSIBLY_STALE"); reasons.push("structural scan budget exceeded");
    changedDependencies.push({ path: ".", reason: "STRUCTURAL_SCAN_INCOMPLETE", previousFingerprint: index.structuralKey, currentFingerprint: curKey });
  }
  if (index.structuralKey && curKey !== index.structuralKey) {
    bump("STALE"); reasons.push("structural files (manifests/entry points) changed since memory was generated");
    if (index.structuralDependencies) {
      for (const p of [...new Set([...Object.keys(index.structuralDependencies), ...Object.keys(current.dependencies)])].sort()) {
        if (index.structuralDependencies[p] !== current.dependencies[p]) changedDependencies.push({ path: p, previousFingerprint: index.structuralDependencies[p] || null, currentFingerprint: current.dependencies[p] || null, reason: "STRUCTURAL_DEPENDENCY_CHANGED" });
      }
    } else {
      // Old schema stored only a digest. The changed path cannot be recovered from a hash.
      changedDependencies.push({ path: `${MEMORY_PATH}#structuralKey`, previousFingerprint: index.structuralKey,
        currentFingerprint: curKey, reason: "LEGACY_STRUCTURAL_DIGEST_CHANGED", exactPathsKnown: false,
        note: "legacy index lacks per-path entry-point hashes; changed path cannot be reconstructed; refresh records a path baseline" });
    }
  }
  for (const node of index.nodes || []) {
    if (!node.selected) continue;
    const abs = path.join(root, node.rel);
    if (!fs.existsSync(abs)) { perNode[node.rel] = { status: "STALE", reasons: ["directory removed"] }; bump("STALE"); continue; }
    const info = scanDir(root, abs);
    const sig = nodeSignature(root, info);
    const old = node.signature || {};
    const why = [];
    const nodeChanges = [];
    if ((old.hasManifest ?? false) !== sig.hasManifest) why.push("manifest presence changed");
    const oldM = Object.keys(old.manifests || {}).sort(); const curM = Object.keys(sig.manifests || {}).sort();
    if (oldM.join(",") !== curM.join(",")) why.push("manifest set changed (package add/remove/rename)");
    else for (const m of curM) if (old.manifests[m] !== sig.manifests[m]) why.push(`manifest content changed: ${m}`);
    if ((old.entryPoints || []).join(",") !== sig.entryPoints.join(",")) why.push("entry points changed");
    const dFile = Math.abs((old.fileCount || 0) - sig.fileCount);
    const dExport = Math.abs((old.exportCount || 0) - sig.exportCount);
    if (Math.abs((old.subdirCount || 0) - sig.subdirCount) >= 2) why.push("directory topology changed materially");
    if (dExport >= 5) why.push(`public API shifted (export count ${old.exportCount}->${sig.exportCount})`);
    for (const dep of changedDependencies) {
      if (dep.reason === "STRUCTURAL_DEPENDENCY_CHANGED" && path.posix.dirname(dep.path) === (node.rel || ".")) {
        why.push(`structural dependency changed: ${dep.path}`); nodeChanges.push(dep);
      }
    }
    if (why.length || dFile >= 5) nodeChanges.push({ path: node.rel || ".", reason: "NODE_SIGNATURE_CHANGED", previousFingerprint: sha256(JSON.stringify(old)), currentFingerprint: sha256(JSON.stringify(sig)), previousSignature: old, currentSignature: sig });
    changedDependencies.push(...nodeChanges.filter(d => !changedDependencies.includes(d)));
    if (why.length) { perNode[node.rel] = { status: "STALE", reasons: why }; bump("STALE"); }
    else if (dFile >= 5) { perNode[node.rel] = { status: "POSSIBLY_STALE", reasons: [`file count drift ${old.fileCount}->${sig.fileCount} (no structural change)`] }; bump("POSSIBLY_STALE"); }
    else perNode[node.rel] = { status: "FRESH", reasons: [] };
  }
  return { status: worst, reasons, perNode, changedDependencies, memorySchemaVersion,
    generatedByHarnessVersion: index.generatedByHarnessVersion ?? index.harnessVersion ?? null,
    structuralFingerprint: { previous: index.structuralKey || null, current: curKey },
    reloadableNodes: (index.nodes || []).filter(n => n.selected).map(n => path.posix.join(n.rel, "AGENTS.md")) };
}

// Derive real project commands from manifests (never invents them). Used for root COMMANDS +
// VERIFICATION so generated memory points at commands that actually exist.
export function detectCommands(root) {
  const cmds = [];
  const testHints = [];
  const pj = path.join(root, "package.json");
  const buf = readIfExists(pj);
  if (buf) {
    try {
      const obj = JSON.parse(buf.toString("utf8"));
      for (const [k, v] of Object.entries(obj.scripts || {})) cmds.push(`npm run ${k} — ${v}`);
      if (/\b(node --test|jest|vitest|mocha|playwright|cypress|cypress)/i.test(JSON.stringify(obj))) testHints.push("node test runner present (node --test/jest/vitest/playwright)");
    } catch {}
  }
  if (fs.existsSync(path.join(root, "Makefile"))) { try { const mk = fs.readFileSync(path.join(root, "Makefile"), "utf8"); for (const m of mk.matchAll(/^([a-zA-Z0-9_-]+):/gm)) cmds.push(`make ${m[1]}`); } catch {} }
  if (fs.existsSync(path.join(root, "go.mod"))) { cmds.push("go build ./..."); cmds.push("go test ./..."); testHints.push("go test"); }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) { cmds.push("cargo build"); cmds.push("cargo test"); testHints.push("cargo test"); }
  return { cmds: cmds.slice(0, 12), testHints };
}

// ---- init-deep orchestration --------------------------------------------------------------
export function initDeep(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const dryRun = !!opts.dryRun;
  const regenerate = !!opts.regenerate;
  const created = [], updated = [], unchanged = [], preserved = [], skipped = [];
  const infos = scanTree(root, { maxDepth, ...opts });
  const targets = selectTargets(infos, { maxDepth });
  const byRel = new Map(infos.map((i) => [i.rel, i]));
  const childDirs = targets.filter((t) => t.selected && t.rel !== "").map((t) => t.rel.split("/")[0]);
  const detected = opts.detectCommands === false ? { cmds: [], testHints: [] } : detectCommands(root);

  for (const t of targets) {
    if (!t.selected) { skipped.push({ rel: t.rel, reason: t.reason, tier: t.tier, score: t.score }); continue; }
    const info = byRel.get(t.rel);
    const agPath = path.join(t.dir, "AGENTS.md");
    const isRoot = t.rel === "";
    let body;
    if (isRoot) {
      const ctx = {
        harnessVersion: opts.harnessVersion || "",
        overview: info.entryPoints.length ? `Entry points: ${info.entryPoints.join(", ")}. Top-level modules: ${info.subdirs.join(", ") || "(flat)"}.` : `Top-level modules: ${info.subdirs.join(", ") || "(flat)"}.`,
        whereToLook: info.subdirs.map((d) => `${d}/: inspect AGENTS.md in ${d}/ if present`),
        codeMap: info.subdirs.map((d) => `${d}/: ${countCode(byRel, d)} code files`),
        invariants: info.ruleMarkers.slice(0, 8),
        antiPatterns: [], commands: (opts.commands || []).concat(detected.cmds), verification: detected.testHints.slice(0, 6), childDirs,
      };
      body = buildRootMemory(info, ctx);
    } else {
      const parentDir = path.dirname(t.rel) ? path.join(root, path.dirname(t.rel)) : root;
      const parentText = readIfExists(path.join(parentDir, "AGENTS.md"));
      const parentLines = parentText ? parentText.toString("utf8").split("\n").map((s) => s.replace(/^- /, "").trim()).filter(Boolean) : [];
      const ctx = {
        overview: `${info.rel}: ${info.fileCount} files, ${info.codeCount} code, ${info.testFileCount} test files.`,
        whereToLook: info.entryPoints.length ? [`entry points: ${info.entryPoints.join(", ")}`] : [],
        invariants: info.ruleMarkers.slice(0, 6), conventions: [], antiPatterns: [],
        tests: [...new Set(info.fileNames.filter((f) => TEST_HINT_RE.test(f)))].slice(0, 8),
      };
      body = buildChildMemory(info, ctx, parentLines);
    }
    let action = "created", out = body, note = "";
    const existing = readIfExists(agPath);
    if (existing) {
      const m = mergeManaged(existing.toString("utf8"), body, { regenerate });
      if (m.preserved) { action = "preserved"; note = m.note || "human content without managed markers; use regenerate=true to replace"; }
      else if (m.unchanged) { action = "unchanged"; out = m.content; }
      else if (m.updated) { action = "updated"; out = m.content; }
    }
    const entry = { rel: t.rel, path: agPath, action, tier: t.tier, score: t.score, reasons: t.reasons, note };
    if (action === "created") created.push(entry); else if (action === "updated") updated.push(entry); else if (action === "unchanged") unchanged.push(entry); else if (action === "preserved") preserved.push(entry);
    if (!dryRun && action !== "preserved" && action !== "unchanged") {
      try { fs.mkdirSync(path.dirname(agPath), { recursive: true }); if (!existing || existing.toString("utf8") !== out) fs.writeFileSync(agPath, out); } catch {}
    }
  }
  const commit = gitHeadAt(root);
  const index = buildMemoryIndex(root, scanTree(root, { maxDepth, ...opts }), targets, { commit, harnessVersion: opts.harnessVersion || "" });
  index.maxDepth = maxDepth;
  const indexPath = path.join(root, MEMORY_PATH);
  const oldIndex = readMemoryIndex(root);
  if (oldIndex && JSON.stringify({ ...oldIndex, generatedAt: 0 }) === JSON.stringify({ ...index, generatedAt: 0 })) index.generatedAt = oldIndex.generatedAt;
  const indexText = JSON.stringify(index, null, 2);
  if (!dryRun && readIfExists(indexPath)?.toString("utf8") !== indexText) {
    try { fs.mkdirSync(path.dirname(indexPath), { recursive: true }); fs.writeFileSync(indexPath, indexText); } catch {}
  }
  return { dryRun, regenerate, created, updated, unchanged, preserved, skipped, index, indexPath, willWrite: [...created, ...updated].map((e) => e.path) };
}
