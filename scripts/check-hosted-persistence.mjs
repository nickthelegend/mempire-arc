/** Harmless, signed DB write/read. Ephemeral unfunded identity; no transactions. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {generatePrivateKey,privateKeyToAccount}=createRequire(new URL('../server/package.json',import.meta.url))('viem/accounts');
const base=process.env.BASE||'https://mempire-arc.vercel.app';
const a=privateKeyToAccount(generatePrivateKey()),address=a.address,ts=Date.now();
const signature=await a.signMessage({message:`Mempire\naction: player.put\nwallet: ${address}\nts: ${ts}`});
const payload={cards:[],deck:[],history:[],nextId:37,signature,ts};
const r=await fetch(`${base}/api/player/${address}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert(r.ok,await r.text());
for(let i=0;i<2;i++){
 const r=await fetch(`${base}/api/player/${address}?check=${i}`,{cache:'no-store'});assert(r.ok);const data=await r.json();assert.equal(data.nextId,37);assert.deepEqual(data.history,[]);
}
const health=await fetch(base+'/api/health').then(r=>r.json());assert.equal(health.persistent,true);
const board=await fetch(base+'/api/leaderboard').then(r=>r.json());
for(const address of ['0x28990eec366e8f1c8a8d217d08e33900182de732','0x7603cc1470a710755f6065a4d0c1ac3d4e383785'])assert(board.some(p=>p.address===address&&p.matches>=1));
console.log('PASS: signed empty player persisted and read twice; video players visible on leaderboard. No chain writes.');
