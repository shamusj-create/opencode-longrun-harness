import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// v1.2.26 — two operational fixes:
//   1. an operator `version` command, shipped as the /longrun-version OpenCode command
//   2. load-record hygiene: dead-pid records are pruned on write, and doctor --live summarises
//      rejections by reason instead of printing one line per long-dead host.
import { install, VERSION } from "../src/install.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const PLUG_FILE = path.resolve(import.meta.dirname, "..", "plugin", "longrun.js").split(path.sep).join("/");

// A genuine host-shaped child: OPENCODE_CLIENT set, test context explicitly disarmed.
function hostEnv(state, cfg) {
  const e = { ...process.env, LONGRUN_STATE_DIR: state, OPENCODE_CLIENT: "1", OPENCODE_CONFIG_DIR: cfg };
  delete e.LONGRUN_TEST; delete e.NODE_TEST_CONTEXT; delete e.NODE_OPTIONS;
  return e;
}

// ---------------------------------------------------------------- version reporting

test("v1.2.26 version finds plugins in the config array AND the auto-loaded plugins/ dir", () => {
  const cfg = tmp("ver-cfg-");
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  // directory convention: named in NO config array, but OpenCode loads it
  fs.writeFileSync(path.join(cfg, "plugins", "longrun.js"), "// installed plugin copy\n");
  fs.writeFileSync(path.join(cfg, "plugins", "declares-a-version.mjs"), 'const VERSION = "3.2.1";\n');
  // JSONC: comments and a trailing comma must not defeat the read
  fs.writeFileSync(path.join(cfg, "opencode.jsonc"),
    '{\n  // a comment\n  "plugin": ["/tmp/does-not-exist/named-thing.js",],\n}\n');

  install({ configDir: cfg });
  // the release pointer is authoritative for the harness plugin; set it AFTER install, which
  // otherwise writes the current release into it
  fs.writeFileSync(path.join(cfg, "longrun-harness", "current"), "9.9.9");
  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const r = spawnSync(process.execPath, [bin, "version", "--json"],
    { encoding: "utf8", cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: tmp("ver-st-") } });
  assert.equal(r.status, 0, "version exits 0:\n" + r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.harnessVersion, "9.9.9", "harness version comes from the release pointer");
  const byName = Object.fromEntries(j.plugins.map((p) => [p.name, p]));
  assert.ok(byName["longrun.js"], "the directory-convention plugin is reported (no config entry names it)");
  assert.equal(byName["longrun.js"].version, "9.9.9");
  assert.equal(byName["longrun.js"].note, "long-run harness");
  assert.equal(byName["declares-a-version.mjs"].version, "3.2.1", "version read from the file");
  assert.ok(byName["named-thing.js"], "absolute config entry treated as a file, shown by basename");
  assert.equal(byName["named-thing.js"].version, "not declared");
});

test("v1.2.26 version works with NO release tree (GUI-only install), unlike doctor", () => {
  const cfg = tmp("ver-bare-");
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "plugins", "longrun.js"), "// plugin only, harness never installed\n");
  const src = path.resolve(import.meta.dirname, "..", "src", "maintenance.mjs");
  const r = spawnSync(process.execPath, [src, "version"],
    { encoding: "utf8", cwd: "/tmp", env: { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: tmp("ver-bare-st-") } });
  assert.equal(r.status, 0, "must not need a controller:\n" + r.stdout + r.stderr);
  assert.match(r.stdout, /installed plugins \(1\)/, "still reports the plugin it can see");
  assert.match(r.stdout, /longrun\.js/);
});

// ---------------------------------------------------------------- installer ships the command

test("v1.2.26 the installer ships /longrun-version with the launcher path baked in", () => {
  const cfg = tmp("ver-inst-");
  install({ configDir: cfg });
  const p = path.join(cfg, "commands", "longrun-version.md");
  assert.ok(fs.existsSync(p), "commands/longrun-version.md installed");
  const txt = fs.readFileSync(p, "utf8");
  assert.match(txt, /^---\ndescription: .+\nagent: build\n---/, "frontmatter pins the build agent");
  const launcher = path.join(cfg, "longrun-harness", "longrun");
  assert.ok(txt.includes("!`" + launcher + " version`"), "runs the installed launcher, absolute path baked");
  assert.ok(!txt.includes("__LONGRUN"), "no placeholder left behind");
  assert.match(txt, /fenced code block/, "asks for the layout to be preserved");
  assert.match(txt, /do not call any tools/, "read-only guard present");
});

