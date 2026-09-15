import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImportJobs } from '../src/core/import-jobs.js';
import { CodexProjectBinding } from '../src/providers/codex/project-binding.js';
import { inspectImportTarget, IMPORT_TARGET_LOCK } from '../src/providers/codex/import-target.js';
import type { ImportRpc, RpcProfile } from '../src/providers/codex/app-server.js';
import { createIsolatedEnvironment } from '../scripts/lib/isolated-environment.mjs';

async function fixture(t: TestContext) {
  const scope = await createIsolatedEnvironment('watch-project-test-');
  t.after(() => scope.cleanup());
  const codexHome = path.join(scope.home, '.codex');
  const cwd = path.join(scope.root, 'project with spaces');
  await mkdir(path.join(codexHome, 'sessions'), { recursive: true, mode: 0o700 });
  await mkdir(cwd);
  const ref = { provider: 'codex', sessionId: randomUUID(), filePath: path.join(codexHome, 'sessions', 'synthetic.jsonl'), cwd };
  await writeFile(ref.filePath, 'synthetic');
  const jobs = new ImportJobs(path.join(scope.root, 'jobs'));
  const importId = await jobs.prepare({ schema: 1, route: 'claude-code-to-codex-official',
    source: { ...ref, provider: 'claude', sessionId: randomUUID() }, digest: {sha256:'fixture',sizeBytes:9},
    cliVersion: 'codex-cli 0.153.4', codexHome, home: scope.home, target: await inspectImportTarget(codexHome) });
  await jobs.save(importId, { status:'imported', target:ref });
  const project = { id:randomUUID(), name:'Synthetic project', roots:[{path:cwd}] };
  const thread = { id:ref.sessionId, cwd, path:ref.filePath, projectId:null as string|null, turns:[{items:[{text:'synthetic history'}]}] };
  const calls: {method:string;params:unknown}[]=[];
  const behavior = { loseAck:false, hidden:false, mutateHistory:false, sqliteHome:null as string|null };
  const rpc: ImportRpc = {
    request: async(method,params) => {
      calls.push({method,params});
      if (method==='config/read') return {config:{sqlite_home:behavior.sqliteHome}};
      if (method==='project/read') return {project};
      if (method==='thread/read') return {thread};
      if (method==='thread/list') return {data:thread.projectId===project.id && !behavior.hidden ? [{id:thread.id,cwd,projectId:project.id}] : []};
      if (method==='thread/metadata/update') {
        assert.deepEqual(params,{threadId:ref.sessionId,projectId:project.id});
        thread.projectId=project.id;
        if(behavior.mutateHistory) thread.turns.push({items:[{text:'unexpected change'}]});
        if(behavior.loseAck) throw new Error('lost reply');
        return {thread};
      }
      throw new Error('Unexpected RPC');
    },
    completion:async()=>{throw new Error('No imports allowed');}, close:async()=>{},
  };
  const service = new CodexProjectBinding({ jobs, home:scope.home, codexHome,
    version:async()=> 'codex-cli 0.153.4',
    connect:async(_cwd:string,_home:string,profile?:RpcProfile)=>{assert.equal(profile,'project-binding');return rpc;},
  });
  return {scope,codexHome,cwd,ref,jobs,importId,project,thread,calls,behavior,service,
    writes:()=>calls.filter(call=>call.method==='thread/metadata/update').length};
}

test('project preview performs no association; confirm updates only projectId and verifies project membership', async(t)=>{
  const f=await fixture(t);
  const preview=await f.service.prepare(f.importId,f.project.id);
  assert.equal(preview.status,'prepared');
  assert.equal(f.writes(),0);
  const result=await f.service.confirm(preview.planId);
  assert.equal(result.status,'associated');
  assert.equal(result.outcome?.membershipVerified,true);
  assert.equal(result.outcome?.historyUnchanged,true);
  assert.equal(result.guiAcceptance,'pending-manual-review');
  assert.equal(f.writes(),1);
  assert.deepEqual(await f.service.confirm(preview.planId),result);
  assert.equal(f.writes(),1);
  await assert.rejects(stat(path.join(f.codexHome,IMPORT_TARGET_LOCK)),{code:'ENOENT'});
});

test('already associated sessions are verified without another metadata update',async(t)=>{
  const f=await fixture(t);
  f.thread.projectId=f.project.id;
  const plan=await f.service.prepare(f.importId,f.project.id);
  assert.equal((await f.service.confirm(plan.planId)).status,'associated');
  assert.equal(f.writes(),0);
});

test('association rejects unrelated projects, additional roots and moves from another project',async(t)=>{
  for(const issue of ['wrong-root','extra-root','already-owned']) {
    const f=await fixture(t);
    if(issue==='wrong-root')f.project.roots=[{path:f.scope.root}];
    if(issue==='extra-root')f.project.roots.push({path:f.scope.root});
    if(issue==='already-owned')f.thread.projectId=randomUUID();
    await assert.rejects(f.service.prepare(f.importId,f.project.id));
    assert.equal(f.writes(),0);
  }
});

