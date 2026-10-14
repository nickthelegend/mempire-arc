/** Live Arc testnet: two fresh wallets, UI auth and HTTP deadline, no browser.
 * npm run e2e:onboard-api (0.02 USDC per player plus mint/transfer gas).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {generatePrivateKey,privateKeyToAccount} from '../server/node_modules/viem/_esm/accounts/index.js';
import {startRelay,signed} from '../server/test-util.mjs';
import {publicClient,abis,deployment,CHAIN_ID} from '../server/chain.js';
import {finishOnboarding} from '../app/src/lib/onboarding.ts';
assert.equal(CHAIN_ID,5042002);
assert.equal(await publicClient().getChainId(),5042002);
const relay=await startRelay(8781,{...process.env,PORT:'8781',META_KEEPER:'0',MIRROR_KEEPER:'0',CCIP_WATCH:'0',ONBOARD_USDC_DRIP:'0.02'});
try {
 await fs.mkdir(new URL('../.local/api-onboard/',import.meta.url),{recursive:true,mode:0o700});
 for(let i=0;i<2;i++){
  const key=generatePrivateKey(),account=privateKeyToAccount(key);
  await fs.writeFile(new URL(`../.local/api-onboard/wallet-${i}.json`,import.meta.url),JSON.stringify({key,address:account.address}),{mode:0o600});
  const body=await signed(account,'onboard');
  const request=async(path,init={})=>{try{return await fetch(relay.base+path,{...init,signal:AbortSignal.timeout(8000)});}catch{return null;}};
  const before=Date.now();
  await finishOnboarding(()=>request('/api/onboard',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),()=>request(`/api/onboard/${account.address}`),async()=>{});
  const [ids]=await publicClient().readContract({address:deployment.cards,abi:abis.cards,functionName:'cardsOf',args:[account.address]});
  assert.equal(ids.length,8);
  const status=await(await request(`/api/onboard/${account.address}`)).json();
  assert.equal(status.claim.complete,true);assert.equal(status.usdc.balance,'0.02');
  console.log(`Player ${i+1}: ${account.address}, eight cards + 0.02 USDC, ${Date.now()-before}ms`);
  for(const [kind,hash] of Object.entries(status.claim.txs))console.log(`${kind}: https://explorer.testnet.arc.io/tx/${hash}`);
 }
 console.log('PASS: two back-to-back UI-equivalent API onboardings');
} catch(e){console.error(relay.log().replace(/0x[0-9a-fA-F]{64}/g,'[redacted 32-byte value]'));throw new Error(e.shortMessage??e.message);}
finally{await relay.stop();}
