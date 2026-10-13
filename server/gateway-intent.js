import {getAddress,hashTypedData,isHex,keccak256,pad,recoverTypedDataAddress,toHex} from 'viem';
export const GATEWAY_TYPES={TransferSpec:[['version','uint32'],['sourceDomain','uint32'],['destinationDomain','uint32'],['sourceContract','bytes32'],['destinationContract','bytes32'],['sourceToken','bytes32'],['destinationToken','bytes32'],['sourceDepositor','bytes32'],['destinationRecipient','bytes32'],['sourceSigner','bytes32'],['destinationCaller','bytes32'],['value','uint256'],['salt','bytes32'],['hookData','bytes']].map(([name,type])=>({name,type})),BurnIntent:[{name:'maxBlockHeight',type:'uint256'},{name:'maxFee',type:'uint256'},{name:'spec',type:'TransferSpec'}]};
const tokens={0:'0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',3:'0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',6:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',26:'0x3600000000000000000000000000000000000000'};
const b32=a=>pad(a.toLowerCase(),{size:32});const uint=(v,positive=false)=>{if(!/^\d+$/.test(String(v)))throw Error('Invalid Gateway integer.');const n=BigInt(v);if(n>=2n**256n||(positive&&n===0n))throw Error('Invalid Gateway amount or limit.');return n;};
export function canonicalGatewayIntent(raw,gateway){
 const p=raw?.spec;if(!p)throw Error('Original Gateway spec is missing.');
 if(p.version!==1||!Number.isSafeInteger(p.sourceDomain)||!tokens[p.sourceDomain]||p.destinationDomain!==26)throw Error('Unsupported Gateway version or source/destination domain.');
 for(const name of ['sourceContract','destinationContract','sourceToken','destinationToken','sourceDepositor','destinationRecipient','sourceSigner','destinationCaller','salt'])if(!isHex(p[name])||p[name].length!==66)throw Error('Invalid Gateway address or salt.');
 const owner=getAddress(`0x${p.sourceDepositor.slice(-40)}`).toLowerCase();
 const expected={sourceContract:b32(gateway.wallet),destinationContract:b32(gateway.minter),sourceToken:b32(tokens[p.sourceDomain]),destinationToken:b32(tokens[26]),sourceDepositor:b32(owner),destinationRecipient:b32(owner),sourceSigner:b32(owner),destinationCaller:pad('0x00',{size:32})};
 for(const [k,v]of Object.entries(expected))if(p[k].toLowerCase()!==v.toLowerCase())throw Error('Gateway contract/token/owner/recipient/caller binding differs.');
 if(p.hookData!=='0x')throw Error('Gateway hooks are not supported.');const value=uint(p.value,true),maxFee=uint(raw.maxFee),maxBlockHeight=uint(raw.maxBlockHeight,true);if(maxFee>20000n)throw Error('Gateway fee exceeds the supported original cap.');
 const spec={version:1,sourceDomain:p.sourceDomain,destinationDomain:26,...expected,value:value.toString(),salt:p.salt.toLowerCase(),hookData:'0x'};
 return {owner,intent:{maxBlockHeight:maxBlockHeight.toString(),maxFee:maxFee.toString(),spec}};
}
export const gatewayTypedData=intent=>({domain:{name:'GatewayWallet',version:'1'},types:GATEWAY_TYPES,primaryType:'BurnIntent',message:intent});
export async function authenticateGatewayRequests(requests,gateway,maxTopup=100){
 if(!Array.isArray(requests)||requests.length<1||requests.length>4)throw Error('Provide 1–4 original signed Gateway intents.');
 const rows=[];let owner;let total=0n;
 for(const r of requests){const canonical=canonicalGatewayIntent(r?.burnIntent,gateway);if(owner&&owner!==canonical.owner)throw Error('All original intents must belong to the same depositing owner.');owner=canonical.owner;if(typeof r.signature!=='string'||!isHex(r.signature))throw Error('Original Gateway signature is missing.');
  const recovered=await recoverTypedDataAddress({...gatewayTypedData(canonical.intent),signature:r.signature});if(recovered.toLowerCase()!==owner)throw Error('The original depositor did not authorize this Gateway intent.');
  rows.push({intent:canonical.intent,intentHash:hashTypedData(gatewayTypedData(canonical.intent)),signature:r.signature,signatureHash:keccak256(r.signature)});total+=BigInt(canonical.intent.spec.value);
 }
 if(!Number.isSafeInteger(maxTopup)||maxTopup<=0||total>BigInt(maxTopup)*1000000n)throw Error('Gateway top-up exceeds the configured supported amount.');
 rows.sort((a,b)=>a.intentHash.localeCompare(b.intentHash));const intentHashes=rows.map(r=>r.intentHash);if(new Set(intentHashes).size!==rows.length)throw Error('Duplicate original intent in request.');
 return {id:keccak256(toHex(JSON.stringify(intentHashes))),owner,intentHashes,signatureHashes:rows.map(r=>r.signatureHash),intents:rows.map(r=>r.intent),requests:rows.map(r=>({burnIntent:r.intent,signature:r.signature}))};
}
