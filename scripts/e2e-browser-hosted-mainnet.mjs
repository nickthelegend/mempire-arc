/** Read-only production sweep. No wallets, signatures, POST APIs or transactions. */
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import path from 'node:path';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE||path.resolve('../thenar-arc/package.json'))('playwright'));}
const configurations=JSON.parse(readFileSync('docs/mainnet-hosted-config.json','utf8'));
const tmp=path.resolve('.vercel/browser-mainnet-tmp');mkdirSync(tmp,{recursive:true});process.env.TMPDIR=tmp;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let failed=false;
const rpc=async(method,params)=>{const r=await fetch('https://rpc.mainnet.arc.io',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(45000)});const j=await r.json();if(j.error)throw Error(j.error.message);return j.result;};
try{for(const config of configurations.filter(c=>!process.env.MAINNET_SURFACES||process.env.MAINNET_SURFACES.split(",").includes(c.name))){
 const out=`docs/screens/mainnet/${config.name}`;mkdirSync(out,{recursive:true});const results=[];
 const context=await browser.newContext({viewport:{width:1440,height:900}});const page=await context.newPage();const errors=[];const consoleErrors=[];page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
 page.on('pageerror',e=>errors.push(e.message));
 let explorerLinks=0;let mainnetVisible=false;
 try{
  for(const route of config.routes){
   const start=errors.length;
   try{
    let response=await page.goto(config.base+route,{waitUntil:'domcontentloaded',timeout:90000});if(!response)response=await page.reload({waitUntil:'domcontentloaded',timeout:90000});await page.waitForTimeout(config.waitMs||4000);
    const body=await page.locator('body').innerText();
    const links=await page.locator('a[href]').evaluateAll(as=>as.map(a=>a.href));
    const wrongLinks=links.filter(h=>/explorer\.testnet\.arc\.io|testnet\.arcscan\.app/.test(h));
    explorerLinks+=links.filter(h=>h.startsWith('https://explorer.arc.io')).length;mainnetVisible ||= /mainnet|\b5042\b/i.test(body);
    const wording=body.split('\n').filter(l=>/testnet|5042002/i.test(l));
    const row={route,status:response?.status(),bodyPresent:body.trim().length>30,testnetWording:wording,wrongExplorerLinks:wrongLinks,pageErrors:errors.slice(start)};
    row.ok=row.status===200&&row.bodyPresent&&!wording.length&&!wrongLinks.length&&!row.pageErrors.length;
    results.push(row);console.log(`${row.ok?'PASS':'FAIL'} ${config.name} ${route} HTTP ${row.status} wording=${wording.length} errors=${row.pageErrors.length}`);
    const staleBody=`${out}/${route.replace(/[^a-z0-9]/gi,'-')||'home'}.txt`;if(row.ok&&existsSync(staleBody))unlinkSync(staleBody);
    if(!row.ok)writeFileSync(`${out}/${route.replace(/[^a-z0-9]/gi,'-')||'home'}.txt`,body);
    await page.screenshot({path:`${out}/${route.replace(/[^a-z0-9]/gi,'-')||'home'}.jpg`,type:'jpeg',quality:65,fullPage:false});
   }catch(e){results.push({route,ok:false,error:String(e)});console.log('FAIL',config.name,route,String(e));}
  }
  if(config.networkApi){const r=await fetch(config.networkApi,{signal:AbortSignal.timeout(60000)});const data=await r.json();let value=data;for(const key of config.chainPath||['chainId'])value=value?.[key];
   const row={networkApi:config.networkApi,status:r.status,chainId:value,ok:r.ok&&Number(value)===5042};results.push(row);writeFileSync(`${out}/network.json`,JSON.stringify(data,null,2)+'\n');console.log(row.ok?'PASS':'FAIL',config.name,'API chain',value);
   if(config.contract&&config.apiContract!==false&&!JSON.stringify(data).toLowerCase().includes(config.contract.toLowerCase()))results.push({ok:false,error:'Network API missing expected mainnet contract',contract:config.contract});
  }
  if(config.explorerClick){
   await page.goto(config.base+config.explorerClick.route,{waitUntil:'domcontentloaded'});await page.waitForTimeout(5000);
   const target=page.getByText(new RegExp(config.explorerClick.text)).first();
   const popupPromise=context.waitForEvent('page',{timeout:15000});await target.click();const popup=await popupPromise;
   await popup.waitForURL('https://explorer.arc.io/**',{timeout:45000});const url=popup.url();results.push({explorerClick:url,ok:url.startsWith('https://explorer.arc.io/')});explorerLinks++;await popup.close();
  }
  const chainId=parseInt(await rpc('eth_chainId',[]),16);const code=config.contract?await rpc('eth_getCode',[config.contract,'latest']):null;
  results.push({rpc:'https://rpc.mainnet.arc.io',chainId,contract:config.contract,codeBytes:code?(code.length-2)/2:null,ok:chainId===5042&&(!config.contract||code.length>2)});
  results.push({mainnetVisible,explorerLinks,ok:(!config.requireVisible||mainnetVisible)&&(!config.requireExplorer||explorerLinks>0)});
  await page.setViewportSize({width:390,height:844});await page.goto(config.base+config.routes[0],{waitUntil:'domcontentloaded'});await page.waitForTimeout(1500);await page.screenshot({path:`${out}/mobile.jpg`,type:'jpeg',quality:70});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);results.push({mobileOverflow:overflow,ok:!overflow});
 }catch(e){results.push({ok:false,error:String(e)});console.log('FAIL',config.name,String(e));}
 finally{await context.close();writeFileSync(`${out}/results.json`,JSON.stringify({at:new Date().toISOString(),base:config.base,readOnly:true,consoleErrors,results},null,2)+'\n');}
 if(results.some(r=>!r.ok))failed=true;
}}
finally{await browser.close();}
if(failed)process.exitCode=1;
