/** Read-only mainnet receipt + explorer browser verification. No wallet, no broadcasts. */
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const require=createRequire(import.meta.url);let chromium;
try{({chromium}=require('playwright'));}catch{({chromium}=createRequire(path.resolve(process.env.ARC_ROOT||'..','thenar-arc/package.json'))('playwright'));}
const record=JSON.parse(readFileSync('deployments/mainnet-receipts.json','utf8'));
const rpc=async(method,params)=>{const r=await fetch('https://rpc.mainnet.arc.io',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const d=await r.json();assert(!d.error,JSON.stringify(d.error));return d.result;};
assert.equal(parseInt(await rpc('eth_chainId',[]),16),5042);
for(const t of record.transactions){const r=await rpc('eth_getTransactionReceipt',[t.hash]);assert.equal(r.status,'0x1',t.hash);if(r.contractAddress)assert.notEqual(await rpc('eth_getCode',[r.contractAddress,'latest']),'0x');}
const smoke=record.transactions.find(t=>t.category==='smoke');assert(smoke,'No mainnet smoke receipt');
const temp=path.resolve('.vercel/browser-mainnet-tmp');mkdirSync(temp,{recursive:true});process.env.TMPDIR=temp;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{const page=await browser.newPage({viewport:{width:1440,height:900}});const url='https://explorer.arc.io/tx/'+smoke.hash;const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});assert(response.ok(),'Explorer HTTP '+response.status());await page.getByText(smoke.hash,{exact:false}).first().waitFor({timeout:30000});const text=await page.locator('body').innerText();assert(/success/i.test(text),'Explorer success status missing');mkdirSync('docs/screens/mainnet',{recursive:true});await page.screenshot({path:'docs/screens/mainnet/smoke.png',fullPage:true});writeFileSync('docs/screens/mainnet/browser-check.json',JSON.stringify({chainId:5042,receiptsChecked:record.transactions.length,explorer:url,success:true,scope:'Read-only explorer browser; DApp mainnet browser flow Not run'},null,2)+'\n');console.log('PASS',record.transactions.length,'mainnet receipts/code; explorer smoke success. DApp browser transactions Not run.');}finally{await browser.close();}
