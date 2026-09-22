// Runs only the declared engineering commands, against a physically separate application copy.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import net from 'node:net';
const caseRoot=process.argv[2];assert.ok(caseRoot && fs.existsSync(path.join(caseRoot,'case.json')));
const game=path.join(caseRoot,'game-verify'),sd=path.join(caseRoot,'state-verify'), tmp=path.join(caseRoot,'temp');
assert.ok(!fs.existsSync(game),'verification copy already exists; use a new isolated case');
fs.cpSync(path.join(caseRoot,'game'),game,{recursive:true,verbatimSymlinks:true});fs.mkdirSync(sd);fs.mkdirSync(tmp);
for(const p of [55199,58787]) await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(p,'127.0.0.1',()=>s.close(resolve));});
const config=path.join(game,'playwright.config.ts'),vite=path.join(game,'packages/web/vite.config.ts'),script=path.join(game,'scripts/verify-all.sh');
fs.writeFileSync(config,fs.readFileSync(config,'utf8').replaceAll('5199','55199').replaceAll('8787','58787').replaceAll('reuseExistingServer: true','reuseExistingServer: false'));
fs.writeFileSync(vite,fs.readFileSync(vite,'utf8').replaceAll('8787','58787'));
fs.writeFileSync(script,fs.readFileSync(script,'utf8').replace('/tmp/sb-build.log',path.join(caseRoot,'sb-build.log')).replace('set -u',`set -u\nexec > '${path.join(caseRoot,'verify-all.log')}' 2>&1`));
process.env.LONGRUN_TEST='1';process.env.LONGRUN_STATE_DIR=sd;process.env.LONGRUN_CONTROLLER_FILE=path.resolve('harness/src/controller.js');
process.env.SB_PORT='58787';process.env.SB_DB=path.join(game,'.longrun','test.sqlite');process.env.TMPDIR=tmp;
const C=await import('../src/controller.js');const P=await import('../plugin/longrun.js');
const original=JSON.parse(fs.readFileSync(path.join(caseRoot,'state-original/state/982e1f79cff6bc710465d3704c7a947e/run.json')));
const run=structuredClone(original);run.directory=game;
const key=C.stateKey(C.projectIdentity(game),run.runId),store=new C.Store(sd);store.writeJSON(key,'run.json',run);
fs.writeFileSync(path.join(sd,'runs.json'),JSON.stringify({offline:{runKey:key,directory:game,runId:run.runId,checkCatalogue:run.checkCatalogue}}));
const t=(await P.default.server({client:null})).tool,ctx={sessionID:'offline',directory:game,worktree:game};
const read=async action=>JSON.parse(await t.longrun.execute({action,runId:run.runId},ctx));
const before=await read('status');const resumed=await read('resume');assert.equal(resumed.runId,run.runId);
const results=[];
for(const checkId of ['c-typecheck','c-build','c-verify-all']) {
 console.log(`Running copied ${checkId}`);
 const result=JSON.parse(await t.longrun_verify.execute({checkId,runId:run.runId,evidenceClass:'INTEGRATION'},ctx));results.push({checkId,...result});
 console.log(JSON.stringify(results.at(-1)));
}
const after=await read('status'),completion=await read('complete'),saved=store.readJSON(key,'run.json');
assert.deepEqual(saved.contract,original.contract);assert.deepEqual(saved.budget,original.budget);assert.deepEqual(saved.state.candidates.slice(0,13),original.state.candidates);
assert.deepEqual(saved.receipts.slice(0,36),original.receipts);assert.equal(saved.receipts.length,39);
assert.equal(completion.complete,false,'other missing/stale evidence must continue blocking');
assert.deepEqual(after.hardGateBlockers,[]);assert.equal(after.currentLoss,10/11);
const report={kind:'OFFLINE_TOOL_FACTORY_REAL_COPIED_APPLICATION',adaptations:['copied directory and routing key','Playwright ports 55199/58787 and reuseExistingServer false','Vite proxy port 58787','SB_DB inside copy/.longrun/test.sqlite','temporary output/log paths'],before,results,after,completion};
fs.writeFileSync(path.join(caseRoot,'three-gates.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({report:path.join(caseRoot,'three-gates.json'),candidateCount:after.candidateCount,loss:after.currentLoss,bestLoss:after.bestLoss,remaining:after.remaining,complete:completion.complete}));
