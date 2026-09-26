// Sibling controller entry point, for package installs.
//
// The plugin resolves its controller in this order: LONGRUN_CONTROLLER_FILE, then the install-time
// baked file:// URL, then ./_controller.js next to the plugin itself.
//
// `longrun-harness install` (the directory convention) bakes an absolute URL into the copy it writes
// to <config>/plugins/longrun.js, so that path never needs this file. But when OpenCode loads the
// plugin straight from the npm package — the Desktop Plugins pane, or
// `opencode plugin opencode-longrun-harness -g` — nothing baked a URL, and the sibling candidate is
// the only one left. Without it the controller does not resolve, and the plugin goes INERT: it
// registers zero tools and logs a single "controller NOT found; plugin inert" warning. Installed,
// enabled, and silently doing nothing is the worst of the failure modes, so ship the sibling.
//
// A relative re-export keeps this location-independent: the packaged controller and its own
// ./evidence.mjs / ./memory.mjs / ./execution.mjs siblings all live under harness/src, which is in the
// published file set. No absolute path is baked, so nothing breaks if the package is relocated.
export * from "../src/controller.js";
