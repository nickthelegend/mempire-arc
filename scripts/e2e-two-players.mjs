/** Real UI, two isolated wallets, wall-clock simulation. Never imports the bot.
 * Requires a desktop able to launch Chromium. No app state is written by this test.
 * Wallet/session backups and funding receipts stay in gitignored .local/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from '../app/node_modules/playwright/index.mjs';
import {createPublicClient,createWalletClient,defineChain,http,parseEther,formatEther,parseEventLogs} from '../app/node_modules/viem/_esm/index.js';
import {privateKeyToAccount} from '../app/node_modules/viem/_esm/accounts/index.js';
const ROOT=new URL('../',import.meta.url);
const local=new URL('.local/two-players/',ROOT);
await fs.mkdir(local,{recursive:true,mode:0o700});
const secure=async(name,data)=>fs.writeFile(new URL(name,local),JSON.stringify(data,null,2),{mode:0o600});
const origin='http://127.0.0.1:8700';
const api='http://127.0.0.1:8780';
const chain=defineChain({id:5042002,name:'Arc testnet',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:['https://rpc.testnet.arc.io']}}});
const client=createPublicClient({chain,transport:http()});
assert.equal(await client.getChainId(),5042002,'testnet only');
const deployment=JSON.parse(await fs.readFile(new URL('deployments/arc-testnet.json',ROOT)));
const abi=JSON.parse(await fs.readFile(new URL('shared/abi/MempireArena.json',ROOT)));
const readMatch=id=>client.readContract({address:deployment.arena,abi,functionName:'getMatch',args:[BigInt(id)]});
const receipts=[]; const children=[]; const pages=[]; const players=[];
const pageErrors=[];
let browser; let startedBlock; let completed=false;
const record=(kind,hash)=>{receipts.push({kind,hash});console.log(`${kind}: https://explorer.testnet.arc.io/tx/${hash}`);};
function start(cwd,args,extra={}) {
 const child=spawn(process.execPath,args,{cwd:new URL(cwd,ROOT),env:{...process.env,...extra},stdio:['ignore','ignore','ignore']});
 children.push(child); return child;
}
async function waitFor(check,label,timeout=90000) {
 const end=Date.now()+timeout;
 while(Date.now()<end) { if(await check()) return; await sleep(500); }
 throw new Error(`Timed out: ${label}`);
}
async function snapshot(page) {
 return page.evaluate(async()=>{
  const [{useWallet},{useMatch},{useEscrow},{useChain},{usePlayLog}]=await Promise.all([
   import('/src/state/wallet.ts'),import('/src/state/match.ts'),import('/src/state/escrow.ts'),import('/src/state/chain.ts'),import('/src/state/playLog.ts')]);
  const w=useWallet.getState(),m=useMatch.getState(),e=useEscrow.getState(),c=useChain.getState(),l=usePlayLog.getState();
  return {address:w.address,balance:w.usdc,cards:c.cards.length,status:m.status,mode:m.mode,phase:e.phase,matchId:e.matchId,error:e.lastError,
   tick:m.sim?.tick,result:m.result,plays:l.confirmed,unlogged:l.playsLost,tx:e.lastSignature};
 });
}
async function backup(page,i) {
 // Keys never go to stdout, traces, screenshots, or tracked files.
 const data=await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));
 await secure(`wallet-${i}.json`,data);
 return data;
}
async function fund() {
 const balances=await Promise.all(players.map(p=>client.getBalance({address:p.address})));
 const target=parseEther('1.14');
 const deficits=balances.map(b=>b<target?target-b:0n);
 const total=deficits.reduce((a,b)=>a+b,0n);
 // The strict default is gross, including funding gas. A larger temporary float requires an explicit override.
 const cap=parseEther(process.env.E2E_MAX_FUNDING ?? '2');
 if(total===0n) return;
 assert(total+parseEther('0.005')<=cap,`Two $1 stakes plus gas need ${formatEther(total)} USDC temporary funding. Default gross cap is 2. Prefund the saved wallets or explicitly set E2E_MAX_FUNDING after agreeing a budget.`);
 if(total===0n) return;
 const env=await fs.readFile(new URL('../.deployer/deployer.env',ROOT),'utf8');
 const key=env.match(/^DEPLOYER_PRIVATE_KEY=['"]?(0x[0-9a-fA-F]{64})/m)?.[1];
 assert(key,'deployer env missing');
 const account=privateKeyToAccount(key);
 assert.equal(account.address.toLowerCase(),'0x0648adf1967692a0c991d7715b0b588452321fbd');
 const wallet=createWalletClient({account,chain,transport:http()});
 const lock=new URL('../.deployer/lock',ROOT);
 let acquired=false;
 try {
  for(let i=0;i<40&&!acquired;i++) {try{await fs.mkdir(lock);acquired=true;}catch(e){if(e.code!=='EEXIST')throw e;await sleep(1500);}}
  assert(acquired,'shared funding lock busy');
  for(let i=0;i<players.length;i++) if(deficits[i]>0n) {
   const hash=await wallet.sendTransaction({to:players[i].address,value:deficits[i]});
   assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');record(`fund player ${i+1}`,hash);
  }
 } finally {if(acquired)await fs.rmdir(lock);}
}
async function sweep(key,to) {
 const account=privateKeyToAccount(key);
 const wallet=createWalletClient({account,chain,transport:http()});
 const balance=await client.getBalance({address:account.address});
 const fees=await client.estimateFeesPerGas();
 const gas=await client.estimateGas({account:account.address,to,value:1n});
 const reserve=gas*fees.maxFeePerGas;
 if(balance<=reserve*2n)return;
 const hash=await wallet.sendTransaction({to,value:balance-reserve,gas,...fees});
 assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');record('sweep',hash);
}
try {
 // Launch before spending or onboarding, so a host sandbox refusal costs nothing.
 browser=await chromium.launch({headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--use-angle=swiftshader']});
 if(process.env.E2E_EXTERNAL_SERVERS!=='1') {
  start('server',['--env-file=.env.local','index.js'],{PORT:'8780',META_KEEPER:'0',MIRROR_KEEPER:'0',ONBOARD_USDC_DRIP:'0'});
  start('app',['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{PORT:'8700',VITE_CHAIN_ID:'5042002',VITE_API_URL:api,VITE_RELAY_URL:api});
 }
 await waitFor(async()=>{try{return(await fetch(api+'/api/health')).ok && (await fetch(origin)).ok;}catch{return false;}},'local services');
 startedBlock=await client.getBlockNumber();
 for(let i=0;i<2;i++) {
  const context=await browser.newContext({viewport:{width:i?390:1280,height:844}});
  let saved;try{saved=JSON.parse(await fs.readFile(new URL(`wallet-${i}.json`,local)));}catch{}
  if(saved)await context.addInitScript(data=>{for(const [k,v] of Object.entries(data.local))localStorage.setItem(k,v);for(const [k,v] of Object.entries(data.session))sessionStorage.setItem(k,v);},saved);
  const page=await context.newPage();pages.push(page);
  page.on('pageerror',()=>pageErrors.push(`Browser ${i+1} uncaught error`));
  await page.goto(origin);
  if(!saved) {
   await page.getByRole('button',{name:/play now/i}).click();
   await page.getByRole('button',{name:/Play as Guest/}).click();
  }
  await waitFor(async()=>Boolean((await snapshot(page)).address),'guest sign-in');
  const data=await backup(page,i);
  const key=data.local.mempire_guest_evm_sk;
  assert(key,'guest key backed up');players.push(privateKeyToAccount(key));
  const skip=page.getByRole('button',{name:'Skip',exact:true});if(await skip.isVisible())await skip.click();
  await waitFor(async()=>(await snapshot(page)).cards>=8,'UI starter-deck onboarding');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
  console.log(`Player ${i+1}: ${players[i].address}, starter deck confirmed`);
 }
 if(process.env.E2E_STAGE==='onboard') {console.log('Onboarding only; no match requested.');process.exitCode=0;}
 else {
  await fund();
  for(const p of pages){await p.reload();await waitFor(async()=>(await snapshot(p)).balance>=1.12,'funded wallet in UI');}
  await Promise.all(pages.map(p=>p.getByRole('button',{name:'Ranked',exact:true}).click()));
  await waitFor(async()=>{const s=await Promise.all(pages.map(snapshot));return s.every(x=>x.status==='battle'&&x.mode==='human'&&x.phase==='live');},'two human seats, both stakes escrowed');
  const initial=await Promise.all(pages.map(snapshot));
  assert.equal(initial[0].matchId,initial[1].matchId);
  const id=initial[0].matchId;
  const locked=await readMatch(id);assert.equal(Number(locked.state),2);assert.equal(locked.stake,1000000n);
  for(let i=0;i<2;i++)await backup(pages[i],i);
  const began=Date.now();let rounds=0;
  // Unequal lane strategies, using the same tap-card/tap-arena affordance as players.
  // No fake clocks, state injection, bot engine, forced winner, or direct claim transaction.
  while(Date.now()-began<360000) {
   const states=await Promise.all(pages.map(snapshot));
   if(states.every(s=>s.status==='settled'))break;
   for(let i=0;i<2;i++) {
    if(states[i].status!=='battle'||(i===1&&rounds%4!==0))continue;
    const coaching=pages[i].getByRole('button',{name:'Skip coaching'});if(await coaching.isVisible())await coaching.click();
    const hand=pages[i].getByRole('button',{name:/^Deploy /});
    for(const card of await hand.all())if(await card.isEnabled()) {
     await card.click();
     const canvas=pages[i].locator('canvas');const box=await canvas.boundingBox();assert(box);
     await canvas.click({position:{x:box.width*(i===0?0.35:0.65),y:box.height*0.59}});break;
    }
   }
   if(rounds===4)for(let i=0;i<2;i++)await pages[i].screenshot({path:fileURLToPath(new URL(`docs/screens/testnet/two-players-${i?390:1280}.png`,ROOT))});
   if(rounds%10===0)console.log(`Real-time match ${id}: ${Math.round((Date.now()-began)/1000)}s; ticks ${states.map(s=>s.tick).join('/')}`);
   rounds++;await sleep(2000);
  }
  await waitFor(async()=>(await readMatch(id)).state===3,'normal two-claim settlement',90000);
  const final=await readMatch(id);assert(Number(final.winner)<2,'a decisive winner, not a draw or void');
  const states=await Promise.all(pages.map(snapshot));
  assert(states.every(s=>s.mode==='human'&&s.plays>0&&s.unlogged===0),'both seats logged every UI play');
  const ticks=Math.max(...states.map(s=>s.tick??0));
  assert(Date.now()-began>=ticks*50-2500,'simulation was not accelerated');
  const logs=await client.getLogs({address:deployment.arena,fromBlock:startedBlock,toBlock:await client.getBlockNumber()});
  const events=parseEventLogs({abi,logs});
  const settled=events.find(e=>e.eventName==='MatchSettled'&&Number(e.args.matchId)===id);
  assert(settled);assert.equal(settled.args.pot-settled.args.rake,1800000n);
  assert.equal(settled.args.byTimeout,false);
  for(const e of events.filter(e=>Number(e.args.matchId)===id))record(e.eventName,e.transactionHash);
  assert.deepEqual(pageErrors,[], 'no browser errors');
  completed=true;
  await secure('evidence.json',{at:new Date().toISOString(),chainId:5042002,matchId:id,elapsedMs:Date.now()-began,ticks,players:players.map(p=>p.address),states,receipts});
  console.log('PASS: UI onboarding, two isolated player contexts, real-time card clicks, both claims, $1.80 payout.');
 }
} catch(e) {
 console.error(`E2E NOT COMPLETE: ${String(e.shortMessage??e.message).split('\n')[0]}`);process.exitCode=1;
} finally {
 for(let i=0;i<pages.length;i++) {
  try {
   const data=await backup(pages[i],i);
   const state=await snapshot(pages[i]);
   if(state.matchId && Number((await readMatch(state.matchId)).state)!==3)continue; // never remove recovery gas from an active match
   if(completed) {
    for(const [k,key] of Object.entries(data.session))if(/^mempire_session_\d+$/.test(k))await sweep(key,players[i].address);
    await sweep(data.local.mempire_guest_evm_sk,'0x0648aDF1967692A0c991d7715b0b588452321FBd');
   }
  }catch{console.error(`Player ${i+1}: retained backup for recovery; sweep not confirmed.`);}
 }
 await secure('transactions.json',receipts);
 await browser?.close();
 for(const child of children)child.kill('SIGTERM');
}
