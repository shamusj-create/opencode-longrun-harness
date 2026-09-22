import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as C from "../src/controller.js";

// Disposable task-list app. The acceptance runner is a PLAIN `node` program (NOT `node --test`)
// so it can be spawned honestly: nesting `node --test` inside a `node --test` worker makes the
// child emit no result + exit 0 (a runner artifact, verified). A plain self-checking runner keeps
// REAL command execution + real test counts and does not depend on that artifact. Receipts come
// from actual command execution (exit code + reported counts), not caller-supplied PASS flags.
// This proves harness MECHANICS + integrity; the Qwen-autonomous repair in a live desktop run is
// a separate, non-faked step.

const DEFECTIVE = `
export class TaskStore {
  constructor(file){ this.file=file; }
  add(title){ this.list=this.list||[]; this.list.push({title}); return {ok:true,tasks:this.list}; } // no validation, no persistence, hides errors
}
`;
const FIXED = `
import fs from "node:fs";
export class TaskStore {
  constructor(file){ this.file=file; this.load(); }
  load(){ try { this.list = JSON.parse(fs.readFileSync(this.file,"utf8")); } catch { this.list = []; } }
  add(title){
    if (typeof title !== "string" || title.trim()==="") return {ok:false, error:"empty_title"};
    this.list.push({ title: title.trim(), id: String(this.list.length+1) });
    fs.writeFileSync(this.file, JSON.stringify(this.list));
    return {ok:true, tasks:this.list};
  }
}
`;
// The protected acceptance runner: 4 checks; exit 0 only if all pass; prints counts.
const RUNNER = `
import { TaskStore } from "./app.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass=0, fail=0;
const chk=(n,fn)=>{ try{ fn(); pass++; }catch(e){ fail++; console.log("FAIL",n,String(e&&e.message||e)); } };
const tmp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),"a-"));return path.join(d,"d.json");};
chk("c1-valid-creates", ()=>{ const f=tmp(); const r=new TaskStore(f).add("Buy milk"); if(!(r.ok && r.tasks.some(t=>t.title==="Buy milk"))) throw new Error("not created"); });
chk("c2-empty-rejected", ()=>{ const r=new TaskStore(tmp()).add("   "); if(!(r.ok===false && r.error==="empty_title")) throw new Error("empty accepted"); });
chk("c3-persist-restart", ()=>{ const f=tmp(); new TaskStore(f).add("Persist me"); const s2=new TaskStore(f); if(!(s2.list && s2.list.some(t=>t.title==="Persist me"))) throw new Error("did not persist"); });
chk("c4-honest-error", ()=>{ const r=new TaskStore(tmp()).add(""); if(!(r.ok===false && !!r.error)) throw new Error("false success"); });
console.log("RESULT pass="+pass+" fail="+fail+" total="+(pass+fail));
process.exit(fail===0 ? 0 : 1);
`;

function project(appSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repairdemo-"));
  fs.writeFileSync(path.join(dir, "app.mjs"), appSrc);
  fs.writeFileSync(path.join(dir, "run_acceptance.mjs"), RUNNER); // protected
  return dir;
}
function runAccept(dir) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["run_acceptance.mjs"], { cwd: dir, encoding: "utf8", timeout: 60000, env });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /RESULT pass=(\d+) fail=(\d+) total=(\d+)/.exec(out);
  return { exit: r.status, pass: m ? +m[1] : 0, fail: m ? +m[2] : 0, testCount: m ? +m[3] : 0, out };
}
function mkContract() {
  return { criteria: ["c1", "c2", "c3", "c4"].map(id => ({ id, required: true, checks: ["accept"], status: "FAIL", weight: 1 })),
           gates: [{ id: "test-gate", required: true, status: "PENDING" }], lossTarget: 0 };
}

