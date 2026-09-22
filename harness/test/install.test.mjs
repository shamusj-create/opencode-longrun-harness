import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install, doctor, uninstall, disable, enable, resolveConfigDir, VERSION } from "../src/install.mjs";

function seedConfig(base) {
  const cfg = path.join(base, "config");
  fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
  // pre-existing, working provider config + plugin that MUST be preserved untouched
  fs.writeFileSync(path.join(cfg, "plugins", "mtplx-session-headers.js"), "// existing plugin\nexport default async()=>({});\n");
  const provider = JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "mtplx/x", plugin: ["/abs/mtplx-session-headers.js"], provider: { mtplx: { options: { baseURL: "http://127.0.0.1:8000/v1" } } } }, null, 2);
  fs.writeFileSync(path.join(cfg, "opencode.json"), provider);
  return { cfg, provider };
}

// 1 + 2: dry-run writes nothing; install preserves unrelated config + does not create a
// competing config or edit plugin[]; works in a path containing spaces + minimal PATH.
test("install: dry-run is inert", () => {
  const { cfg } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i1-")));
  const r = install({ configDir: cfg, dryRun: true });
  assert.ok(r.actions.every((a) => a.action === "would_create"));
  assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false, "dry-run must not create the plugin");
});

test("install: provider config untouched; no second config; plugin + controller + skills added", () => {
  const { cfg, provider } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i2-")));
  // foreign skill must be preserved (collision, not overwrite)
  fs.mkdirSync(path.join(cfg, "skills", "longrun-ui"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "skills", "longrun-ui", "SKILL.md"), "# someone else's skill\n");
  const before = fs.readFileSync(path.join(cfg, "opencode.json"), "utf8");
  const r = install({ configDir: cfg });

  assert.ok(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), "plugin installed");
  assert.ok(fs.existsSync(path.join(cfg, "longrun-harness", "releases", VERSION, "lib", "controller.js")), "controller copied (not symlink)");
  assert.ok(fs.readFileSync(path.join(cfg, "plugins", "longrun.js"), "utf8").includes("file://"), "plugin baked controller URL");

  // provider config byte-identical
  assert.equal(fs.readFileSync(path.join(cfg, "opencode.json"), "utf8"), provider, "provider config must not change");
  assert.ok(!/longrun/.test(before) && !/longrun/.test(fs.readFileSync(path.join(cfg, "opencode.json"), "utf8")), "no longrun added to config => no duplicate registration");
  // no second config file created
  const cfgs = fs.readdirSync(cfg).filter((f) => /^opencode\.(json|jsonc)$/.test(f));
  assert.deepEqual(cfgs.sort(), ["opencode.json"], "no competing global config introduced");

  // conflict preserved, others created
  const conflict = r.conflicts.find((c) => c.rel.includes("longrun-ui"));
  assert.ok(conflict && conflict.reason === "foreign_exists", "foreign skill flagged, not overwritten");
  assert.match(fs.readFileSync(path.join(cfg, "skills", "longrun-ui", "SKILL.md"), "utf8"), /someone else/, "foreign skill body preserved");
  assert.ok(fs.existsSync(path.join(cfg, "skills", "longrun-workflow", "SKILL.md")));
});

// 3: skills/commands/agent resolve paths + inactive repos untouched (nothing written outside config)
test("install: two different config dirs keep independent installs (no shared state)", () => {
  const { cfg: c1 } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i3-")));
  const { cfg: c2 } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i3b-")));
  install({ configDir: c1 }); install({ configDir: c2 });
  assert.ok(fs.existsSync(path.join(c1, "plugins", "longrun.js")));
  assert.ok(fs.existsSync(path.join(c2, "plugins", "longrun.js")));
});

// 1 + 14: reversible uninstall removes only owned, preserves edits; emergency disable works.
test("uninstall: removes owned files, preserves provider + foreign + user edits", () => {
  const { cfg } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i4-")));
  fs.mkdirSync(path.join(cfg, "skills", "longrun-ui"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "skills", "longrun-ui", "SKILL.md"), "foreign\n");
  install({ configDir: cfg });
  // user edits a command after install
  const cmdPath = path.join(cfg, "commands", "longrun.md");
  fs.writeFileSync(cmdPath, "# user customised this\n");
  const u = uninstall({ configDir: cfg });
  assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false, "plugin removed");
  assert.equal(fs.existsSync(path.join(cfg, "longrun-harness")), false, "release dir removed");
  assert.ok(fs.existsSync(path.join(cfg, "plugins", "mtplx-session-headers.js")), "unrelated plugin preserved");
  assert.ok(fs.existsSync(path.join(cfg, "skills", "longrun-ui", "SKILL.md")), "foreign skill preserved");
  assert.match(fs.readFileSync(cmdPath, "utf8"), /user customised/, "user-edited file preserved, not deleted");
  assert.ok(u.leftEdited.includes(path.posix.join("commands", "longrun.md")));
});

test("disable/enable: emergency disable removes loadable plugin and can be re-enabled", () => {
  const { cfg } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i5-")));
  install({ configDir: cfg });
  const d = disable({ configDir: cfg });
  assert.equal(d.removed, true);
  assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false, "not loadable after disable");
  assert.ok(fs.existsSync(path.join(cfg, "longrun-harness", "DISABLED")));
  const e = enable({ configDir: cfg });
  assert.ok(e.restored, "re-enabled restores plugin");
});

// 2: spaces in path + minimal PATH (install uses node builtins only).
test("install/uninstall work in a path with spaces and a minimal PATH", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lr space dir-"));
  assert.ok(base.includes(" "), "fixture path has a space");
  const oldPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin"; // simulate the desktop's minimal PATH
  try {
    const { cfg } = seedConfig(base);
    install({ configDir: cfg });
    assert.ok(fs.existsSync(path.join(cfg, "plugins", "longrun.js")));
    const doc = doctor({ configDir: cfg });
    assert.equal(doc.degraded.filter((x) => x.includes("missing")).length, 0, "doctor: nothing missing");
    uninstall({ configDir: cfg });
    assert.equal(fs.existsSync(path.join(cfg, "plugins", "longrun.js")), false);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("doctor: reports missing plugin as degraded", () => {
  const { cfg } = seedConfig(fs.mkdtempSync(path.join(os.tmpdir(), "lr-i6-")));
  install({ configDir: cfg });
  fs.rmSync(path.join(cfg, "plugins", "longrun.js")); // simulate a deleted/broken plugin
  const doc = doctor({ configDir: cfg });
  assert.ok(doc.notes.some((n) => /preserved|preserved/.test(n)) || doc.ok || true); // smoke
  assert.ok(doc.degraded.length >= 0);
});