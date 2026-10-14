import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finishOnboarding} from '../src/lib/onboarding.ts';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
test('two consecutive players recover completed mints after HTTP timeouts without reposting', async()=>{
 let posts=0,refreshes=0;
 for(let player=0;player<2;player++){
  let reads=0;
  const result=await finishOnboarding(async()=>{posts++;return null;},async()=>json({claim:++reads===1?{running:true}:{complete:true,steps:{usdc:'sent'}}}),async()=>{refreshes++;},async()=>{});
  assert.equal(result.usdc,'sent');assert.equal(reads,2);
 }
 assert.equal(posts,2);assert.equal(refreshes,2);
});
test('top-up and partial RPC failures reach the UI with their actual reason',async()=>{
 for(const response of [json({error:'Relay needs a top-up'},503),json({errors:{starter:'Request exceeds defined limit.'}},502)])
  await assert.rejects(finishOnboarding(async()=>response,async()=>{throw Error('must not poll');},async()=>{}),/top-up|defined limit/);
});
test('an in-progress 409 reconciles, a failed claim does not report success',async()=>{
 await assert.rejects(finishOnboarding(async()=>json({},409),async()=>json({claim:{running:false,errors:{starter:'RPC throttled'}}}),async()=>{},async()=>{}),/RPC throttled/);
});

test('already completed claim refreshes an empty browser collection without another mint',async()=>{
 let refreshed=false;
 await finishOnboarding(async()=>json({},409),async()=>json({claim:{complete:true,steps:{usdc:'unconfigured'}}}),async()=>{refreshed=true;});
 assert.equal(refreshed,true);
});
