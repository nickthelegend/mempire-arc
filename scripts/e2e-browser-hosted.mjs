/** Read-only production smoke check. BASE may override docs/hosted-config.json. */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const temp=path.resolve('.vercel/browser-tmp');mkdirSync(temp,{recursive:true});process.env.TMPDIR=temp;
const require=createRequire(import.meta.url);
let chromium;
try { ({chromium}=require('playwright')); }
catch { ({chromium}=createRequire(process.cwd()+'/../thenar-arc/package.json')('playwright')); }
const config=JSON.parse(readFileSync(process.env.HOSTED_CONFIG||'docs/hosted-config.json','utf8'));
const base=process.env.BASE||config.base;
const out=config.screenshotDir||'docs/screens/hosted';mkdirSync(out,{recursive:true});
const results=[];
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();
 if(config.webauthn){const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});}
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 const routes=[...config.routes];
 for(const route of routes){
  const start=errors.length;
  const response=await page.goto(base+route,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(config.waitMs||2500);
  const text=await page.locator('body').innerText();
  const badImages=await page.evaluate(()=>[...document.images].filter(i=>i.complete&&!i.naturalWidth).map(i=>i.getAttribute('src')));
  await page.screenshot({path:`${out}/${route==='/'?'home':route.replace(/[^a-z0-9]+/gi,'-')}.png`,fullPage:true});
  const row={route,status:response?.status() ?? (await fetch((base+route).split('#')[0])).status,consoleErrors:errors.slice(start),badImages,bodyPresent:text.trim().length>30};
  row.ok=row.status===200&&row.consoleErrors.length===0&&row.badImages.length===0&&row.bodyPresent;
  results.push(row);console.log(`${row.ok?'PASS':'FAIL'} ${route} HTTP ${row.status} errors=${row.consoleErrors.length}`);
 }
 if(config.firstStep){
  await page.goto(base+config.firstStep.route,{waitUntil:'domcontentloaded'});
  const button=page.getByRole(config.firstStep.role||'button',{name:config.firstStep.name,exact:true});
  await button.click({timeout:30000});
  if(config.firstStep.url) await page.waitForURL(base+config.firstStep.url,{timeout:30000});
  await page.getByText(config.firstStep.expect,{exact:false}).first().waitFor({timeout:30000});
  results.push({firstStep:config.firstStep.name,ok:true});
  await page.screenshot({path:`${out}/first-step.png`,fullPage:true});
 }
 if(config.api){for(const path of config.api){try{const r=await fetch(path.startsWith('http')?path:base+path,{signal:AbortSignal.timeout(60000)});const data=await r.json();results.push({api:path,status:r.status,ok:r.ok&&data.ok!==false,data});}catch(e){results.push({api:path,ok:false,error:String(e)})}}}
 if(config.contract){
  const rpc=async(method,params)=>{const r=await fetch('https://rpc.testnet.arc.io',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw Error(j.error.message);return j.result};
  assert.equal(parseInt(await rpc('eth_chainId',[]),16),5042002);
  const code=await rpc('eth_getCode',[config.contract,'latest']);assert.ok(code.length>2);
  results.push({liveTestnetContract:config.contract,codeBytes:(code.length-2)/2,ok:true});
 }
 await page.setViewportSize({width:390,height:844});await page.goto(base+config.routes[0],{waitUntil:'domcontentloaded'});await page.waitForTimeout(1500);await page.screenshot({path:`${out}/mobile.png`,fullPage:true});
 results.push({mobileOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),ok:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)});
} catch(e){results.push({ok:false,error:String(e)});console.error(String(e));}
finally{await browser.close();writeFileSync(`${out}/results.json`,JSON.stringify({at:new Date().toISOString(),base,results},null,2)+'\n');}
if(results.some(r=>!r.ok))process.exitCode=1;
