import {withBridgeWorkflow} from './bridge-workflow-lock';
import {
  decodeFunctionData,encodeFunctionData,keccak256,toHex,parseEventLogs,parseAbi,createPublicClient, createWalletClient, erc20Abi, http, parseSignature,
  type Abi, type Address, type Chain, type Hex, type LocalAccount,
} from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import remoteAbiJson from '../shared/abi/MempireRemoteEntry.json';
import { CHAIN_ID, DEPLOYMENT, IS_MAINNET, USDC, publicClient } from '../chain/provider';
import { ARENA_ABI } from '../chain/read';
import {activeSigner,type Signer} from '../chain/account';
import {submitCall,recoverCall,readCall} from '../chain/durable-call';
import {readRemote,saveRemote,clearRemote,type RemotePending} from './ccip-pending';

/*
 * Play from Base or Ethereum: "CCTP moves the dollars, CCIP carries the
 * instruction".
 *
 * The passkey account has the same address on every EVM chain. From Base (or
 * Ethereum) one transaction to MempireRemoteEntry burns the player's USDC with
 * CCTP V2 Fast Transfer to that same address on Arc, and sends a Chainlink
 * CCIP message to MempireCCIPGateway on Arc saying "open a $1 match with these
 * cards" — the stake permit (Arc USDC, signed here) rides inside it. Whichever
 * lands first, the relay completes the instruction once the dollars are there.
 * The CCIP fee is paid in the source chain's native token.
 *
 * Remote entries are deployed per source chain (scripts/deploy-remote.sh) and
 * configured with VITE_REMOTE_ENTRY_BASE / VITE_REMOTE_ENTRY_ETHEREUM.
 */

const REMOTE_ABI = remoteAbiJson as Abi;

export interface RemoteChain {
  key: 'base' | 'ethereum';
  label: string;
  chain: Chain;
  entry: Address | null;
  usdc: Address;
  cctpDomain: number;
}

const env = (k: string): Address | null => {
  const v = (import.meta.env as Record<string, string | undefined>)[k];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v as Address : null;
};

