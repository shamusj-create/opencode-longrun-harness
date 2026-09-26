# OpenCode Long-run Harness

[![npm version](https://img.shields.io/npm/v/opencode-longrun-harness.svg)](https://www.npmjs.com/package/opencode-longrun-harness)
[![license](https://img.shields.io/npm/l/opencode-longrun-harness.svg)](LICENSE)

**Bounded, evidence-driven long-run workflow infrastructure for [OpenCode](https://opencode.ai).**

A *tracked run* is driven by a **contract**: required criteria, each mapped to **declared checks** that
must actually execute. Progress is measured as **loss** (unverified required criteria). Every result is
recorded as a **receipt** bound to a **source fingerprint**, and a run can only reach `COMPLETE` when
every declared check passes on the *current* source **and** an independent **operator review** accepts
the evidence.

The controller is deliberately dependency-free — Node builtins only. No bundler, no second server, no
always-on daemon, no external service, no cloud model. It is **project-agnostic**: it drives any
full-stack repository through the same lifecycle, and the local toolchain (model id, CLI path, runtime)
is configuration rather than code — see [Tested setup](#tested-setup) for the environment it was
validated on.

---

## Why use this instead of a vanilla harness

"Vanilla" — plain OpenCode plus a model, no contract layer — is perfectly good for short, interactive
work. It degrades in a specific, predictable way on long autonomous work: **you cannot tell the
difference between "finished" and "confidently described as finished".** This harness exists to make
that difference mechanical.

| Concern | Vanilla | This harness |
| --- | --- | --- |
| **What "done" means** | The model says so, or its own tests happen to pass | Every *declared* check passed on the frozen source **and** an operator accepted the evidence |
| **Evidence freshness** | Tests passed at some point; a later edit does not invalidate the claim | Receipts are bound to a source fingerprint — any tracked edit makes them `STALE` and they must be re-earned |
| **What gets verified** | Whatever command the model chose to run, at whatever moment | Only checks the contract *declared*, run by id; arbitrary commands are refused |
| **Self-approval** | The agent can declare its own success | The model **cannot** complete a run; completion needs an operator review bound to an evidence hash, and any later change invalidates it |
| **Long sessions** | Compaction loses the thread; work is silently redone, or claimed without being redone | Run state is canonical on disk: compaction moves the run to `RECOVERY_REQUIRED` and a supervised resume re-binds the session and worktree |
| **Runaway loops** | Unbounded retries, no memory of what already failed | Budgets (candidates, active check time, absolute deadline, command attempts, same-failure and no-progress limits) are enforced, not advisory |
| **False-positive tests** | An assertion can pass while the feature is unreachable | Negative controls on a *physically isolated copy* prove an assertion can actually fail, and the receipt auditor flags substituted commands and PASS-with-non-zero-exit |
| **Auditability** | A chat transcript | Append-only receipts and evidence, contract hash, source fingerprint, amendments, review basis |
| **Across projects** | Hand-rolled conventions per repo | One lifecycle, one CLI, one contract shape for any repository; the local toolchain is configurable |

**What it deliberately does not do.** It is workflow infrastructure, not a correctness guarantee and not
an OS sandbox: total host activity (model inference, ordinary tool calls) is *not* metered, budgets cover
declared-check execution, automatic continuation is **off** by default, compaction recovery is
**supervised** rather than autonomous, and it does not stop a determined process from touching state
files. It makes each failure mode above **explicit and checkable** — it does not make them impossible.

---

## Features

- **Contract-bound runs.** Required criteria, each mapped to declared checks. A required criterion with
  no satisfiable check is refused at *start*, so a run that could never reach loss 0 cannot be opened.
- **Loss as the progress signal.** Weighted count of unverified required criteria, recomputed from
  evidence rather than asserted by the model.
- **Declared-checks-only verification.** Checks live in a catalogue; verification runs them by id.
  Arbitrary shell commands are rejected, so "verification" cannot drift into a different command.
- **Fingerprint-bound receipts.** Every result records the source state it measured, plus status, exit
  code, output tail, evidence class and the contract hash.
- **Automatic staleness.** A tracked-source change invalidates earlier receipts, so green evidence can
  never be inherited by code that was never tested.
- **Hard gates.** A check marked as a gate blocks completion regardless of loss.
- **Enforced budgets.** Candidates, active check time, absolute deadline, command attempts, and
  same-failure / no-progress thresholds.
- **Operator-only, append-only amendments.** Extra candidates or a new deadline for a paused run —
  preserving the original limits, usage, receipts and history. There is no model-side amend action.
- **Independent completion review.** An accept/reject decision bound to a hash of the contract, source,
  budgets and evidence. Any later change invalidates the approval.
- **Negative controls.** A run against a physically isolated copy with one deliberate defect, proving the
  unchanged assertion detects it. Fixtures that overlap the real project are refused.
- **Compaction recovery.** Natural compaction parks the run; `resume-context` re-establishes state and an
  explicit `resume` re-binds the new session and worktree to the *same* run.
- **Hierarchical memory.** `AGENTS.md` nodes where human prose is preserved and managed blocks are
  regenerated; memory never overrides canonical lifecycle.
- **Reversible install.** Ownership-manifest based, JSONC-safe, and it never edits provider, model or
  permission configuration. `uninstall` removes exactly what it installed.
- **Supervised dispatch runner.** Operator-side: discovers the live model endpoint from the running
  server's own listening socket, verifies the single served model *before* every dispatch, resumes a
  stuck run with bounded attempts, refuses to credit a no-op, and treats a terminal run as an ending
  rather than a failure.
- **Independent receipt auditor.** A second implementation that re-reads receipts looking for substituted
  commands, contract mismatch, PASS with a non-zero exit, backdating and freshness problems.
- **Project-agnostic by configuration.** Model id, provider model, OpenCode binary and the runtime
  matcher all resolve from the environment (see [Configure for your project](#configure-for-your-project)).

---

## Usage guide

### 1. Install

```sh
npm install -g opencode-longrun-harness
longrun-harness install
```

The first line installs the package from the npm registry. The second copies the plugin, the operator CLI,
the agent, the commands and the skills into your OpenCode config directory (`~/.config/opencode` by default),
writing only Longrun-owned paths alongside an ownership and rollback manifest. `longrun-harness dry-run`
previews it; `longrun-harness uninstall` reverses it exactly; `longrun-harness disable` / `enable` toggle it
without removing anything; `--config-dir PATH` targets somewhere else.

Then **restart OpenCode.** Plugins load at process start, so one installed into an already-running backend
is not active yet.

<details>
<summary>Other install paths</summary>

- **From a clone** (development): `npm run install:global`, i.e. `node harness/src/cli.mjs install`.
- **Registry-free**: `npm install -g github:shamusj-create/opencode-longrun-harness` — the same package
  straight from this repository, with no registry involved.
- **Manual or air-gapped**: copy `harness/plugin/longrun.js` to `~/.config/opencode/plugins/longrun.js`.
  OpenCode auto-loads every file in that directory, so no `opencode.json` entry is required.
- **`opencode plugin <module>` is not a general-purpose installer** — it resolves npm *registry* packages,
  and a `github:` specifier fails with `NpmInstallFailedError`. Use `longrun-harness install` instead.

</details>

### 2. Check the install

```sh
longrun-harness doctor                                      # managed paths, manifest, local edits
~/.config/opencode/longrun-harness/longrun doctor --live    # has a live host actually loaded it?
```

The two are deliberately different checks. The first confirms every managed path is present and tells you
which ones you have edited by hand — local edits are reported and preserved, never silently overwritten.
It is an ownership check, not a cryptographic one.

The second reads the load records the plugin writes and requires a live process, so before you restart it
reports `AWAITING_RESTART` / `NOT_VERIFIED` with the reason. It answers "is this *actually loaded*", not
"is this on disk" — a `NOT_VERIFIED` immediately after install is expected; a persistent one is not.

### 3. Declare a contract and start a run

The contract *is* the acceptance definition, so write it before work begins. Inside an OpenCode session
the model starts the run natively:

```jsonc
// longrun action=start
{
  "request": "Add password reset to the accounts service",
  "criteria": [
    { "id": "API",   "required": true, "weight": 1, "checks": ["c-api-tests"],  "evidenceClass": "INTEGRATION" },
    { "id": "UI",    "required": true, "weight": 1, "checks": ["c-ui-e2e"],     "evidenceClass": "BROWSER" },
    { "id": "ENG",   "required": true, "weight": 1, "checks": ["c-typecheck", "c-build"] }
  ],
  "checkCatalogue": {
    "c-api-tests": { "command": ["npm", "run", "test:api"],        "kind": "cmd", "timeoutMs": 300000 },
    "c-ui-e2e":    { "command": ["npx", "playwright", "test"],    "kind": "cmd", "timeoutMs": 600000 },
    "c-typecheck": { "command": ["npx", "tsc", "--noEmit"],       "kind": "cmd", "timeoutMs": 180000 },
    "c-build":     { "command": ["npm", "run", "build"],          "kind": "cmd", "timeoutMs": 300000 }
  },
  "budgets": { "candidateBudget": 40, "timeBudgetHours": 6, "deadlineHours": 24 },
  "autoContinue": false
}
```

Rules worth knowing up front: criteria and checks are treated as **fixed** once the run starts; `loss`
falls only when a declared check records a PASS **on the current source**; and the model must never
edit code after recording a receipt without re-recording it.

### 4. Work, recording checks as they pass

Record **one check at a time**, as soon as it passes, so partial progress survives a compaction — and run
the broadest gate **last**, because any later edit invalidates every receipt recorded before it:

```
longrun_verify(runId=…, checkId="c-typecheck")
longrun_verify(runId=…, checkId="c-api-tests")
longrun_verify(runId=…, checkId="c-ui-e2e")
longrun_verify(runId=…, checkId="c-build")        # or a single all-in-one gate last
```

### 5. Watch progress from the operator side

```sh
longrun status --json --project /path/to/repo --run lr-…
```

Shows canonical lifecycle, loss, per-criterion state, check status, budgets, stale evidence and review
state. `receipts` pages through history; `audit-receipts.mjs` audits it independently.

### 6. If a budget or deadline genuinely runs out

An operator (not the model) can grant more, append-only, on a paused run:

```sh
longrun amend --additional-candidates 20 --new-deadline 2026-09-29T12:00:00+01:00 \
  --amendment-id op-amend-01 --expected-basis HASH --expected-revision N \
  --authorization-file auth.txt --reason-file reason.txt
```

This preserves the original limits, usage, receipts and history, and never resumes the run.

### 7. Review, then complete

Completion is a two-key operation. When every declared check is PASS on one fingerprint, the operator
records the independent decision:

```sh
longrun review --verdict accept --expected-basis HASH \
  --review-id review-20260926T2015Z --reason-file reason.txt
```

Only then can the model call `longrun action=complete`. Rejecting a premature completion leaves the run
paused with its history intact.

### 8. Optional: prove your tests can fail

For a materially risky assertion, run a **negative control**: copy the reviewed source to an isolated
fixture, introduce exactly one deliberate defect there, and confirm the *unchanged* assertion fails for
that defect. Fixtures that overlap the real project are refused, and a timeout/launch failure/zero tests
are classified as invalid execution rather than as the expected FAIL.

### Configure for your project

The harness is not tied to one local model setup. Everything below defaults to the environment it was
developed against, and is overridable:

| Variable | Meaning | Default |
| --- | --- | --- |
| `LONGRUN_REQUIRED_MODEL` | The single model id the served endpoint must expose | `mtplx-flash-next-optimized-speed` |
| `LONGRUN_REQUIRED_PROVIDER_MODEL` | The provider-qualified model passed to OpenCode | `mtplx/mtplx-flash-next-optimized-speed` |
| `LONGRUN_OPENCODE_BIN` | The OpenCode binary to dispatch | `/opt/homebrew/bin/opencode` |
| `LONGRUN_RUNTIME_MATCHER` | Regex identifying the model server's runtime when discovering its listening port | matches the bundled local runtime |
| `LONGRUN_MODEL_BASE` | Pin the inference base URL explicitly | discovered, then config, then default |

`harness/commissioning/` holds **case scripts** from one specific commissioning exercise — they contain
that case's numbers and are not generic tools.

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
| Recovery runner | `harness/tools/recovery-runner.mjs` | Operator-side supervised dispatch: discovers the live model endpoint, verifies the single served model before every dispatch, resumes a stuck run with bounded attempts, refuses to credit a no-op, settles a compaction-ended turn to a controlled `PAUSED`, treats a terminal run as an ending rather than a failure, and hands a run to a fresh reduced-context conversation. |
| Receipt auditor | `harness/tools/audit-receipts.mjs` | Independently audits receipts for substituted commands, contract mismatch, PASS-with-non-zero-exit, backdating and freshness. |

---

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

## Test

```sh
npm test        # node --test harness/test/*.test.mjs
```

**287 tests across 38 files, all passing.** These are offline tests against fixtures and mock
sessions: they are deliberately *not* treated as proof that a real OpenCode host behaves a certain
way, and they never touch production state.

---

## Verified status, honestly

- **Offline suite:** 287 passing tests covering identity keying, loss integrity, receipt eligibility
  and staleness, single-flight scheduling, resume authorization, stall/replan/pause, budget
  amendment, completion review, negative-control isolation, memory, endpoint discovery, configurable
  toolchain resolution, and the recovery runner.
- **Real host behaviour** has been exercised in separate, dated commissioning work: lifecycle
  transitions end-to-end, a real compaction with supervised recovery, and full-stack trial runs driven
  to `COMPLETE`. Those are recorded in the release reports below rather than reproduced here.
- **Used in anger:** this harness drove six `COMPLETE` runs building a real browser game — mouse-only
  interaction, smooth movement, board rotation and panning, ability targeting, audio, combat legibility
  and effect work — each gated by its own declared checks on a frozen source fingerprint plus an
  independent operator review. Several runs were extended only through the operator amendment path when
  a budget or deadline genuinely ran out, and one was refused completion until an operator accepted the
  evidence. The failures it caught included a test that was green while the feature it named was
  unreachable, and a flaky acceptance gate that a lucky green pair would otherwise have hidden.
- **Known limits, by design:** total host activity (model inference, ordinary tools) is **not**
  metered — budgets cover declared-check execution; automatic continuation is **OFF**; compaction
  recovery is **supervised**, not autonomous; a run parked with no progress is stopped rather than
  looping; and this is an auditable workflow boundary, **not** an OS sandbox against arbitrary
  state-file access.

## Release reports

- [v1.2.22 — evidence-class derivation](docs/V1.2.22_EVIDENCE.md)
- [v1.2.21 — negative-fixture anchoring](docs/V1.2.21_EVIDENCE.md)
- [v1.2.20 — audited operator budget amendment](docs/V1.2.20_EVIDENCE.md)

## Tested setup

The harness is developed and driven against a **fully local** toolchain — no cloud model is involved at any
point. This is the configuration it has actually been exercised on:

| Component | Tested version | Notes |
| --- | --- | --- |
| macOS | 27.0, Apple Silicon | Desktop and CLI OpenCode |
| Node.js | 24.21.0 | Floor is `>= 22`; no third-party runtime dependencies |
| OpenCode | 1.18.32 | Both the CLI dispatch path and the desktop plugin host |
| MTPLX | 2.12.0 | Local OpenAI-compatible inference server (`com.youssofal.mtplx`) |
| Qwen model | `mtplx-flash-next-optimized-speed` | The one model id MTPLX serves — 262k context |

Put concretely: **MTPLX serves a single local Qwen model, and OpenCode is pointed at it as
`mtplx/mtplx-flash-next-optimized-speed`.** Every implementation, test and patch behind the release reports
was generated by that local model. The harness gates the *evidence*; the model that produced the code is
verified at dispatch.

Two defaults exist because this setup forced them, and both are worth knowing before you point the harness
at your own server:

- **The endpoint is discovered, not assumed.** A workstation can have more than one server on the usual
  inference ports. During testing the expected port was held by a *different* runtime serving entirely
  different models, while MTPLX listened elsewhere. A pinned port would have dispatched against the wrong
  server — so the harness enumerates candidate listeners, asks each what it serves, and accepts only the
  one exposing the required model id.
- **The served model is verified.** A mismatch is otherwise silent, so dispatch confirms that the endpoint
  really serves the configured model id *and* that OpenCode is configured for the matching provider model.
  A server that ignores the requested model is a genuine failure mode here, not a hypothetical one.

None of this is a requirement on you: MTPLX and Qwen are simply what this was validated with. The model id,
provider model, OpenCode binary and runtime matcher are all `LONGRUN_*` settings (see above), so any
OpenAI-compatible local server can take their place.

## Requirements

- **Node.js >= 22** (validated on 24.21.0) — Node builtins only, no third-party runtime dependencies.
- **OpenCode**, desktop or CLI, as the plugin host.
- **A local OpenAI-compatible inference server** exposing a single model id, with that model selected in
  your OpenCode configuration. See [Tested setup](#tested-setup) for what this was validated against.

## License

[MIT](LICENSE) — use it, fork it, change it, ship it. Contributions and issues are welcome.