test('history changes after preview prevent association before mutation',async(t)=>{
  const f=await fixture(t);
  const plan=await f.service.prepare(f.importId,f.project.id);
  f.thread.turns.push({items:[{text:'new user work'}]});
  await assert.rejects(f.service.confirm(plan.planId),/history changed/);
  assert.equal(f.writes(),0);
  await assert.rejects(stat(path.join(f.codexHome,IMPORT_TARGET_LOCK)),{code:'ENOENT'});
});

test('changed project roots after preview prevent association',async(t)=>{
  const f=await fixture(t);
  const plan=await f.service.prepare(f.importId,f.project.id);
  f.project.roots.push({path:f.scope.root});
  await assert.rejects(f.service.confirm(plan.planId),/must contain only/);
  assert.equal(f.writes(),0);
});

test('lost acknowledgement, hidden membership or changed history retain the uncertain operation lock',async(t)=>{
  for(const issue of ['loseAck','hidden','mutateHistory'] as const){
    const f=await fixture(t);
    const plan=await f.service.prepare(f.importId,f.project.id);
    f.behavior[issue]=true;
    const result=await f.service.confirm(plan.planId);
    assert.equal(result.status,'uncertain');
    assert.equal(f.writes(),1);
    assert.ok(await stat(path.join(f.codexHome,IMPORT_TARGET_LOCK)));
    await assert.rejects(f.service.confirm(plan.planId),/already attempted/);
    assert.equal(f.writes(),1);
  }
});

test('a completed import is required; association cannot trigger another import',async(t)=>{
  const f=await fixture(t);
  await f.jobs.save(f.importId,{status:'uncertain'});
  await assert.rejects(f.service.prepare(f.importId,f.project.id),/completed import/);
  assert.equal(f.calls.length,0);
});

test('association may run outside the Claude source home used for the completed import',async(t)=>{
  const f=await fixture(t);
  const service=new CodexProjectBinding({jobs:f.jobs,home:path.join(f.scope.root,'current-home'),codexHome:f.codexHome,
    version:async()=> 'codex-cli 0.153.4',
    connect:async(_cwd:string,_home:string,profile?:RpcProfile)=>{assert.equal(profile,'project-binding');return {
      request:async(method,params)=>{
        if(method==='config/read')return {config:{sqlite_home:null}};
        if(method==='project/read')return {project:f.project};
        if(method==='thread/read')return {thread:f.thread};
        if(method==='thread/list')return {data:f.thread.projectId===f.project.id?[{id:f.thread.id,cwd:f.cwd,projectId:f.project.id}]:[]};
        if(method==='thread/metadata/update'){
          assert.deepEqual(params,{threadId:f.ref.sessionId,projectId:f.project.id});
          f.thread.projectId=f.project.id;
          return {thread:f.thread};
        }
        throw new Error('Unexpected RPC');
      },
      completion:async()=>{throw new Error('No imports allowed');},close:async()=>{},
    };},
  });
  const preview=await service.prepare(f.importId,f.project.id);
  assert.equal(preview.plan.home,path.join(f.scope.root,'current-home'));
  assert.equal((await service.confirm(preview.planId)).status,'associated');
});

test('association rejects relative or separate SQLite data roots before any update',async(t)=>{
  for(const directory of ['relative','separate']) {
    const f=await fixture(t);
    f.behavior.sqliteHome=directory==='relative'?'relative':f.scope.root;
    await assert.rejects(f.service.prepare(f.importId,f.project.id),/Separate native SQLite/);
    assert.equal(f.writes(),0);
    await assert.rejects(stat(path.join(f.codexHome,IMPORT_TARGET_LOCK)),{code:'ENOENT'});
  }
});

test('recreated projects need a new association preview and reuse the existing imported session', async (t) => {
  const f = await fixture(t);
  const first = await f.service.prepare(f.importId, f.project.id);
  await f.service.confirm(first.planId);
  const previousProject = f.project.id;
  f.thread.projectId = null;
  f.project.id = randomUUID();
  const oldReceipt = await f.service.status(first.planId);
  assert.equal(oldReceipt.status, 'associated', 'Local receipts describe past completion, not live membership');
  assert.equal(oldReceipt.evidenceScope, 'local-receipt');
  await assert.rejects(f.service.prepare(f.importId, previousProject), /project must contain only/i);
  const next = await f.service.prepare(f.importId, f.project.id);
  assert.notEqual(next.planId, first.planId);
  const result = await f.service.confirm(next.planId);
  assert.equal(result.outcome?.threadId, f.ref.sessionId);
  assert.equal(result.outcome?.projectId, f.project.id);
  assert.equal(result.outcome?.historyUnchanged, true);
  assert.equal(f.writes(), 2);
  assert.ok(!f.calls.some((call) => call.method === 'externalAgentConfig/import'));
});
