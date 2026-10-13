import {Db} from 'mongodb';
import {isAddress,isHex} from 'viem';
const WC={w:'majority',j:true,wtimeoutMS:8000};
const hash=h=>isHex(h)&&h.length===66;
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export class GatewayJournalError extends Error{constructor(message,status=409){super(message);this.status=status;}}
/** One real Mongo document makes intent claims, job identity and nonce ownership atomic. Never TTL/prune. */
export class GatewayJournal{
 constructor(getDb){this.getDb=getDb;this.id='arc-gateway:5042002';}
 collection(){const db=this.getDb();if(!(db instanceof Db))throw new GatewayJournalError('Durable Mongo Gateway storage is unavailable. No provider or signer handoff is allowed.',503);return db.collection('gateway_journal',{writeConcern:WC});}
 async claim(input){
  if(!hash(input.id)||!isAddress(input.owner)||!isAddress(input.relayer)||input.chainId!==5042002||!Array.isArray(input.intentHashes)||input.intentHashes.length<1||input.intentHashes.length>4||input.intentHashes.some(h=>!hash(h))||new Set(input.intentHashes).size!==input.intentHashes.length)throw new GatewayJournalError('Invalid original Gateway journal identity.',400);
  const c=this.collection();try{await c.updateOne({_id:this.id},{$setOnInsert:{claims:[],jobs:{},nonceClaims:{},count:0}},{upsert:true,writeConcern:WC});}catch(e){if(e.code!==11000)throw e;}
  const entry={id:input.id,owner:input.owner.toLowerCase(),relayer:input.relayer.toLowerCase(),chainId:5042002,minter:input.minter.toLowerCase(),token:input.token.toLowerCase(),intentHashes:input.intentHashes,signatureHashes:input.signatureHashes,intents:input.intents,state:'circle-unknown',createdAt:new Date().toISOString()};
  const doc=await c.findOneAndUpdate({_id:this.id,count:{$lt:1000},claims:{$nin:input.intentHashes},[`jobs.${input.id}`]:{$exists:false}},{$addToSet:{claims:{$each:input.intentHashes}},$set:{[`jobs.${input.id}`]:entry},$inc:{count:1}},{returnDocument:'after',includeResultMetadata:false,writeConcern:WC});
  if(doc){const saved=doc.jobs[input.id];if(JSON.stringify(saved)!==JSON.stringify(entry))throw new GatewayJournalError('Original Gateway claim readback differs.',503);return {created:true,entry:saved};}
  const existing=await this.get(input.id);if(existing&&same(existing.owner,input.owner)&&JSON.stringify(existing.intentHashes)===JSON.stringify(input.intentHashes))return {created:false,entry:existing};
  throw new GatewayJournalError('An original intent is already claimed or permanent journal capacity is reached. No transfer was resubmitted.');
 }
 async get(id){if(!hash(id))throw new GatewayJournalError('Invalid original Gateway identity.',400);const d=await this.collection().findOne({_id:this.id},{projection:{[`jobs.${id}`]:1}});return d?.jobs?.[id]??null;}
 async advance(id,owner,expected,next,values={}){
  if(![['circle-unknown','attested'],['attested','mint-unknown'],['mint-submitted','confirmed']].some(([a,b])=>a===expected&&b===next))throw new GatewayJournalError('Invalid original Gateway state transition.');
  const allowed=next==='attested'?['transferId','attestationHash','attestationSignatureHash']:next==='mint-unknown'?['mintDataHash']:['finalizedBlock','finalizedBlockHash'];
  if(Object.keys(values).some(k=>!allowed.includes(k)))throw new GatewayJournalError('Immutable Gateway fields cannot be replaced.');
  const set={[`jobs.${id}.state`]:next};for(const [k,v]of Object.entries(values))if(v!==undefined)set[`jobs.${id}.${k}`]=v;
  const d=await this.collection().findOneAndUpdate({_id:this.id,[`jobs.${id}.owner`]:owner.toLowerCase(),[`jobs.${id}.state`]:expected},{$set:set},{returnDocument:'after',includeResultMetadata:false,writeConcern:WC});
  if(!d)throw new GatewayJournalError('Original Gateway ownership or state changed. No retry was authorized.');return d.jobs[id];
 }
 async nonceFloor(from){const d=await this.collection().findOne({_id:this.id},{projection:{[`nonceClaims.${from.toLowerCase()}`]:1}});return Object.values(d?.nonceClaims?.[from.toLowerCase()]??{}).reduce((n,r)=>Math.max(n,r.nonce+1),0);}
 async recordSigned(id,owner,identity){
  if(!hash(identity.hash)||!hash(identity.dataHash)||identity.chainId!==5042002||!isAddress(identity.from)||!isAddress(identity.to)||!Number.isSafeInteger(identity.nonce)||identity.nonce<0||['gas','maxFeePerGas','maxPriorityFeePerGas'].some(k=>typeof identity[k]!=='string'||!/^\d+$/.test(identity[k])))throw new GatewayJournalError('Invalid original signed Gateway identity.');
  identity={hash:identity.hash,chainId:identity.chainId,from:identity.from.toLowerCase(),to:identity.to.toLowerCase(),dataHash:identity.dataHash,nonce:identity.nonce,gas:identity.gas,maxFeePerGas:identity.maxFeePerGas,maxPriorityFeePerGas:identity.maxPriorityFeePerGas};
  const nonceKey=`nonceClaims.${identity.from.toLowerCase()}.n${identity.nonce}`;
  const d=await this.collection().findOneAndUpdate({_id:this.id,[`jobs.${id}.owner`]:owner.toLowerCase(),[`jobs.${id}.relayer`]:identity.from.toLowerCase(),[`jobs.${id}.minter`]:identity.to.toLowerCase(),[`jobs.${id}.state`]:'mint-unknown',[`jobs.${id}.mintDataHash`]:identity.dataHash,[`jobs.${id}.identity`]:{$exists:false},[nonceKey]:{$exists:false}},{$set:{[`jobs.${id}.identity`]:identity,[`jobs.${id}.state`]:'mint-submitted',[nonceKey]:{id,hash:identity.hash,nonce:identity.nonce}}},{returnDocument:'after',includeResultMetadata:false,writeConcern:WC});
  if(!d)throw new GatewayJournalError('Original Gateway hash or signer nonce is already owned. Broadcast was not authorized.');
  const saved=await this.get(id);if(JSON.stringify(saved?.identity)!==JSON.stringify(identity))throw new GatewayJournalError('Original signed Gateway readback failed. Broadcast was not authorized.',503);return saved;
 }
}
