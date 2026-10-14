/** Read-only hosted shell smoke. No wallet, signing, or transaction submission. */
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
let chromium;
for(const p of ['package.json','app/package.json','server/package.json','apps/app/package.json','../thenar-arc/package.json']){
 try{({chromium}=createRequire(new URL(p,root))('playwright'));break;}catch{}
}
if(!chromium)throw Error('Install repository Playwright dependencies');
const tmp=new URL('.vercel/browser-dryrun-tmp/',root);mkdirSync(tmp,{recursive:true});process.env.TMPDIR=fileURLToPath(tmp);
const configs=JSON.parse(readFileSync(new URL('docs/mainnet-hosted-config.json',root),'utf8'));
const results=[];
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 for(const config of configs){
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const row={surface:config.name,url:config.base+config.routes[0],readOnly:true};
  try{
   const response=await page.goto(row.url,{waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForTimeout(3000);
   const body=await page.locator('body').innerText();
   const links=await page.locator('a[href]').evaluateAll(as=>as.map(a=>a.href));
   Object.assign(row,{status:response?.status(),bodyPresent:body.length>30,pageErrors:errors,testnetWording:body.split('\n').filter(l=>/testnet|5042002/i.test(l)),wrongExplorerLinks:links.filter(h=>/explorer\.testnet\.arc\.io|testnet\.arcscan\.app/.test(h))});
   row.ok=row.status===200&&row.bodyPresent&&!errors.length&&!row.testnetWording.length&&!row.wrongExplorerLinks.length;
  }catch(e){row.ok=false;row.error=String(e.message).slice(0,500);}
  finally{await context.close();results.push(row);console.log(`${row.ok?'PASS':'FAIL'} ${row.surface} hosted shell`);}
 }
}finally{await browser.close();writeFileSync(new URL('docs/dryrun-browser-mainnet.json',root),JSON.stringify({at:new Date().toISOString(),scope:'Read-only first route per hosted surface; transaction checks are in dryrun-mainnet.json',results},null,2)+'\n');}
if(results.some(r=>!r.ok))process.exitCode=1;
