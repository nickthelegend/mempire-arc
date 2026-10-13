import {test,after} from 'node:test';import assert from 'node:assert/strict';import {MongoClient} from 'mongodb';
import {GatewayJournal} from './gateway-journal.js';import {createMemoryDb} from './memstore.js';import {canonicalGatewayIntent,authenticateGatewayRequests} from './gateway-intent.js';import {verifyOriginalGatewayMint} from './gateway-receipt.js';
const h=n=>`0x${n.repeat(64)}`;const address=n=>`0x${n.repeat(40)}`;
const dbname='arc_gateway_integrity_local_20261009';const uri=process.env.GATEWAY_TEST_MONGO;
const client=uri?new MongoClient(uri):null;let db;if(client){await client.connect();db=client.db(dbname);}after(async()=>{await client?.close();});
const minter=address('2'),owner=address('1'),relayer=address('3');
// UNSIGNED PUBLIC STORAGE METADATA ONLY. These hashes never represent a provider/chain success.
const input=(id,intents=[h(id)])=>({id:h(id),owner,relayer,chainId:5042002,minter,token:address('4'),intentHashes:intents,signatureHashes:[h('f')],intents:[]});
test('memory fallback and absent database refuse financial journal',async()=>{for(const get of [()=>null,()=>createMemoryDb('gateway')]){const j=new GatewayJournal(get);await assert.rejects(()=>j.claim(input('1')),/Durable Mongo/);}});
test('missing original mint identity refuses before any RPC',async()=>{await assert.rejects(()=>verifyOriginalGatewayMint(undefined,{}),/no durable signed hash/);});
test('actual Mongo concurrent atomic claims, retained unknown replay and overlapping batch rejection',async()=>{
 assert.ok(db,'GATEWAY_TEST_MONGO must point to genuine isolated persisted Mongo for this test');const collection=db.collection('gateway_journal');await collection.deleteMany({});
 const a=new GatewayJournal(()=>db);const second=new MongoClient(uri);await second.connect();try{const b=new GatewayJournal(()=>second.db(dbname));
 const results=await Promise.all([a.claim(input('1')),b.claim(input('1'))]);assert.equal(results.filter(r=>r.created).length,1);assert.equal((await a.get(h('1'))).state,'circle-unknown');
 await assert.rejects(()=>a.claim(input('2',[h('1'),h('2')])),/already claimed/);assert.equal(await a.get(h('2')),null);const doc=await collection.findOne({_id:a.id});assert.equal(doc.count,1);assert.deepEqual(doc.claims,[h('1')]);
 }finally{await second.close();}
});
test('actual Mongo atomic original hash+nonce claim rolls back validation failure and survives new connection',async()=>{
 assert.ok(db);const j=new GatewayJournal(()=>db),c=db.collection('gateway_journal');await j.claim(input('3'));await j.claim(input('4'));
 // Prepare unknown pending storage markers directly; no signed/provider response fixture.
 for(const id of ['3','4'])await c.updateOne({_id:j.id},{$set:{[`jobs.${h(id)}.state`]:'mint-unknown',[`jobs.${h(id)}.mintDataHash`]:h('a')}});
 const identity={hash:h('b'),chainId:5042002,from:relayer,to:minter,dataHash:h('a'),nonce:0,gas:'21000',maxFeePerGas:'40000000000',maxPriorityFeePerGas:'1000000000'};
 await db.command({collMod:'gateway_journal',validator:{[`jobs.${h('3')}.identity`]:{$exists:false}},validationLevel:'strict',validationAction:'error'});
 await assert.rejects(()=>j.recordSigned(h('3'),owner,identity));let doc=await c.findOne({_id:j.id});assert.equal(doc.jobs[h('3')].identity,undefined);assert.equal(doc.nonceClaims[relayer],undefined);
 await db.command({collMod:'gateway_journal',validator:{}});
 await j.recordSigned(h('3'),owner,{...identity,raw:'not-stored',signature:'not-stored'});await assert.rejects(()=>j.recordSigned(h('4'),owner,{...identity,hash:h('c')}),/already owned/);assert.equal(await j.nonceFloor(relayer),1);
 const reopened=new MongoClient(uri);await reopened.connect();try{const restored=new GatewayJournal(()=>reopened.db(dbname));assert.equal((await restored.get(h('3'))).identity.hash,h('b'));assert.equal((await restored.get(h('4'))).identity,undefined);assert.equal(JSON.stringify(await c.findOne({_id:j.id})).includes('not-stored'),false);}finally{await reopened.close();}
});

test('exact testnet public intent codec rejects foreign contracts/tokens/owners and malformed authorization',async()=>{
 const {pad}=await import('viem');const gateway={wallet:'0x0077777d7EBA4688BDeF3E311b846F25870A19B9',minter:'0x0022222ABE238Cc2C7Bb1f21003F0a260052475B'};const b32=a=>pad(a.toLowerCase(),{size:32});
 const intent={maxBlockHeight:'1000',maxFee:'20000',spec:{version:1,sourceDomain:0,destinationDomain:26,sourceContract:b32(gateway.wallet),destinationContract:b32(gateway.minter),sourceToken:b32('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),destinationToken:b32('0x3600000000000000000000000000000000000000'),sourceDepositor:b32(owner),destinationRecipient:b32(owner),sourceSigner:b32(owner),destinationCaller:pad('0x00',{size:32}),value:'1000000',salt:h('a'),hookData:'0x'}};
 const safe=canonicalGatewayIntent({...intent,authorization:'never-stored',spec:{...intent.spec,privateKey:'never-stored'}},gateway);assert.equal(safe.owner,owner);assert.equal(JSON.stringify(safe).includes('never-stored'),false);
 for(const [field,value]of Object.entries({sourceDomain:99,destinationDomain:0,sourceContract:h('a'),destinationContract:h('b'),sourceToken:h('c'),destinationToken:h('d'),sourceDepositor:h('1'),destinationRecipient:b32(relayer),sourceSigner:b32(relayer),destinationCaller:b32(relayer),value:'0',hookData:'0x01'}))assert.throws(()=>canonicalGatewayIntent({...intent,spec:{...intent.spec,[field]:value}},gateway));
 assert.throws(()=>canonicalGatewayIntent({...intent,maxFee:'20001'},gateway));await assert.rejects(()=>authenticateGatewayRequests([{burnIntent:intent,signature:'0x'}],gateway));
});
