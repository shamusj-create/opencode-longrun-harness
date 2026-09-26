import { reviewProjectFixture } from "./helper.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as C from '../src/controller.js';
process.env.LONGRUN_TEST = '1';
process.env.LONGRUN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(),'lr124-state-'));
process.env.LONGRUN_CONTROLLER_FILE = path.resolve(import.meta.dirname,'../src/controller.js');
const plugin = await import('../plugin/longrun.js');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'lr124-project-'));
const write = (d,p,s) => { fs.mkdirSync(path.dirname(path.join(d,p)),{recursive:true}); fs.writeFileSync(path.join(d,p),s); };
const rc = (id, fp, exitCode=0, extra={}) => C.makeReceipt({checkId:id,command:'assertions',sourceFingerprint:fp,exitCode,startedAt:1,finishedAt:2,...extra});
const run = () => ({runId:'fixture',status:'VERIFYING',sourceFingerprint:'a',receipts:[],state:{},contract:{criteria:['one','two'].map(id=>({id,required:true,checks:[id]})),gates:[],lossTarget:0}});

test('canonical loss replays 1 -> .5 -> 0 -> .5; cached best/current cannot manufacture zero',()=>{
 const r=run();
 assert.equal(C.deriveRunView(r).currentLoss,1);
 C.applyVerification(r,{receipt:rc('one','a')}); assert.equal(C.deriveRunView(r).currentLoss,.5);
 C.applyVerification(r,{receipt:rc('two','a')}); assert.equal(C.deriveRunView(r).bestLoss,0);
 C.applyVerification(r,{receipt:rc('two','a',1,{finishedAt:3})});
 const v=C.deriveRunView(r); assert.equal(v.currentLoss,.5);assert.equal(v.bestLoss,0);
 r.state.best={loss:-100};r.state.current={loss:-100};assert.equal(C.deriveRunView(r).bestLoss,0);
 const missing=run();missing.state.best={loss:0};assert.equal(C.deriveRunView(missing).bestLoss,1);
});
test('hard gate only can block with weighted loss zero',()=>{
 const r=run();r.receipts=[rc('one','a'),rc('two','a')];r.contract.gates=[{id:'build',checks:['build'],required:true}];
 const v=C.deriveRunView(r);assert.equal(v.currentLoss,0);assert.equal(v.completionBlocked,true);assert.deepEqual(v.hardGateBlockers.map(g=>g.id),['build']);
});
test('missing legacy fingerprint is retained, labelled, and genuinely superseded',()=>{
 const r=run();r.receipts=[rc('one',undefined)];const before=JSON.stringify(r.receipts);
 let v=C.deriveRunView(r);const d=v.checks.find(c=>c.checkId==='one');
 assert.equal(d.staleReason,'LEGACY_STALE_MISSING_FINGERPRINT');assert.equal(d.effectiveReceipt,null);assert.equal(d.historicalReceipts[0].missingField,'sourceFingerprint');
 assert.equal(JSON.stringify(r.receipts),before);
 C.applyVerification(r,{receipt:rc('one','a',0,{finishedAt:3})});v=C.deriveRunView(r);
 assert.equal(v.checks[0].effectiveStatus,'PASS');assert.equal(v.checks[0].historicalReceiptCount,2);assert.equal(JSON.stringify(r.receipts.slice(0,1)),before);
});
test('contract/evaluator mismatch and negative controls cannot supply current PASS',()=>{
 const r=run();r.contractHash='contract';r.evaluatorHash='evaluator';
 r.receipts=[rc('one','a',0,{contractHash:'old'})];assert.equal(C.deriveRunView(r).checks[0].staleReason,'CONTRACT_MISMATCH');
 r.receipts=[rc('one','a',0,{contractHash:'contract',evaluatorHash:'old'})];assert.equal(C.deriveRunView(r).checks[0].staleReason,'EVALUATOR_MISMATCH');
 r.receipts=[rc('one','a',0,{contractHash:'contract',evaluatorHash:'evaluator'}),{...rc('one','a',1,{finishedAt:3}),mode:'negative'}];assert.equal(C.deriveRunView(r).checks[0].effectiveStatus,'PASS');
});
test('fingerprints exclude generated evidence/checkpoints/harness outputs but include app/test/config edits',()=>{
 const d=temp();write(d,'src/app.ts','export const a=1');write(d,'package.json','{}');
 const base=C.sourceFingerprint(d);
 for(const p of ['.longrun/events.log','docs/CHECKPOINT.md','artifacts/screen.png','artifacts/receipt.json','test-results/x.json','packages/web/dist/index.html','longrun-harness/releases/x/controller.js'])write(d,p,'generated');
 assert.equal(C.sourceFingerprint(d).hash,base.hash);assert.notEqual(C.sourceFingerprint(d).legacyHash,base.legacyHash);
 for(const p of ['src/app.ts','test/app.test.ts','package.json']){const old=C.sourceFingerprint(d).hash;write(d,p,'changed');assert.notEqual(C.sourceFingerprint(d).hash,old);}
});
test('fingerprint policy migration recognizes only observed legacy identity; revisiting a candidate is not new',()=>{
 const r=run();r.state.lastEvalFingerprint='old';
 const receipt=rc('one','new',0,{fingerprintSchemaVersion:2});
 const a=C.applyVerification(r,{receipt,currentFingerprint:{hash:'new',legacyHash:'old'}});assert.equal(a.counted,false);
 assert.equal(C.applyVerification(r,{receipt:rc('one','new',0,{fingerprintSchemaVersion:2}),currentFingerprint:{hash:'new',legacyHash:'metadata-changed'}}).counted,false);
 C.applyVerification(r,{receipt:rc('one','b')});C.applyVerification(r,{receipt:rc('one','c')});
 const n=C.candidateCount(r);C.applyVerification(r,{receipt:rc('one','b')});assert.equal(C.candidateCount(r),n);
});
test('memory generator upgrade stays fresh; ordinary edit stays fresh; precise entry change and refresh',()=>{
 const d=temp();write(d,'package.json','{}');write(d,'src/index.ts','export const x=1');write(d,'src/body.ts','export const b=1');
 C.memory.initDeep(d,{harnessVersion:'1.2.2'});const index=C.memory.readMemoryIndex(d);index.harnessVersion='1.2.2';
 assert.equal(C.memory.assessStaleness(d,index).status,'FRESH');write(d,'src/body.ts','export const b=2');assert.equal(C.memory.assessStaleness(d,index).status,'FRESH');
 write(d,'src/index.ts','export const x=2');const v=C.memory.assessStaleness(d,index);assert.equal(v.status,'STALE');assert.ok(v.changedDependencies.some(x=>x.path==='src/index.ts' && x.previousFingerprint!==x.currentFingerprint));
 C.memory.initDeep(d,{harnessVersion:'1.2.4'});assert.equal(C.memory.assessStaleness(d,C.memory.readMemoryIndex(d)).status,'FRESH');
});
test('old memory digest mismatch is honest about absent path history and schema mismatch',()=>{
 const d=temp();write(d,'package.json','{}');C.memory.initDeep(d,{harnessVersion:'1.2.2'});const index=C.memory.readMemoryIndex(d);delete index.structuralDependencies;
 write(d,'package.json','{"scripts":{"test":"node --test"}}');let v=C.memory.assessStaleness(d,index);
 assert.ok(v.changedDependencies.some(x=>x.reason==='LEGACY_STRUCTURAL_DIGEST_CHANGED' && x.exactPathsKnown===false));
 index.memorySchemaVersion=99;v=C.memory.assessStaleness(d,index);assert.ok(v.changedDependencies.some(x=>x.reason==='MEMORY_SCHEMA_INCOMPATIBLE'));
});
async function seed(r,d) {
 const sd=fs.mkdtempSync(path.join(os.tmpdir(),'lr124-store-'));process.env.LONGRUN_STATE_DIR=sd;
 const key=C.stateKey(C.projectIdentity(d),r.runId);r.directory=d;const store=new C.Store(sd);store.writeJSON(key,'run.json',r);
 fs.writeFileSync(path.join(sd,'runs.json'),JSON.stringify({offline:{runKey:key,directory:d,runId:r.runId,checkCatalogue:r.checkCatalogue}}));
 const hooks=await plugin.default.server({client:null});
 const t=hooks.tool,ctx={sessionID:'offline',directory:d,worktree:d};
 const call=async action=>{const text=await t.longrun.execute({action,runId:r.runId},ctx);try{return JSON.parse(text)}catch{return text}};
 return {t,ctx,call,store,key,hooks};
}
test('compaction recovery matches explicit recovery after source and memory dependencies change',async(testContext)=>{
 const d=temp();write(d,'src/index.ts','export const value=1');write(d,'package.json','{}');
 C.memory.initDeep(d,{harnessVersion:'1.2.4'});
 const r=run();r.checkCatalogue={one:{kind:'cmd',command:[process.execPath,'-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('src/index.ts','utf8'),'export const value=1')"]}};
 const {t,ctx,call,store,key,hooks}=await seed(r,d);
 assert.equal(JSON.parse(await t.longrun_verify.execute({checkId:'one',runId:r.runId},ctx)).status,'PASS');
 write(d,'src/index.ts','export const value=2');
 const before=store.readJSON(key,'run.json');
 const observedAt=Date.now();testContext.mock.method(Date,'now',()=>observedAt); // compare the same observation, including live deadline timing
 const packet=await call('resume-context');
 assert.match(packet,/CURRENT LOSS: 1/);assert.match(packet,/MEMORY STATUS: STALE/);
 const output={context:['existing host context']};
 await hooks['experimental.session.compacting']({sessionID:'offline'},output);
 assert.equal(output.context.length,2);
 assert.equal(output.context[0],'existing host context');
 assert.match(output.context[1],/^## Long-run recovery\nPRE-COMPACTION SNAPSHOT:/);
 assert.ok(output.context[1].endsWith(packet));
 assert.deepEqual(store.readJSON(key,'run.json'),before,'compaction must not rewrite ledger or fingerprints');
});
test('real recorded receipt fixture: 18 stale plus 4 absent, 36 retained, 13 candidates and contract untouched across tool projections',async(t)=>{
 const r=JSON.parse(fs.readFileSync(new URL('./fixtures/example-app-run.json',import.meta.url)));const original=JSON.stringify(r.contract), receipts=JSON.stringify(r.receipts),budget=JSON.stringify(r.budget);
 assert.equal(r.receipts.length,36);assert.ok(r.receipts.every(x=>x.sourceFingerprint));
 const d=temp();write(d,'app.ts','isolated fixture');const {call,store,key}=await seed(r,d);
 const observedAt=Date.now();t.mock.method(Date,'now',()=>observedAt); // stable clock for exact projection equality
 const status=await call('status'),verify=await call('verify'),complete=await call('complete');
 for(const k of ['currentLoss','bestLoss','targetLoss','memoryStatus','candidateCount','budgets','criterionStates','hardGateBlockers','evidenceGaps','completionBlocked']){assert.deepEqual(status[k],verify[k]);assert.deepEqual(status[k],complete[k]);}
 assert.equal(status.candidateCount,13);assert.equal(status.currentLoss,1);assert.equal(status.staleEvidence.length,18);assert.equal(status.historicalReceiptCount,36);assert.equal(status.completionBlocked,true);
 assert.deepEqual(status.checks.filter(x=>x.blockingReason==='NO_RECEIPT').map(x=>x.checkId), ['c-detect-e2e','c-sec-e2e','c-ai-e2e','c-mission-e2e']);
 assert.ok(status.staleEvidence.every(x=>x.staleReason==='SOURCE_FINGERPRINT_MISMATCH'));
 for(const a of ['next','resume-context']){const packet=await call(a);assert.match(packet,/CURRENT LOSS: 1/);assert.match(packet,/HISTORICAL RECEIPTS: 36/);assert.ok(packet.includes(`BEST LOSS: ${status.bestLoss}`));}
 assert.equal((await call('memory_status')).status,status.memoryStatus);
 await call('checkpoint');assert.deepEqual(C.summarizeRunView(store.readJSON(key,'checkpoint.json').view),status);
 const after=store.readJSON(key,'run.json');assert.equal(JSON.stringify(after.contract),original);assert.equal(JSON.stringify(after.receipts),receipts);assert.equal(JSON.stringify(after.budget),budget);
});
test('actual declared assertion receipt clears a legacy block without contract changes; current failure reblocks',async()=>{
 const d=temp();write(d,'app.txt','valid');
 const r=run();r.contract.criteria=[{id:'one',required:true,checks:['one']}];r.contract.gates=[{id:'one',required:true}];
 r.checkCatalogue={one:{kind:'cmd',command:['node','-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('app.txt','utf8'),'valid')"]}};
 r.receipts=[rc('one',undefined)];const original=JSON.stringify(r.contract);const {call,t,ctx,store,key}=await seed(r,d);
 assert.equal((await call('complete')).complete,false);
 const v=JSON.parse(await t.longrun_verify.execute({checkId:'one',runId:r.runId},ctx));assert.equal(v.status,'PASS');assert.equal((await call('status')).currentLoss,0);
 write(d,'app.txt','broken');assert.equal(JSON.parse(await t.longrun_verify.execute({checkId:'one',runId:r.runId},ctx)).status,'FAIL');assert.equal((await call('complete')).complete,false);
 write(d,'app.txt','valid');await t.longrun_verify.execute({checkId:'one',runId:r.runId},ctx);reviewProjectFixture(d,r.runId);assert.equal((await call('complete')).complete,true);
 const saved=store.readJSON(key,'run.json');assert.equal(JSON.stringify(saved.contract),original);assert.equal(saved.receipts.length,4);
});

test('source changed during verifier execution cannot generate a current PASS',async()=>{
 const d=temp();write(d,'app.txt','valid');const r=run();r.checkCatalogue={one:{kind:'cmd',command:['node','-e',"require('node:fs').writeFileSync('app.txt','changed')"]}};
 const {t,ctx,call}=await seed(r,d);
 const result=JSON.parse(await t.longrun_verify.execute({checkId:'one',runId:r.runId},ctx));assert.equal(result.status,'STALE');
 assert.equal((await call('complete')).complete,false);
});
test('missing receipts never inherit cached PASS, including gate-only checks',()=>{
 const r=run();r.contract.criteria.forEach(c=>c.status='PASS');r.checkCatalogue={build:{command:['node','build.js']}};r.contract.gates=[{id:'build',required:true,status:'PASS'}];
 const v=C.deriveRunView(r);assert.equal(v.currentLoss,1);assert.equal(v.gates[0].status,'NOT_RUN');assert.equal(v.completionBlocked,true);
});
test('schema migration cannot invent a fingerprint for a legacy PASS',()=>{
 const r=run();r.receipts=[rc('one','old-hash')];
 const diag=C.checkDiagnostics(r,'one',{hash:'new-hash',legacyHash:'old-hash',schemaVersion:2});assert.equal(diag.effectiveStatus,'PASS');assert.equal(diag.receiptFingerprint,'old-hash');
 assert.equal(C.checkDiagnostics(r,'one',{hash:'new-hash',legacyHash:'different'}).effectiveStatus,'STALE');
});
test('explicit unknown control-plane run cannot complete or pause the current run',async()=>{
 const d=temp(),r=run();const {t,ctx,store,key}=await seed(r,d);
 for(const action of ['status','complete','pause'])assert.equal(JSON.parse(await t.longrun.execute({action,runId:'wrong'},ctx)).state,'NO_RUN');
 assert.equal(store.readJSON(key,'run.json').status,'VERIFYING');
});
