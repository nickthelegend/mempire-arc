import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {withOriginTransactionLock} from '../src/chain/origin-transaction-lock.ts';
test('actual Web Locks held in another worker exclude transaction entry, then release on worker death',async()=>{
 const identity=`storage-race-${process.pid}`;
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');navigator.locks.request('arc:transaction-lock:'+workerData,{mode:'exclusive'},async()=>{parentPort.postMessage('locked');await new Promise(resolve=>parentPort.once('message',resolve));});`,{eval:true,workerData:identity});
 try{
  assert.deepEqual(await once(worker,'message'),['locked']);let entered=false;
  await assert.rejects(()=>withOriginTransactionLock(identity,async()=>{entered=true;}),/another tab/);
  assert.equal(entered,false);
 }finally{await worker.terminate();}
 assert.equal(await withOriginTransactionLock(identity,async()=> 'actual lock acquired'),'actual lock acquired');
});
test('unsupported lock API fails before transaction entry',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');let entered=false;
 try{Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});await assert.rejects(()=>withOriginTransactionLock('unsupported',async()=>{entered=true;}),/locking is unavailable/);assert.equal(entered,false);}
 finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else Reflect.deleteProperty(globalThis,'navigator');}
});
