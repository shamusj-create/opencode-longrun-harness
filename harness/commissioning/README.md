# Commissioning case scripts

**These are not generic harness tools.** They are the concrete scripts used for one commissioning case,
kept as evidence of how that case was run. They contain values specific to that case — a particular
state hash, receipt counts, a loss figure, fixed ports and one application's workspace layout.

| Script | What it does | Coupled to |
| --- | --- | --- |
| `verify-copied-case.mjs` | Runs declared engineering checks against a physically separate copy of an application, then asserts the run record survived intact | One case's state hash, `receipts.length === 39`, `currentLoss === 10/11`, fixed check ids, ports 5199/8787 and 55199/58787, `packages/web/vite.config.ts`, `scripts/verify-all.sh` |
| `inspect-copied-run.mjs` | Projects a copied run's state for inspection without touching live evidence | A case's directory layout |

The generic, reusable parts of this harness live in `harness/src/` (the engine) and `harness/tools/`
(the operator utilities). If you want to reuse the copying technique on another project, the things to
parameterise are: the case root, the workspace layout paths, the port pairs to remap, the log path, the
check ids, and the expected counts — everything currently written as a literal in
`verify-copied-case.mjs`.
