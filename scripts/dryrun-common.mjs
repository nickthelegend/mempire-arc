/** Mainnet reads only; every mutation is restricted to the child Arc Anvil on loopback.
 * Raw signed transactions and private keys are never written to disk or logged.
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const ROOT=new URL('../',import.meta.url), ARC=new URL('../',ROOT);
let req;
for(const path of ['package.json','app/package.json','server/package.json','apps/app/package.json','packages/sdk/package.json']){
 try {const r=createRequire(new URL(path,ROOT));r.resolve('viem');req=r;break;}catch{}
}
const v=req('viem'), acc=req('viem/accounts');
export const {parseAbi,parseEther,decodeEventLog,encodeFunctionData,keccak256,toHex,parseSignature,formatEther}=v;
export const USDC='0x3600000000000000000000000000000000000000', MEMO='0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
export const readJson=p=>JSON.parse(fs.readFileSync(new URL(p,ROOT),'utf8'));
export const json=o=>JSON.stringify(o,(_,x)=>typeof x==='bigint'?x.toString():x,2);
export const erc=parseAbi(['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function nonces(address) view returns(uint256)','function name() view returns(string)','function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)']);
export const accounts={}, roles={}, keys={};
let child,lock,pub,report,out;
export {pub};
const REMOTE='https://rpc.mainnet.arc.io';
async function remote(method,params=[]) {
 if(!['eth_chainId','eth_getBlockByNumber','eth_call','eth_estimateGas','eth_getCode'].includes(method))throw Error('Remote method prohibited');
 const r=await fetch(REMOTE,{method:'POST',headers:{'content-type':'application/json'},body:json({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)}).then(r=>r.json());
 if(r.error){const e=Error(r.error.message);e.data=r.error.data;throw e;}return r.result;
}
export const RPC='http://127.0.0.1:9508';
export async function rpc(method,params=[]){
 if(!child||child.exitCode!==null)throw Error('Owned fork is not running');
 return pub.request({method,params});
}
export function fresh(role){keys[role]=acc.generatePrivateKey();accounts[role]=acc.privateKeyToAccount(keys[role]);roles[role]=accounts[role].address;return accounts[role];}
export function roleKey(role,file,variable,expected){
 const text=fs.readFileSync(new URL('.deployer/mainnet/'+file+'.env',ARC),'utf8');
 const match=text.match(new RegExp('^(?:export\\s+)?'+variable+'\\s*=\\s*["\']?(0x[0-9a-fA-F]{64})','m'));
 if(!match)throw Error('Missing role key '+role);
 keys[role]=match[1];accounts[role]=acc.privateKeyToAccount(keys[role]);roles[role]=accounts[role].address;
 if(expected&&expected.toLowerCase()!==roles[role].toLowerCase())throw Error('Role address mismatch: '+role);
}
export const load=n=>readJson(n==='polaris'?'packages/contracts/deployments/arc-mainnet.json':'deployments/arc-mainnet.json');
export function abi(n,name){
 const p=n==='polaris'?'packages/contracts/abi/'+name+'.json':n==='mempire'?'app/src/shared/abi/'+name+'.json':(n==='kakushi'?'packages/contracts':'contracts')+'/out/'+name+'.sol/'+name+'.json';
 const x=readJson(p);return x.abi??x;
}
export const read=(address,abi,functionName,args=[])=>pub.readContract({address,abi,functionName,args});
export const bal=address=>read(USDC,erc,'balanceOf',[address]);
export async function fund(n,role){await rpc('anvil_setBalance',[roles[role],toHex(parseEther('100'))]);}
export function note(key,value){report.notes[key]=value;save();}
function save(){fs.mkdirSync(new URL('docs/',ROOT),{recursive:true});fs.writeFileSync(out,json(report)+'\n');}
function err(e,abi=[]){
 let x=e;for(let i=0;x&&i<12;i++,x=x.cause){
  let data=x.data;if(typeof data==='object')data=data?.data;
  if(typeof data==='string'&&data.startsWith('0x')){try{const d=v.decodeErrorResult({abi,data});return {name:d.errorName,args:d.args,data};}catch{if(data!=='0x')return {name:'UnknownRevert',data};}}
 }
 return {name:'RPCError',message:String(e.shortMessage??e.message).split('\n')[0].slice(0,240)};
}
export async function tx(n,purpose,role,to,data='0x',value=0n,expect='success',gasHint,abi=[]){
 const account=accounts[role];if(!account)throw Error('No signing key for '+role);
 const nonce=await pub.getTransactionCount({address:account.address,blockTag:'pending'});
 const base=BigInt(report.baseFeePerGas), fee=base*2n+1000000000n;
 const request={from:account.address,to,data,value:toHex(value),gas:toHex(gasHint??15000000n),maxFeePerGas:toHex(fee),maxPriorityFeePerGas:'0x0'};
 const initialEstimate=await Promise.allSettled([rpc('eth_estimateGas',[request])]);
 const initialGas=initialEstimate[0].status==='fulfilled'?BigInt(initialEstimate[0].value):null;
 const unsigned={type:'eip1559',chainId:5042,to,data,value,nonce,gas:initialGas?initialGas*12n/10n+10000n:gasHint??15000000n,maxFeePerGas:fee,maxPriorityFeePerGas:0n};
 const raw=await account.signTransaction(unsigned), decoded=v.parseTransaction(raw), recovered=await v.recoverTransactionAddress({serializedTransaction:raw});
 const verified=decoded.to.toLowerCase()===to.toLowerCase()&&decoded.chainId===5042&&decoded.nonce===nonce&&decoded.data===data&&(decoded.value??0n)===value&&recovered.toLowerCase()===account.address.toLowerCase();
 if(!verified)throw Error('Signed transaction round-trip mismatch');
 const exactRequest={...request,gas:toHex(decoded.gas),nonce:toHex(decoded.nonce)};
 const checks=await Promise.allSettled([rpc('eth_call',[exactRequest,'latest']),rpc('eth_estimateGas',[exactRequest])]);
 const gas=checks[1].status==='fulfilled'?BigInt(checks[1].value):null;
 const errors=checks.map(c=>c.status==='rejected'?err(c.reason,abi):null);
 const ok=expect==='success'?checks.every(c=>c.status==='fulfilled'):errors.every(e=>e?.name===expect);
 const row={purpose,to,selector:data.slice(0,10),from:account.address,nonce,chainId:5042,signedHash:keccak256(raw),calldataHash:keccak256(data),signedGas:decoded.gas,decodedVerified:verified,simulatedSignedFields:true,call:errors[0]??'ok',estimate:errors[1]??'ok',gas,usdcFeeAtBaseFee:gas===null?null:formatEther(gas*base),result:ok?(expect==='success'?'ok':'expected revert '+expect):'FAIL',mode:'Fork'};
 report.transactions.push(row);save();console.log(purpose+': '+row.result+(errors[0]?' ('+errors[0].name+')':''));
 if(!ok)throw Error(purpose+': '+json(errors));
 if(expect!=='success')return row;
 // The ONLY broadcast in this harness: child process on hard-coded localhost.
 const hash=await rpc('eth_sendRawTransaction',[raw]);
 const receipt=await pub.waitForTransactionReceipt({hash});
 row.localGasUsed=receipt.gasUsed;row.localReceiptStatus=receipt.status;save();
 if(receipt.status!=='success'){row.result='FAIL';save();throw Error('Local execution diverged from simulation: '+purpose);}
 return receipt;
}
export const write=(n,purpose,role,address,abi,fn,args=[],expect='success',gas)=>tx(n,purpose,role,address,encodeFunctionData({abi,functionName:fn,args}),0n,expect,gas,abi);
export const approve=(n,role,spender,amount,token=USDC)=>write(n,'approve '+token+' to '+spender,role,token,erc,'approve',[spender,amount]);
export const memoAbi=parseAbi(['function memo(address target,bytes data,bytes32 memoId,bytes memoData) returns(bytes)']);
export const memoWrite=(n,purpose,role,address,abi,fn,args=[],gas)=>tx(n,purpose,role,MEMO,encodeFunctionData({abi:memoAbi,functionName:'memo',args:[address,encodeFunctionData({abi,functionName:fn,args}),keccak256(toHex(n+purpose)),toHex(n+purpose)]}),0n,'success',gas,abi);
export const identity='0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export async function register(n,role){const r=await write(n,'ERC-8004 register '+role,role,identity,parseAbi(['function register(string) returns(uint256)']),'register',['https://dryrun.invalid/'+n]);return BigInt(r.logs.find(l=>l.address.toLowerCase()===identity.toLowerCase()&&l.topics.length===4).topics[3]);}
export async function auth(role,to,value,nonce=keccak256(toHex('dryrun'+Date.now())),primaryType='TransferWithAuthorization',window=86400n){
 const message={from:roles[role],to,value,validAfter:0n,validBefore:(await pub.getBlock()).timestamp+window,nonce};
 const signature=await accounts[role].signTypedData({domain:{name:'USDC',version:'2',chainId:5042,verifyingContract:USDC},types:{[primaryType]:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},primaryType,message});
 const {r,s,v}=parseSignature(signature);return {...message,r,s,v:Number(v),signature};
}
export async function permit(role,spender,value,token=USDC){
 const deadline=(await pub.getBlock()).timestamp+1800n,nonce=await read(token,erc,'nonces',[roles[role]]);
 const signature=await accounts[role].signTypedData({domain:{name:token===USDC?'USDC':await read(token,erc,'name'),version:token===USDC?'2':'1',chainId:5042,verifyingContract:token},types:{Permit:[{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]},primaryType:'Permit',message:{owner:roles[role],spender,value,nonce,deadline}});
 const {v,r,s}=parseSignature(signature);return {deadline,v:Number(v),r,s};
}
export async function run(n,flow){
 out=new URL('docs/dryrun-mainnet.json',ROOT);
 report={project:n,mode:'Fork',timestamp:new Date().toISOString(),chainId:5042,remote:REMOTE,transactions:[],notes:{},verdict:'FAIL'};
 const stop=()=>{if(child&&child.exitCode===null)child.kill('SIGTERM');};
 process.once('SIGINT',()=>{stop();process.exitCode=130;});process.once('SIGTERM',()=>{stop();process.exitCode=143;});
 try{
  const block=await remote('eth_getBlockByNumber',['latest',false]);
  if(await remote('eth_chainId')!=='0x13b2')throw Error('Wrong mainnet chain');
  Object.assign(report,{forkBlock:BigInt(block.number).toString(),forkBlockHash:block.hash,baseFeePerGas:BigInt(block.baseFeePerGas).toString()});
  fresh('probe');const address=roles.probe,override={[address]:{balance:toHex(parseEther('100'))}};
  const req={from:address,to:USDC,data:encodeFunctionData({abi:erc,functionName:'approve',args:[address,1n]})};
  const probe=await Promise.allSettled([remote('eth_call',[req,block.number,override]),remote('eth_estimateGas',[req,block.number,override])]);
  report.remoteOverrideProbe=probe.map(x=>x.status==='fulfilled'?{status:'ok',value:x.value}:{status:'unsupported',error:err(x.reason)});
  report.notes.forkReason='Sequential dependent flows require persisted approvals, deposits, new token addresses and spent authorization nonces. Only signer balances are overridden; contract code, oracle and pool state are unchanged.';
  const lockPath=new URL('.tools/dryrun-mainnet.lock',ARC);fs.mkdirSync(lockPath);lock=lockPath;
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(Error('Port 9508 already occupied; refusing to use an existing node')));server.listen(9508,'127.0.0.1',()=>server.close(resolve));});
  child=spawn(fileURLToPath(new URL('.tools/arcfoundry/anvil',ARC)),['--network','arc','--fork-url',REMOTE,'--fork-block-number',report.forkBlock,'--chain-id','5042','--host','127.0.0.1','--port','9508','--silent','--no-rate-limit'],{stdio:'ignore'});
  child.on('error',()=>{});
  const chain=v.defineChain({id:5042,name:'Arc mainnet LOCAL fork',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[RPC]}}});
  pub=v.createPublicClient({chain,transport:v.http(RPC,{retryCount:0,timeout:30000}),pollingInterval:20,cacheTime:0});
  let ready=false;for(let i=0;i<100;i++){try{if(await pub.getChainId()===5042){await rpc('anvil_nodeInfo');ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  if(!ready)throw Error('Arc fork failed to start');
  // Ensure connection is to our child: it must still be alive after startup.
  if(child.exitCode!==null)throw Error('Fork port occupied');
  for(const role of ['buyer','buyer2','provider','relayer','issuer','auditor','verifier','executor','keeper','treasury','admin'])fresh(role);
  await flow();report.verdict='PASS';
 }catch(e){report.failure=String(e.message).slice(0,2000);console.error(n+': FAIL '+report.failure);process.exitCode=1;}
 finally{try{save();}finally{stop();if(child&&child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));if(lock)fs.rmdirSync(lock);}}
}
