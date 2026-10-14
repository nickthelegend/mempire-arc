import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
let ts;
for (const p of ['package.json','app/package.json','server/package.json','apps/app/package.json','packages/sdk/package.json']) {
  try { ts = createRequire(new URL(p, root))('typescript'); break; } catch {}
}
if (!ts) throw Error('Install the repository dependencies (TypeScript required)');
registerHooks({
  resolve(s,c,next) {
    if(s==='server-only') return {url:'data:text/javascript,export {};',shortCircuit:true};
    if(s.startsWith('@/')) s=new URL(s.slice(2)+'.ts',root).href;
    try{return next(s,c)}catch(e){
      if(s.startsWith('.') && e.code==='ERR_MODULE_NOT_FOUND') {
        if(s.endsWith('.js')){try{return next(s.slice(0,-3)+'.ts',c)}catch{}}
        for(const ext of ['.ts','/index.ts']){try{return next(s+ext,c)}catch{}}
      }
      throw e;
    }
  },
  load(url,c,next) {
    if(url.endsWith('.ts')&&!url.includes('/node_modules/')) return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
    return next(url,c);
  }
});
