# OpenCode Long-run Harness

**Bounded, evidence-driven long-run workflow infrastructure for [OpenCode](https://opencode.ai).**

A *tracked run* is driven by a **contract**: required criteria, each mapped to **declared checks** that
must actually execute. Progress is measured as **loss** (unverified required criteria). Every result is
recorded as a **receipt** bound to a **source fingerprint**, and a run can only reach `COMPLETE` when
every declared check passes on the *current* source **and** an independent **operator review** accepts
the evidence.

The controller is deliberately dependency-free — Node builtins only. No bundler, no second server, no
always-on daemon, no external service, no cloud model.

---

## Why this exists

Long autonomous coding sessions fail in predictable ways:

- the agent claims success that its own tests do not support;
- evidence silently goes **stale** after a source change, while the check table still looks green;
- a run loops without progress, or burns its budget and keeps going;
- a model resumes, rewrites or self-approves a run it should not;
- a conversation is compacted and nobody notices what was actually verified.

This harness makes each of those failure modes explicit *and checkable*. It is workflow
infrastructure, not a correctness guarantee: it constrains and records what happened, and it refuses
to call work finished on weak evidence.

---

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Tracked run** | One contract-bound unit of work with its own budgets, receipts, history and lifecycle. |
| **Contract** | Required criteria, each mapped to one or more declared checks. A required criterion with no satisfiable check cannot be created — a run that could never reach loss 0 is refused at start. |
| **Declared checks** | Named commands (`cmd`) declared in a catalogue. Verification runs *these*, by id; arbitrary commands are refused. |
| **Receipt** | The recorded result of one declared-check execution: status, exit code, output tail, evidence class, contract hash and the source fingerprint it measured. |
| **Evidence class** | `STATIC` / `UNIT` / `INTEGRATION` / `SYSTEM` / `BROWSER` / `VISION` / `HUMAN/EXTERNAL`, derived from the criterion the check maps to when not passed explicitly. |
| **Freshness** | A receipt only counts for the source state it measured. Any tracked-file change makes earlier receipts `STALE`, so evidence must be re-established on the frozen source. |
| **Loss** | Weighted count of required criteria that are not currently verified. `loss 0` is necessary but not sufficient for completion. |
| **Hard gates** | Checks a contract marks as gates. A failing gate blocks completion regardless of loss. |
| **Negative control** | A run against a *physically isolated copy* with one deliberate defect, proving an unchanged assertion actually detects that defect. Fixtures are refused if they overlap the real project. |
| **Lifecycle** | `READY → IMPLEMENTING → VERIFYING → REPAIRING / NEEDS_REPLAN → COMPACTING → RECOVERY_REQUIRED → … → PAUSED / BLOCKED / COMPLETE / CANCELLED`. Only canonical state reports lifecycle. |
| **Budgets** | Candidates, active check time, absolute deadline, command attempts, same-failure and no-progress limits. Enforced by the harness, not advisory. |
| **Amendment** | An **operator-only**, append-only grant of extra candidates and/or a new absolute deadline for an already-paused run. It never resumes a run, never resets counters, never grants acceptance, and has no native model tool action. |
| **Completion review** | A run cannot complete on green checks alone. An operator records an accept/reject bound to the current evidence basis; any later budget or source change invalidates it. |
| **Memory** | Hierarchical `AGENTS.md` nodes: curated human prose is preserved, managed blocks are regenerated. Memory never overrides canonical lifecycle. |
| **Recovery** | A natural compaction moves the run to `RECOVERY_REQUIRED`. `resume-context` re-establishes the state, then an explicit `resume` re-binds the session and worktree to the same run. |

---

## How it is built

| Piece | Path | Role |
| --- | --- | --- |
| Controller | `harness/src/controller.js` | Canonical state, contract, loss, receipts, views, review, amendment, memory. The single source of truth. |
| Execution | `harness/src/execution.mjs` | Declared-check execution, budgets, process groups, termination and timing. |
| Durable executor | `harness/src/executor.mjs` | Runs a check in a finite worker so an owned process is cleaned up and real evidence survives a host disconnect. Not a daemon. |
| OpenCode plugin | `harness/plugin/longrun.js` | Exposes the native `longrun` and `longrun_verify` tools, the lifecycle guard, routing and compaction handling. |
| Installer | `harness/src/install.mjs` | Reversible, ownership-manifest-based, JSONC-safe install. Never edits provider/model config. |
| Operator CLI | `harness/src/maintenance.mjs` | `doctor`, `status`, `pause`, `review`, `amend`, `disable`, `enable`, `uninstall`. |
| Recovery runner | `harness/tools/recovery-runner.mjs` | Operator-side supervised dispatch: verifies the served model, resumes a stuck run with bounded attempts, refuses to credit a no-op, and can hand a run to a fresh reduced-context conversation. |
| Receipt auditor | `harness/tools/audit-receipts.mjs` | Independently audits receipts for substituted commands, contract mismatch, PASS-with-non-zero-exit, backdating and freshness. |

---

## Install

```sh
npm run install:global        # node harness/src/cli.mjs install
```

The installer is **reversible**: it writes only Longrun-owned paths under the OpenCode config
directory, records an ownership manifest plus a rollback manifest, preserves unrelated configuration,
and never touches provider, model or permission settings. `npm run uninstall` removes exactly what it
installed.

## Test

```sh
npm test        # node --test harness/test/*.test.mjs
```

**282 tests across 38 files, all passing.** These are offline tests against fixtures and mock
sessions: they are deliberately *not* treated as proof that a real OpenCode host behaves a certain
way, and they never touch production state.

## Operator CLI

Installed as `longrun-harness/longrun` (a thin launcher over `harness/src/maintenance.mjs`):

| Command | Purpose |
| --- | --- |
| `doctor [--live]` | Self-test the installation and the resolution path. |
| `status --json --project DIR --run ID` | Canonical lifecycle, loss, criteria, checks, budgets, review state. |
| `pause --json --project DIR --run ID` | Canonical pause through the same writer lock as native pause. |
| `review --verdict accept\|reject --expected-basis HASH --review-id ID --reason-file FILE` | Record the independent completion review. |
| `amend --additional-candidates N --new-deadline ISO --expected-basis HASH --expected-revision R …` | Append-only budget/deadline grant for a paused run. |
| `disable` / `enable` / `uninstall` | Take the harness out of the loop, or remove it. |

## Native model tool surface

Inside OpenCode the model sees exactly two tools:

- `longrun` — `help`, `start`, `status`, `receipts`, `next` (resume-context), `checkpoint`, `verify`,
  `pause`, `resume`, `complete`, `cancel`, `reconcile`, `memory_init`, `memory_refresh`, `memory_status`
- `longrun_verify` — run a *declared* check by id in `normal` or `negative` mode (negative mode takes
  an isolated fixture)

There is no native amend action and no native self-approval. Ordinary execution, edits and memory
writes are stopped by the lifecycle guard in any non-eligible state.

---

## Verified status, honestly

- **Offline suite:** 282 passing tests covering identity keying, loss integrity, receipt eligibility
  and staleness, single-flight scheduling, resume authorization, stall/replan/pause, budget
  amendment, completion review, negative-control isolation, memory, and the recovery runner.
- **Real host behaviour** has been exercised in separate, dated commissioning work: lifecycle
  transitions end-to-end, a real compaction with supervised recovery, and full-stack trial runs driven
  to `COMPLETE`. Those are recorded in the release reports below rather than reproduced here.
- **Known limits, by design:** total host activity (model inference, ordinary tools) is **not**
  metered — budgets cover declared-check execution; automatic continuation is **OFF**; compaction
  recovery is **supervised**, not autonomous; a run parked with no progress is stopped rather than
  looping; and this is an auditable workflow boundary, **not** an OS sandbox against arbitrary
  state-file access.

## Release reports

- [v1.2.22 — evidence-class derivation](docs/V1.2.22_EVIDENCE.md)
- [v1.2.21 — negative-fixture anchoring](docs/V1.2.21_EVIDENCE.md)
- [v1.2.20 — audited operator budget amendment](docs/V1.2.20_EVIDENCE.md)

## Requirements

Node.js with `node:test` and `node:sqlite`-era builtins (developed and tested on Node 24). OpenCode
desktop or CLI for the plugin.

## License

No license has been chosen for this repository yet, so it is **all rights reserved** by default. Open
an issue if you would like a specific license applied.
