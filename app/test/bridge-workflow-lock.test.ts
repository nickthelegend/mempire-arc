import {test} from 'node:test';import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';import {once} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {withBridgeWorkflow,bridgeWorkflowIdentity} from '../src/lib/bridge-workflow-lock.ts';import {readRemote,saveRemote,type RemotePending} from '../src/lib/ccip-pending.ts';
const owner=`0x${'11'.repeat(20)}` as const;
test('actual worker excludes outer Gateway/CCIP entry before any journal mutation and releases without clearing unknown intent',async()=>{
 const d=mkdtempSync(join(tmpdir(),'bridge-workflow-')),f=join(d,'journal');const s={getItem(){return existsSync(f)?readFileSync(f,'utf8'):null;},setItem(_k:string,v:string){writeFileSync(f,v);},removeItem(){rmSync(f,{force:true});}};
 const pending:RemotePending={version:1,chainId:84532,destinationChainId:5042002,owner,entry:`0x${'22'.repeat(20)}`,token:`0x${'33'.repeat(20)}`,arena:`0x${'44'.repeat(20)}`,inputHash:`0x${'55'.repeat(32)}`,stage:'prepared'};saveRemote(s,pending);const before=readFileSync(f,'utf8');
 const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads');navigator.locks.request('arc:transaction-lock:'+workerData,{mode:'exclusive'},async()=>{parentPort.postMessage('locked');await new Promise(r=>parentPort.once('message',r));});`,{eval:true,workerData:bridgeWorkflowIdentity(5042002,owner)});
 try{await once(w,'message');let entered=false;await assert.rejects(()=>withBridgeWorkflow(5042002,owner,async()=>{entered=true;s.removeItem();}),/another tab/);assert.equal(entered,false);assert.equal(readFileSync(f,'utf8'),before);await w.terminate();await assert.rejects(()=>withBridgeWorkflow(5042002,owner,async()=>{if(readRemote(s,owner))throw Error('original unknown remains blocked');}),/unknown remains/);assert.equal(readFileSync(f,'utf8'),before);}
 finally{await w.terminate();rmSync(d,{recursive:true,force:true});}
});
test('wrong destination refuses before workflow callback',async()=>{let entered=false;await assert.rejects(()=>withBridgeWorkflow(1,owner,async()=>{entered=true;}),/5042002/);assert.equal(entered,false);});
test('outer bridge lock and inner original-call lock have distinct identities with one-way acquisition',async()=>{
 const {withOriginTransactionLock}=await import('../src/chain/origin-transaction-lock.ts');
 assert.equal(await withBridgeWorkflow(5042002,owner,()=>withOriginTransactionLock(`arc:durable-call:v1:84532:${owner}`,async()=> 'real locks held')), 'real locks held');
});
