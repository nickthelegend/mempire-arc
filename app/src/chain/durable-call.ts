import {withOriginTransactionLock} from './origin-transaction-lock';
import {isAddress,isHex,keccak256,type Address,type Hex,type PublicClient,type TransactionReceipt} from 'viem';
export type DurableCall={version:1;chainId:number;from:Address;to:Address;dataHash:Hex;value:string;gas:string;nonce:number;maxFeePerGas?:string;maxPriorityFeePerGas?:string;hash?:Hex};
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const key=(chainId:number,from:Address)=>`arc:durable-call:v1:${chainId}:${from.toLowerCase()}`;
const busy=new Set<string>();
export function readCall(s:Store,chainId:number,from:Address):DurableCall|null{
 const raw=s.getItem(key(chainId,from));if(raw===null)return null;let p:DurableCall;try{p=JSON.parse(raw);}catch{throw Error('The original transaction journal is unreadable. New submissions are blocked.');}
 if(!p||p.version!==1||p.chainId!==chainId||typeof p.from!=='string'||p.from.toLowerCase()!==from.toLowerCase()||![p.from,p.to].every(a=>typeof a==='string'&&isAddress(a))||!isHex(p.dataHash)||p.dataHash.length!==66||![p.value,p.gas].every(n=>typeof n==='string'&&/^\d+$/.test(n))||BigInt(p.gas)<=0n||!Number.isSafeInteger(p.nonce)||p.nonce<0||[p.maxFeePerGas,p.maxPriorityFeePerGas].some(n=>n!==undefined&&(typeof n!=='string'||!/^\d+$/.test(n)))||(p.hash!==undefined&&(!isHex(p.hash)||p.hash.length!==66)))throw Error('The original transaction journal is invalid. New submissions are blocked.');
 return {version:1,chainId:p.chainId,from:p.from,to:p.to,dataHash:p.dataHash,value:p.value,gas:p.gas,nonce:p.nonce,maxFeePerGas:p.maxFeePerGas,maxPriorityFeePerGas:p.maxPriorityFeePerGas,hash:p.hash};
}
export function saveCall(s:Store,p:DurableCall){const old=readCall(s,p.chainId,p.from);if(old){for(const f of ['chainId','from','to','dataHash','value','gas','nonce','maxFeePerGas','maxPriorityFeePerGas'] as const)if(old[f]!==p[f])throw Error('The original transaction call cannot be replaced.');if(old.hash&&old.hash!==p.hash)throw Error('The original transaction hash cannot be replaced.');}const safe=readCall({getItem:()=>JSON.stringify(p),setItem(){},removeItem(){}},p.chainId,p.from)!;const raw=JSON.stringify(safe);s.setItem(key(p.chainId,p.from),raw);if(s.getItem(key(p.chainId,p.from))!==raw)throw Error('Transaction journal was not durably saved. Submission is blocked.');}
export function clearCall(s:Store,p:DurableCall){const old=readCall(s,p.chainId,p.from);if(!old||JSON.stringify(old)!==JSON.stringify(readCall({getItem:()=>JSON.stringify(p),setItem(){},removeItem(){}},p.chainId,p.from)))throw Error('Original transaction identity changed.');s.removeItem(key(p.chainId,p.from));if(readCall(s,p.chainId,p.from))throw Error('Original transaction journal could not be cleared.');}
async function recoverCallLocked(client:PublicClient,s:Store,chainId:number,from:Address):Promise<TransactionReceipt>{
 const p=readCall(s,chainId,from);if(!p)throw Error('No original transaction is saved.');if(!p.hash)throw Error('Original submission has no known hash. Genuine wallet/provider history is required; no new signature was requested.');if(await client.getChainId()!==p.chainId)throw Error('Receipt RPC network differs from the original transaction.');
 const [r,tx]=await Promise.all([client.getTransactionReceipt({hash:p.hash}),client.getTransaction({hash:p.hash})]);
 if(r.transactionHash.toLowerCase()!==p.hash.toLowerCase()||tx.hash.toLowerCase()!==p.hash.toLowerCase()||tx.from.toLowerCase()!==p.from.toLowerCase()||r.from.toLowerCase()!==p.from.toLowerCase()||tx.to?.toLowerCase()!==p.to.toLowerCase()||r.to?.toLowerCase()!==p.to.toLowerCase()||keccak256(tx.input).toLowerCase()!==p.dataHash.toLowerCase()||tx.value!==BigInt(p.value)||tx.gas!==BigInt(p.gas)||tx.nonce!==p.nonce||(p.maxFeePerGas!==undefined&&tx.maxFeePerGas!==BigInt(p.maxFeePerGas))||(p.maxPriorityFeePerGas!==undefined&&tx.maxPriorityFeePerGas!==BigInt(p.maxPriorityFeePerGas))||tx.blockHash!==r.blockHash)throw Error('Original transaction has no exact canonical finalized call proof.');
 // A mined receipt can arrive before this RPC's finalized head advances.
 // Keep the original journal/lock and poll finality; never resubmit the call.
 let finalized = false;
 for (let attempt = 0; attempt < 20; attempt++) {
  const head = await client.getBlock({blockTag:'finalized'});
  if (head.number !== null && head.number >= r.blockNumber) { finalized = true; break; }
  await new Promise(resolve => setTimeout(resolve, 500));
 }
 if (!finalized) throw Error('Original transaction is mined but finality is still pending. Check its receipt before any new submission.');
 const canonical=await client.getBlock({blockNumber:r.blockNumber});if(canonical.hash!==r.blockHash)throw Error('Original receipt block is not canonical.');
 if(r.status!=='success'&&r.status!=='reverted')throw Error('Original transaction status is unknown.');clearCall(s,p);if(r.status==='reverted')throw Error(`Original transaction reverted: ${p.hash}`);return r;
}
export async function recoverCall(client:PublicClient,s:Store,chainId:number,from:Address):Promise<TransactionReceipt>{
 return withOriginTransactionLock(key(chainId,from),()=>recoverCallLocked(client,s,chainId,from));
}
export async function submitCall(client:PublicClient,s:Store,input:Omit<DurableCall,'version'|'nonce'|'hash'>,context:()=>Promise<void>,submit:(nonce:number)=>Promise<Hex>):Promise<TransactionReceipt>{
 return withOriginTransactionLock(key(input.chainId,input.from),async()=>{
 const id=key(input.chainId,input.from);if(busy.has(id))throw Error('Original transaction is still in progress.');busy.add(id);
 try{if(readCall(s,input.chainId,input.from))throw Error('An original transaction is unresolved. Check its receipt before any new submission.');await context();if(await client.getChainId()!==input.chainId)throw Error('RPC network changed.');const nonce=await client.getTransactionCount({address:input.from,blockTag:'pending'});await context();if(readCall(s,input.chainId,input.from))throw Error('Another transaction was saved while checking the wallet.');let p:DurableCall={...input,version:1,nonce};saveCall(s,p);
 // Wallet sendTransaction may sign and submit internally: even a rejection is opaque after invocation.
 const hash=await submit(nonce);p={...p,hash};saveCall(s,p);await client.waitForTransactionReceipt({hash,timeout:60000});return await recoverCallLocked(client,s,input.chainId,input.from);
 }finally{busy.delete(id);}
 });
}