test("repair mechanics: failing -> fix -> passing -> loss 1 -> 0 -> completion", () => {
  const dir = project(DEFECTIVE);
  const contract = mkContract();
  const r1run = runAccept(dir);
  assert.equal(r1run.exit, 1, "defective implementation fails acceptance (exit)");
  assert.equal(r1run.fail, 3, "exactly the 3 defective behaviours fail");
  const fp1 = C.sourceFingerprint(dir).hash;
  const rc1 = C.makeReceipt({ checkId: "accept", command: "node run_acceptance.mjs", exitCode: r1run.exit, output: r1run.out, testCount: r1run.testCount, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: fp1 });
  assert.equal(rc1.status, "FAIL");
  assert.ok(r1run.testCount > 0, "test command discovered tests (not a zero-test pass)");
  assert.equal(C.defaultLoss(contract).loss, 1, "initial loss is full");

  // APPLY FIX to the same protected tests; re-run PASSES; loss improves to 0.
  fs.writeFileSync(path.join(dir, "app.mjs"), FIXED);
  const r2run = runAccept(dir);
  assert.equal(r2run.exit, 0, "fixed implementation passes acceptance");
  assert.equal(r2run.pass, 4, "all 4 criteria now satisfied");
  const fp2 = C.sourceFingerprint(dir).hash;
  assert.notEqual(fp1, fp2, "source changed between runs");
  const rc2 = C.makeReceipt({ checkId: "accept", command: "node run_acceptance.mjs", exitCode: r2run.exit, output: r2run.out, testCount: r2run.testCount, requirementKind: "test", startedAt: 3, finishedAt: 4, sourceFingerprint: fp2 });
  assert.equal(rc2.status, "PASS");
  for (const c of contract.criteria) c.status = "PASS";
  contract.gates[0].status = "PASS";
  assert.equal(C.defaultLoss(contract).loss, 0, "loss reached target after a real fix");
  assert.equal(C.canComplete({ contract, state: {}, status: "VERIFYING" }).complete, true, "completion needs all required PASS + loss met");
});

test("staleness: edit after a PASS receipt invalidates it", () => {
  const dir = project(FIXED);
  const passRun = runAccept(dir);
  assert.equal(passRun.testCount, 4);
  const fpA = C.sourceFingerprint(dir).hash;
  const receipt = C.makeReceipt({ checkId: "accept", command: "node run_acceptance.mjs", exitCode: passRun.exit, output: "", testCount: passRun.testCount, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: fpA });
  assert.equal(receipt.status, "PASS");
  fs.writeFileSync(path.join(dir, "app.mjs"), DEFECTIVE); // regress after receipt
  const fpB = C.sourceFingerprint(dir).hash;
  assert.notEqual(fpA, fpB);
  assert.equal(C.resolveReceiptStatus(receipt, fpB), "STALE", "evidence must not survive a source change");
});

test("protected-runner integrity: weakening it is detected via fingerprint", () => {
  const dir = project(DEFECTIVE);
  const protectHash = C.sourceFingerprint(dir).hash;
  fs.writeFileSync(path.join(dir, "run_acceptance.mjs"), "// neutered: no checks\nconsole.log('ok');\n");
  assert.notEqual(protectHash, C.sourceFingerprint(dir).hash, "weakening a protected runner changes the fingerprint and is detectable");
});

test("a command with zero checks cannot satisfy a test requirement (NOT_RUN on exit 0)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notests-"));
  fs.writeFileSync(path.join(dir, "run_acceptance.mjs"), "console.log('RESULT pass=0 fail=0 total=0');\n");
  const r = spawnSync(process.execPath, ["run_acceptance.mjs"], { cwd: dir, encoding: "utf8" });
  const rc = C.makeReceipt({ checkId: "t", command: "node run_acceptance.mjs", exitCode: r.status, output: r.stdout, testCount: 0, requirementKind: "test", startedAt: 1, finishedAt: 2, sourceFingerprint: "x" });
  assert.equal(rc.status, "NOT_RUN", "exit 0 with zero checks is NOT_RUN");
});