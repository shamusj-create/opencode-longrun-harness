import { test } from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import { spawnSync } from 'node:child_process';import { pathToFileURL } from 'node:url';
import { install,VERSION } from '../src/install.mjs';
process.env.LONGRUN_TEST='1';
process.env.LONGRUN_STATE_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'lr124-installed-state-'));
delete process.env.LONGRUN_CONTROLLER_FILE;
test('installed artifact executes canonical v1.2.4 independently of source and preserves unrelated JSONC',async(t)=>{
 const config=fs.mkdtempSync(path.join(os.tmpdir(),'lr124-config-')),project=fs.mkdtempSync(path.join(os.tmpdir(),'lr124-installed-project-'));
 fs.writeFileSync(path.join(project,'value.txt'),'tested');
 const jsonc='// keep comments\n{"model":"unchanged/provider","permission":"ask"}\n';fs.writeFileSync(path.join(config,'opencode.jsonc'),jsonc);fs.mkdirSync(path.join(config,'plugins'));fs.writeFileSync(path.join(config,'plugins/unrelated.js'),'// unrelated\n');
 assert.equal(install({configDir:config}).conflicts.length,0);
 assert.equal(fs.readFileSync(path.join(config,'opencode.jsonc'),'utf8'),jsonc);
 const pluginPath=path.join(config,'plugins/longrun.js'),module=await import(pathToFileURL(pluginPath));assert.deepEqual(Object.keys(module),['default']);assert.equal(module.default.id,'longrun');
 assert.ok(fs.readFileSync(pluginPath,'utf8').includes(`/releases/${VERSION}/lib/controller.js`));
 const hooks=await module.default.server({client:null});
 const tools=hooks.tool,ctx={sessionID:'isolated',directory:project,worktree:project};
 const call=async args=>JSON.parse(await tools.longrun.execute(args,ctx));
 assert.equal((await call({action:'help'})).harnessVersion,VERSION);
 const command=['node','-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'tested')"];
 const start=await call({action:'start',request:'Verify installed assertion',criteria:[{id:'assertion',checks:['assertion']}],checkCatalogue:{assertion:{command,kind:'cmd'}}});
 assert.ok(start.runId,JSON.stringify(start));
 const saved=await call({action:'checkpoint',runId:start.runId,progress:{currentSlice:'installed recovery',nextAction:'execute declared assertion'}});
 assert.equal(saved.checkpointed,true);
 assert.match(await tools.longrun.execute({action:'resume-context',runId:start.runId},ctx),/NEXT ACTION: execute declared assertion/);
 assert.equal(JSON.parse(await tools.longrun_verify.execute({runId:start.runId,checkId:'assertion'},ctx)).status,'PASS');
 assert.equal((await call({action:'complete'})).blockReason,'completion_review_required');
 await tools.longrun.execute({action:'pause',runId:start.runId},ctx);
 const pending=await call({action:'status'});
 const reasonFile=path.join(config,'review-reason.txt');fs.writeFileSync(reasonFile,'Independent isolated installed-artifact review.');
 const env={...process.env,OPENCODE_CONFIG_DIR:config};delete env.LONGRUN_CONTROLLER_FILE;delete env.NODE_TEST_CONTEXT;
 const review=spawnSync(path.join(config,'longrun-harness/longrun'),['review','--project',project,'--run',start.runId,'--verdict','accept','--expected-basis',pending.completionReview.basis,'--review-id','installed-review','--reason-file',reasonFile,'--json'],{cwd:os.tmpdir(),env,encoding:'utf8'});
 assert.equal(review.status,0,review.stdout+review.stderr);assert.equal(JSON.parse(review.stdout).completionReview.status,'ACCEPTED');
 const status=await call({action:'status'}),verify=await call({action:'verify'}),complete=await call({action:'complete'});
 for(const key of ['currentLoss','bestLoss','targetLoss','candidateCount','memoryStatus','completionBlocked','hardGateBlockers','evidenceGaps']){assert.deepEqual(verify[key],status[key]);assert.deepEqual(complete[key],status[key]);}
 assert.equal(complete.complete,true);

 const doctor=spawnSync(path.join(config,'longrun-harness/longrun'),['doctor','--json'],{cwd:project,env,encoding:'utf8'});
 assert.equal(doctor.status,0,doctor.stdout+doctor.stderr);const report=JSON.parse(doctor.stdout);assert.equal(report.installedVersion,VERSION);assert.equal(report.ok,true);assert.equal(report.executedControllerVersion,VERSION);
 const cli=spawnSync(path.join(config,'longrun-harness/longrun'),['status','--project',project,'--run',start.runId,'--json'],{cwd:project,env,encoding:'utf8'});
 assert.equal(cli.status,0,cli.stdout+cli.stderr);const cliView=JSON.parse(cli.stdout);assert.equal(cliView.currentLoss,status.currentLoss);assert.equal(cliView.bestLoss,status.bestLoss);assert.equal(cliView.memoryStatus,status.memoryStatus);
 fs.writeFileSync(path.join(project,'value.txt'),'changed after verification');
 const observedAt=Date.now();t.mock.method(Date,'now',()=>observedAt); // both recovery paths observe the same deadline instant
 const packet=await tools.longrun.execute({action:'resume-context',runId:start.runId},ctx);
 assert.match(packet,/CURRENT LOSS: 1/);
 const output={context:[]};await hooks['experimental.session.compacting']({sessionID:'isolated'},output);
 assert.equal(output.context.length,1);
 assert.match(output.context[0],/^## Long-run recovery\nPRE-COMPACTION SNAPSHOT:/);
 assert.ok(output.context[0].endsWith(packet));
});
