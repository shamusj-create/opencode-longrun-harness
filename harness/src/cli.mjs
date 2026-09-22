#!/usr/bin/env node
// Long-run harness maintenance CLI. Dependency-free (node builtins).
// Usage: node cli.mjs <dry-run|install|doctor|disable|enable|uninstall> [--config-dir PATH] [--home PATH] [--json]
import { install, doctor, uninstall, disable, enable, resolveConfigDir, VERSION } from "./install.mjs";
import fs from "node:fs";

const [, , cmd, ...rest] = process.argv;
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const json = rest.includes("--json");
let configDir = flag("--config-dir");
if (!configDir) {
  const home = flag("--home");
  configDir = home ? home + "/.config/opencode" : resolveConfigDir({ HOME: process.env.HOME });
}

function main() {
  const report = (() => {
    switch (cmd) {
      case "dry-run": return install({ configDir, dryRun: true, version: VERSION });
      case "install": return install({ configDir, version: VERSION });
      case "doctor": return doctor({ configDir });
      case "disable": return disable({ configDir });
      case "enable": return enable({ configDir });
      case "uninstall": return uninstall({ configDir });
      default: return { error: "unknown command", usage: "node cli.mjs <dry-run|install|doctor|disable|enable|uninstall> [--config-dir PATH] [--home PATH]" };
    }
  })();
  const code = report && (report.error || (report.ok === false) || (report.degraded && report.degraded.length)) ? 2 : 0;
  if (json) { process.stdout.write(JSON.stringify({ configDir, cmd, ...report }, null, 2) + "\n"); }
  else {
    process.stdout.write(`config-dir: ${configDir}\ncmd: ${cmd}\n`);
    for (const a of (report.actions || [])) process.stdout.write(`  ${a.action.padEnd(16)} ${a.rel}\n`);
    for (const c of (report.conflicts || [])) process.stdout.write(`  CONFLICT       ${c.rel} (${c.reason})\n`);
    for (const d of (report.degraded || [])) process.stdout.write(`  DEGRADED       ${d}\n`);
    for (const n of (report.notes || [])) process.stdout.write(`  note: ${n}\n`);
    if (report.removed) process.stdout.write(`  removed ${report.removed.length}; preserved-edits ${report.leftEdited.length}\n`);
  }
  process.exit(code);
}
main();