export const REMOTE_CHAINS: RemoteChain[] = IS_MAINNET || CHAIN_ID === 31337
  ? [
    { key: 'base', label: 'Base', chain: base, entry: env('VITE_REMOTE_ENTRY_BASE'), usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', cctpDomain: 6 },
    { key: 'ethereum', label: 'Ethereum', chain: mainnet, entry: env('VITE_REMOTE_ENTRY_ETHEREUM'), usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', cctpDomain: 0 },
  ]
  : [
    { key: 'base', label: 'Base Sepolia', chain: baseSepolia, entry: env('VITE_REMOTE_ENTRY_BASE'), usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', cctpDomain: 6 },
    { key: 'ethereum', label: 'Ethereum Sepolia', chain: sepolia, entry: env('VITE_REMOTE_ENTRY_ETHEREUM'), usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', cctpDomain: 0 },
  ];

/** The source-chain balances that matter for a cross-chain entry. */
export async function remoteBalances(rc: RemoteChain, who: Address) {
  const c = createPublicClient({ chain: rc.chain, transport: http() });
  const [native, usdc] = await Promise.all([
    c.getBalance({ address: who }),
    c.readContract({ address: rc.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
  ]);
  return { native, usdc };
}

/**
 * Open (matchId 0) or join a match on Arc from `rc`, bridging `bridgeUnits`
 * USDC with CCTP in the same source transaction. Signs the Arc stake permit
 * with the passkey account, approves the remote entry for the bridged USDC if
 * needed, quotes the CCIP fee and sends. Returns the source tx and CCIP message id.
 */
export async function enterFromRemote(s:Signer,rc:RemoteChain,opts:{matchId?:bigint;tier:number;cardIds:bigint[];bridgeUnits:bigint}):Promise<{hash:Hex;explorer:string}>{
 return withBridgeWorkflow(CHAIN_ID,s.address,()=>enterFromRemoteLocked(s,rc,opts));
}

async function enterFromRemoteLocked(
  s: Signer, rc: RemoteChain, opts: { matchId?: bigint; tier: number; cardIds: bigint[]; bridgeUnits: bigint },
): Promise<{ hash: Hex; explorer: string }> {
  if (!rc.entry) throw new Error(`no Mempire entry deployed on ${rc.label} yet`);
  if (!DEPLOYMENT) throw new Error('no arena on this network');
  const account = s.account as LocalAccount;
  if (typeof account === 'string'||typeof account.signTypedData!=='function') throw new Error('cross-chain entry needs the passkey (or guest) account');
  if(readRemote(localStorage,s.address))throw Error('An original remote entry is unresolved. Check it before signing again.');
  const inputHash=keccak256(toHex(JSON.stringify({matchId:String(opts.matchId??0n),tier:opts.tier,cards:opts.cardIds.map(String),bridgeUnits:String(opts.bridgeUnits)})));
  let original:RemotePending={version:1,chainId:rc.chain.id,destinationChainId:CHAIN_ID,owner:s.address,entry:rc.entry,token:rc.usdc,arena:DEPLOYMENT.arena,inputHash,stage:'prepared'};
  saveRemote(localStorage,original);
  let submissionStarted=false;
  try{
  const arc = publicClient();
  if(await arc.getChainId()!==CHAIN_ID||activeSigner()!==s)throw Error('Original Arc network or player changed.');
  const srcCheck=createPublicClient({chain:rc.chain,transport:http()});
  if(await srcCheck.getChainId()!==rc.chain.id)throw Error('Original source RPC network differs.');
  const [sourceCode,configuredToken,configuredGateway,arenaCode]=await Promise.all([srcCheck.getCode({address:rc.entry}),srcCheck.readContract({address:rc.entry,abi:REMOTE_ABI,functionName:'usdc'}),srcCheck.readContract({address:rc.entry,abi:REMOTE_ABI,functionName:'arcGateway'}),arc.getCode({address:DEPLOYMENT.arena})]);
  if(!sourceCode||sourceCode==='0x'||!arenaCode||arenaCode==='0x'||String(configuredToken).toLowerCase()!==rc.usdc.toLowerCase()||String(configuredGateway).toLowerCase()!==DEPLOYMENT.ccipGateway.toLowerCase())throw Error('Actual remote entry token/gateway or Arc arena deployment is unavailable.');
  const stake = await arc.readContract({ address: DEPLOYMENT.arena, abi: ARENA_ABI, functionName: 'stakeFor', args: [opts.tier] }) as bigint;
  const nonce = await arc.readContract({
    address: USDC, abi: [{ type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'nonces', args: [s.address],
  }) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sig = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC },
    types: { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'Permit',
    message: { owner: s.address, spender: DEPLOYMENT.arena, value: stake, nonce, deadline },
  });
  const { r, s: ss, v, yParity } = parseSignature(sig);
  const order = {
    matchId: opts.matchId ?? 0n, tier: opts.tier, cardIds: opts.cardIds, session: '0x0000000000000000000000000000000000000000' as Address,
    permitDeadline: deadline, v: Number(v ?? BigInt(yParity + 27)), r, s: ss,
  };

  const src = createPublicClient({ chain: rc.chain, transport: http() });
  const wallet = createWalletClient({ account, chain: rc.chain, transport: http() });
  const context=async()=>{if(activeSigner()!==s||await src.getChainId()!==rc.chain.id||account.address.toLowerCase()!==s.address.toLowerCase())throw Error('Original source network/player changed.');};
  const submit=async(to:Address,data:Hex,value:bigint,stage:'approval'|'entry')=>{
    await context();const gas=await src.estimateGas({account:s.address,to,data,value});const fees=await src.estimateFeesPerGas();
    original={...original,stage,callHash:keccak256(data),hash:undefined};saveRemote(localStorage,original);submissionStarted=true;
    const receipt=await submitCall(src,localStorage,{chainId:rc.chain.id,from:s.address,to,dataHash:keccak256(data),value:String(value),gas:String(gas),maxFeePerGas:fees.maxFeePerGas?.toString(),maxPriorityFeePerGas:fees.maxPriorityFeePerGas?.toString()},context,async nonce=>{const hash=await wallet.sendTransaction({to,data,value,gas,nonce,...fees});original={...original,hash};saveRemote(localStorage,original);return hash;});return receipt;
  };
  if(opts.bridgeUnits>0n){const allowance=await src.readContract({address:rc.usdc,abi:erc20Abi,functionName:'allowance',args:[s.address,rc.entry]});if(allowance<opts.bridgeUnits){const receipt=await submit(rc.usdc,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[rc.entry,opts.bridgeUnits]}),0n,'approval');const approved=parseEventLogs({abi:erc20Abi,eventName:'Approval',logs:receipt.logs}).some(l=>l.address.toLowerCase()===rc.usdc.toLowerCase()&&l.args.owner.toLowerCase()===s.address.toLowerCase()&&l.args.spender.toLowerCase()===rc.entry!.toLowerCase()&&l.args.value===opts.bridgeUnits);if(!approved)throw Error('Original approval has no matching Approval event.');}}
  const fee=await src.readContract({address:rc.entry,abi:REMOTE_ABI,functionName:'quoteEnter',args:[order]}) as bigint;
  const receipt=await submit(rc.entry,encodeFunctionData({abi:REMOTE_ABI,functionName:'enter',args:[order,opts.bridgeUnits,opts.bridgeUnits/200n]}),(fee*11n)/10n,'entry');
  const event=parseEventLogs({abi:parseAbi(['event EnterSent(bytes32 indexed messageId,address indexed player,uint256 bridged,uint64 matchId,uint8 tier)']),eventName:'EnterSent',logs:receipt.logs}).find(l=>!l.removed&&l.address.toLowerCase()===rc.entry!.toLowerCase()&&l.transactionHash===receipt.transactionHash&&l.blockHash===receipt.blockHash&&l.args.player.toLowerCase()===s.address.toLowerCase()&&l.args.bridged===opts.bridgeUnits&&l.args.matchId===(opts.matchId??0n)&&l.args.tier===opts.tier);
  if(!event)throw Error('Original source entry has no matching EnterSent instruction. Arc match completion is unverified.');
  // Keep the original entry permanently locked until actual destination outcome is reconciled.
  return {hash:receipt.transactionHash,explorer:`https://ccip.chain.link/tx/${receipt.transactionHash}`};
  }catch(error){if(!submissionStarted&&original.stage==='prepared')clearRemote(localStorage,original);throw error;}

}

/** Read-only source receipt recovery. A source instruction is never a destination match success. */
export async function recoverRemoteEntry(s:Signer){
 return withBridgeWorkflow(CHAIN_ID,s.address,()=>recoverRemoteEntryLocked(s));
}
async function recoverRemoteEntryLocked(s:Signer){
 const p=readRemote(localStorage,s.address);if(!p)throw Error('No original remote entry is saved.');const rc=REMOTE_CHAINS.find(c=>c.chain.id===p.chainId&&c.entry?.toLowerCase()===p.entry.toLowerCase());if(!rc||p.destinationChainId!==CHAIN_ID||p.arena.toLowerCase()!==DEPLOYMENT?.arena.toLowerCase())throw Error('Original remote route is not configured.');if(!p.hash||!p.callHash)throw Error('Original remote outcome has no known call/hash; genuine wallet/provider history is required.');
 const client=createPublicClient({chain:rc.chain,transport:http()});if(await client.getChainId()!==p.chainId)throw Error('Original source RPC differs.');const [r,tx,final]=await Promise.all([client.getTransactionReceipt({hash:p.hash}),client.getTransaction({hash:p.hash}),client.getBlock({blockTag:'finalized'})]);const to=p.stage==='approval'?p.token:p.entry;
 if(r.status!=='success'||r.transactionHash!==p.hash||tx.hash!==p.hash||tx.from.toLowerCase()!==p.owner.toLowerCase()||r.from.toLowerCase()!==p.owner.toLowerCase()||tx.to?.toLowerCase()!==to.toLowerCase()||r.to?.toLowerCase()!==to.toLowerCase()||keccak256(tx.input)!==p.callHash||tx.blockHash!==r.blockHash||final.number===null||final.number<r.blockNumber)throw Error('No exact finalized original source call was verified.');const block=await client.getBlock({blockNumber:r.blockNumber});if(block.hash!==r.blockHash)throw Error('Original source block is not canonical.');
 const call=readCall(localStorage,p.chainId,p.owner);if(call){if(call.hash!==p.hash)throw Error('Original source call/hash differs.');await recoverCall(client,localStorage,p.chainId,p.owner);}
 if(p.stage==='approval')return {hash:p.hash,stage:'approval' as const,message:'Original approval finalized. No entry or Arc match completion was verified; the workflow remains locked.'};
 const event=parseEventLogs({abi:parseAbi(['event EnterSent(bytes32 indexed messageId,address indexed player,uint256 bridged,uint64 matchId,uint8 tier)']),eventName:'EnterSent',logs:r.logs}).find(l=>!l.removed&&l.address.toLowerCase()===p.entry.toLowerCase()&&l.transactionHash===p.hash&&l.blockHash===r.blockHash&&l.args.player.toLowerCase()===p.owner.toLowerCase());if(!event)throw Error('Original source has no matching EnterSent instruction.');
 const decoded=decodeFunctionData({abi:REMOTE_ABI,data:tx.input});if(decoded.functionName!=='enter'||!decoded.args)throw Error('Original source calldata is not an entry.');
 const order=decoded.args[0] as {matchId:bigint;tier:number;cardIds:bigint[];session:Address};const bridge=decoded.args[1] as bigint;
 const publicHash=keccak256(toHex(JSON.stringify({matchId:String(order.matchId),tier:order.tier,cards:order.cardIds.map(String),bridgeUnits:String(bridge)})));
 if(publicHash!==p.inputHash||event.args.matchId!==order.matchId||event.args.tier!==order.tier||event.args.bridged!==bridge)throw Error('Original source input/event binding differs.');
 const arc=publicClient();if(await arc.getChainId()!==p.destinationChainId)throw Error('Destination RPC network differs.');const finalArc=await arc.getBlock({blockTag:'finalized'});if(finalArc.number===null)throw Error('Finalized destination history is unavailable.');
 const destinationAbi=parseAbi(['event Entered(bytes32 indexed messageId,address indexed player,uint64 matchId,bool created)','function messageStatus(bytes32) view returns (uint8)']);
 // No deployment block is configured; a provider/archive refusal stays unknown, never an empty success.
 const entries=await arc.getLogs({address:DEPLOYMENT!.ccipGateway,event:destinationAbi[0],args:{messageId:event.args.messageId,player:p.owner},fromBlock:0n,toBlock:finalArc.number,strict:true});const hashes=[...new Set(entries.filter(l=>!l.removed&&l.transactionHash).map(l=>l.transactionHash!))];
 if(!hashes.length){const status=await arc.readContract({address:DEPLOYMENT!.ccipGateway,abi:destinationAbi,functionName:'messageStatus',args:[event.args.messageId],blockNumber:finalArc.number});return {hash:p.hash,stage:'entry' as const,message:status===1?'Original CCIP instruction failed on Arc; no recovery transaction was sent and the workflow stays locked.':'Original instruction finalized on the source; no finalized Arc match completion was found. Workflow stays locked.'};}
 if(hashes.length!==1)throw Error('Conflicting destination instruction receipts; no completion inferred.');const dest=await arc.getTransactionReceipt({hash:hashes[0]!});const [destBlock,receiverCode]=await Promise.all([arc.getBlock({blockNumber:dest.blockNumber}),arc.getCode({address:DEPLOYMENT!.ccipGateway,blockNumber:dest.blockNumber})]);if(dest.status!=='success'||destBlock.hash!==dest.blockHash||dest.blockNumber>finalArc.number||!receiverCode||receiverCode==='0x')throw Error('Destination completion receipt is not canonical finalized.');
 const entered=parseEventLogs({abi:destinationAbi,eventName:'Entered',logs:dest.logs}).find(l=>!l.removed&&l.address.toLowerCase()===DEPLOYMENT!.ccipGateway.toLowerCase()&&l.transactionHash===dest.transactionHash&&l.blockHash===dest.blockHash&&l.args.messageId===event.args.messageId&&l.args.player.toLowerCase()===p.owner.toLowerCase()&&l.args.created===(order.matchId===0n)&&(order.matchId===0n||l.args.matchId===order.matchId));if(!entered)throw Error('Destination receipt has no exact Entered correlation.');
 const receiverAbi=parseAbi(['function arena() view returns(address)','function usdc() view returns(address)']);const [actualArena,actualToken]=await Promise.all([arc.readContract({address:DEPLOYMENT!.ccipGateway,abi:receiverAbi,functionName:'arena',blockNumber:dest.blockNumber}),arc.readContract({address:DEPLOYMENT!.ccipGateway,abi:receiverAbi,functionName:'usdc',blockNumber:dest.blockNumber})]);if(actualArena.toLowerCase()!==p.arena.toLowerCase()||actualToken.toLowerCase()!==USDC.toLowerCase())throw Error('Actual receiver arena/token binding differs.');
 const arenaEvents=parseEventLogs({abi:ARENA_ABI,eventName:entered.args.created?'MatchCreated':'MatchJoined',logs:dest.logs});const matched=arenaEvents.some(l=>!l.removed&&l.address.toLowerCase()===p.arena.toLowerCase()&&l.transactionHash===dest.transactionHash&&l.blockHash===dest.blockHash&&String((l.args as {matchId:bigint}).matchId)===String(entered.args.matchId)&&(l.args as {player:Address}).player.toLowerCase()===p.owner.toLowerCase()&&JSON.stringify((l.args as {cardIds:bigint[]}).cardIds.map(String))===JSON.stringify(order.cardIds.map(String))&&(l.args as {session:Address}).session.toLowerCase()===order.session.toLowerCase()&&(!entered.args.created||((l.args as {tier:number}).tier===order.tier&&(l.args as {currency:Address}).currency.toLowerCase()===USDC.toLowerCase())));if(!matched)throw Error('Destination receipt has no matching actual arena match event.');
 clearRemote(localStorage,p);return {hash:dest.transactionHash,stage:'completed' as const,message:`Original CCIP instruction and actual Arc match ${entered.args.matchId} are verified in one canonical finalized receipt.`};
}