// ---------------------------------------------------------------- load-record hygiene

test("v1.2.26 bootstrap writes a host record and prunes dead-pid records only", () => {
  const cfg = tmp("ret-cfg-");
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  const state = tmp("ret-st-");
  const load = path.join(state, "load");
  fs.mkdirSync(load, { recursive: true });

  const live = { at: Date.now(), nonce: "live", toolsBuilt: true, hookActivity: 1, pid: process.pid, exec: "/Applications/OpenCode.app/Contents/MacOS/OpenCode" };
  fs.writeFileSync(path.join(load, "host-live.json"), JSON.stringify(live));
  fs.writeFileSync(path.join(load, "host-dead.json"), JSON.stringify({ at: Date.now(), nonce: "d", toolsBuilt: true, hookActivity: 1, pid: 99999999 }));
  fs.writeFileSync(path.join(load, "keep-me.txt"), "not a record\n"); // unparseable: must survive

  const code = `const m = await import("file://${PLUG_FILE}"); await m.default.server({ client: null });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: hostEnv(state, cfg) });
  assert.equal(r.status, 0, "host child ran:\n" + r.stdout + r.stderr);

  const names = fs.readdirSync(load);
  assert.ok(!names.includes("host-dead.json"), "dead-pid record pruned on write");
  assert.ok(names.includes("host-live.json"), "live-pid record kept (another host may be running)");
  assert.ok(names.includes("keep-me.txt"), "a file that is not a parseable record is never deleted");
  const written = names.filter((n) => n.startsWith("host-") && n !== "host-live.json" && n !== "host-dead.json");
  assert.equal(written.length, 1, "the host wrote its own record: " + names.join(","));
});

test("v1.2.26 doctor --live summarises rejections but keeps per-record detail in JSON", () => {
  const cfg = tmp("grp-cfg-");
  install({ configDir: cfg });
  const state = tmp("grp-st-");
  const load = path.join(state, "load");
  fs.mkdirSync(load, { recursive: true });
  const dead = (n) => ({ at: Date.now(), nonce: "n" + n, toolsBuilt: true, hookActivity: 2, pid: 90000000 + n,
    exec: "/Applications/OpenCode.app/Contents/MacOS/OpenCode" });
  for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(load, `host-d${i}.json`), JSON.stringify(dead(i)));
  fs.writeFileSync(path.join(load, "host-stale.json"), JSON.stringify({ at: Date.now() - 20 * 60 * 1000, nonce: "s",
    toolsBuilt: true, hookActivity: 2, pid: process.pid, exec: "/Applications/OpenCode.app/Contents/MacOS/OpenCode" }));

  const bin = path.join(cfg, "longrun-harness", "releases", VERSION, "bin", "longrun.mjs");
  const env = { ...process.env, OPENCODE_CONFIG_DIR: cfg, LONGRUN_STATE_DIR: state };

  const text = spawnSync(process.execPath, [bin, "doctor", "--live"], { encoding: "utf8", cwd: "/tmp", env });
  const failLines = text.stdout.split("\n").filter((l) => l.startsWith("  FAIL") && l.includes("rejected as untrusted"));
  assert.equal(failLines.length, 1, "one summary line, not one per record:\n" + text.stdout);
  assert.match(failLines[0], /5 load record\(s\) rejected as untrusted/);
  assert.match(failLines[0], /4 dead-or-missing-pid/);
  assert.match(failLines[0], /1 stale/);

  const j = JSON.parse(spawnSync(process.execPath, [bin, "doctor", "--live", "--json"], { encoding: "utf8", cwd: "/tmp", env }).stdout);
  assert.equal(j.liveEvidence.rejectedUntrusted.length, 5, "per-record detail retained for machine reads");
  assert.deepEqual(j.liveEvidence.rejectionSummary, { "dead-or-missing-pid": 4, stale: 1 });
  assert.equal(j.live, "NOT_VERIFIED");
});
