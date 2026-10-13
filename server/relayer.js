/**
 * The relayer: the one key this server signs transactions with.
 *
 * # What it may do
 *
 * `MempireCards.mintStarter` is relayer-only, so this key is what turns a new
 * address into a player with a deck. It also pays the onboarding USDC drip on
 * test chains. It is deliberately NOT the deployer or owner key —
 * that one can change the treasury, the rake and the relayer itself, and a web
 * server is the wrong place for it. Losing this key costs a refill and a
 * `setRelayer`; losing the owner key costs the game. Boot refuses a relayer
 * that is either.
 *
 * # One queue
 *
 * Every transaction this key sends goes through `sendRelayerTx`, and that
 * function runs one submission at a time. Two onboarding requests arriving
 * together would otherwise both read the same pending nonce, and the second
 * transaction would either replace the first or be rejected — a starter deck
 * that silently never lands. viem's nonce manager hands out consecutive nonces
 * and resets itself when a send fails; the queue makes sure estimate, sign and
 * send for one transaction finish before the next begins, so a failed send's
 * reset cannot race a later transaction's nonce. Receipts are awaited outside
 * the queue: waiting for inclusion is not what needs to be serial, and holding
 * the queue for it would cap the relayer at one transaction per block.
 *
 * # Gas
 *
 * Gas on Arc is paid in USDC. Every send is estimated and given a 15% margin —
 * enough to absorb state moving between the estimate and inclusion, and no
 * more. Arc's mempool silently drops anything with maxFeePerGas under 20 gwei
 * (no error, no receipt), so fees are floored there rather than trusted to
 * the node's suggestion.
 */
import { createWalletClient, http, encodeFunctionData,keccak256,parseTransaction,recoverTransactionAddress } from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID } from './chain.js';
import { RPC_URL, abis, chain, deployment, feeParams, publicClient, sameAddress } from './chain.js';

const GAS_MARGIN_NUM = 115n;
const GAS_MARGIN_DEN = 100n;

let account = null;
let wallet = null;
let refusal = null;

(() => {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) { refusal = 'RELAYER_PRIVATE_KEY is not set'; return; }
  try {
    account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`, { nonceManager });
  } catch {
    refusal = 'RELAYER_PRIVATE_KEY is not a valid private key';
    return;
  }
  if (deployment?.deployer && sameAddress(account.address, deployment.deployer)) {
    account = null;
    refusal = 'RELAYER_PRIVATE_KEY is the deployer key — use a separate relayer key';
    return;
  }
  wallet = createWalletClient({ account, chain, transport: http(RPC_URL, { retryCount: 1, timeout: 20_000 }) });
})();

/** The relayer's address, or null when there is no usable key. */
export const relayerAddress = () => account?.address ?? null;
/** Why there is no relayer, for logs and 503 bodies. */
export const relayerRefusal = () => refusal;

/**
 * Checks the relayer against the chain once, at boot: it must be the address
 * `MempireCards.relayer()` names, and it must own nothing.
 *
 * The deployer comparison above catches the common mistake for free; this one
 * catches the owner having moved since deployment (`Ownable2Step`). A relayer
 * that is not the contract's relayer is not fatal — the drip still works — but
 * every starter mint would revert, so it is reported rather than discovered.
 */
export async function checkRelayer() {
  if (!account || !deployment) return { ok: false, reason: refusal ?? 'no deployment for this chain' };
  const client = publicClient();
  const readOwner = (address, abi) => client.readContract({ address, abi, functionName: 'owner' }).catch(() => null);
  const [cardsOwner, arenaOwner, cardsRelayer] = await Promise.all([
    readOwner(deployment.cards, abis.cards),
    readOwner(deployment.arena, abis.arena),
    client.readContract({ address: deployment.cards, abi: abis.cards, functionName: 'relayer' }),
  ]);
  if ([cardsOwner, arenaOwner].some((o) => o && sameAddress(o, account.address))) {
    // Disarm rather than merely warn: an owner key in a web server is the
    // exact thing this module exists to prevent.
    refusal = 'RELAYER_PRIVATE_KEY owns a game contract — use a separate relayer key';
    account = null;
    wallet = null;
    return { ok: false, reason: refusal };
  }
  if (!sameAddress(cardsRelayer, account.address)) {
    return { ok: true, canMint: false, reason: `MempireCards.relayer() is ${cardsRelayer}, not this key` };
  }
  return { ok: true, canMint: true };
}

let tail = Promise.resolve();

/**
 * Sends one relayer transaction through the serialized queue and waits for its
 * receipt.
 *
 * `call` is either `{ to, value }` for a plain transfer or
 * `{ address, abi, functionName, args, value }` for a contract write. The gas
 * estimate doubles as a simulation, so a call that would revert fails here with
 * the contract's reason and costs nothing — a reverted transaction still pays
 * for its gas.
 *
 * Resolves `{ hash, receipt }`; throws if the transaction could not be sent or
 * reverted on chain. A thrown error carries `.hash` when the transaction did
 * reach the network, so callers can tell "nothing happened" from "it landed
 * and failed".
 */
export async function sendRelayerTx(call) {
  if (!wallet) throw new Error(refusal ?? 'relayer not configured');
  const client = publicClient();

  const submit = async () => {
    if (call.functionName) {
      // Estimation is an eth_call, so a write that would revert throws here
      // with the decoded contract error and nothing is sent.
      const gas = await client.estimateContractGas({ account, ...call });
      return wallet.writeContract({ account, ...call, gas: (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN, ...(await feeParams()) });
    }
    const gas = await client.estimateGas({ account, to: call.to, value: call.value });
    return wallet.sendTransaction({
      to: call.to, value: call.value, gas: (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN, ...(await feeParams()),
    });
  };

  /*
   * A nonce error means the nonce manager's local count fell behind the chain
   * — another process sent with this key, or a node dropped a transaction.
   * Reset it to the chain's count and try once more; a second failure is real.
   */
  const submitOnce = async () => {
    try {
      return await submit();
    } catch (e) {
      if (!/nonce/i.test(String(e?.shortMessage ?? e?.message ?? e))) throw e;
      nonceManager.reset({ address: account.address, chainId: CHAIN_ID });
      return submit();
    }
  };
  const run = tail.then(submitOnce, submitOnce);
  // The chain continues whether this one succeeded or not; a failure is this
  // caller's to handle, not every later caller's.
  tail = run.catch(() => {});
  const hash = await run;

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 45_000 }).catch((e) => {
    e.hash = hash;
    throw e;
  });
  if (receipt.status !== 'success') {
    const e = new Error(`transaction ${hash} reverted on chain`);
    e.hash = hash;
    throw e;
  }
  return { hash, receipt };
}

/** Gateway-only original raw transaction: durable identity before broadcast, no nonce retry. */
export async function sendGatewayRelayerTx(call,{persistSigned,minimumNonce}) {
 if(!wallet||!account)throw new Error(refusal??'relayer not configured');
 if(CHAIN_ID!==5042002||typeof persistSigned!=='function'||typeof minimumNonce!=='function')throw new Error('Durable Arc-testnet Gateway recording is required.');
 const client=publicClient();
 const submit=async()=>{
  if(await client.getChainId()!==5042002)throw new Error('Gateway RPC network differs. Nothing was signed.');
  const data=encodeFunctionData({abi:call.abi,functionName:call.functionName,args:call.args});
  const estimate=await client.estimateContractGas({account,...call});const gas=(estimate*GAS_MARGIN_NUM)/GAS_MARGIN_DEN;const estimatedFees=await client.estimateFeesPerGas({type:'eip1559'});
  if(estimatedFees.maxFeePerGas===undefined||estimatedFees.maxPriorityFeePerGas===undefined)throw new Error('Live Gateway fee estimate is unavailable.');
  const fees={maxFeePerGas:estimatedFees.maxFeePerGas>40000000000n?estimatedFees.maxFeePerGas:40000000000n,maxPriorityFeePerGas:estimatedFees.maxPriorityFeePerGas};
  if(fees.maxPriorityFeePerGas>fees.maxFeePerGas)throw new Error('Gateway fee estimate is inconsistent.');
  const pending=await client.getTransactionCount({address:account.address,blockTag:'pending'});const floor=await minimumNonce(account.address);
  const managed=await nonceManager.get({address:account.address,chainId:CHAIN_ID,client});
  if(!Number.isSafeInteger(floor)||floor<0||floor>pending||managed!==pending)throw new Error('An earlier original relayer nonce is not observed. Reconcile it before signing another Gateway mint.');
  const raw=await account.signTransaction({type:'eip1559',chainId:CHAIN_ID,to:call.address,data,value:0n,nonce:pending,gas,...fees});
  const tx=parseTransaction(raw);const from=await recoverTransactionAddress({serializedTransaction:raw});
  if(tx.type!=='eip1559'||tx.chainId!==CHAIN_ID||tx.to?.toLowerCase()!==call.address.toLowerCase()||tx.data?.toLowerCase()!==data.toLowerCase()||(tx.value??0n)!==0n||tx.nonce!==pending||tx.gas!==gas||tx.maxFeePerGas!==fees.maxFeePerGas||tx.maxPriorityFeePerGas!==fees.maxPriorityFeePerGas||from.toLowerCase()!==account.address.toLowerCase())throw new Error('Signed Gateway call differs. Nothing was broadcast.');
  const hash=keccak256(raw);
  await persistSigned({hash,chainId:CHAIN_ID,from,to:call.address,dataHash:keccak256(data),nonce:pending,gas:gas.toString(),maxFeePerGas:fees.maxFeePerGas.toString(),maxPriorityFeePerGas:fees.maxPriorityFeePerGas.toString()});
  // Advance the shared manager only after the original durable identity exists.
  const consumed=await nonceManager.consume({address:account.address,chainId:CHAIN_ID,client});if(consumed!==pending)throw Object.assign(new Error('Original nonce changed after persistence. No broadcast; reconcile the original hash.'),{hash});
  try{const returned=await wallet.sendRawTransaction({serializedTransaction:raw});if(returned.toLowerCase()!==hash.toLowerCase())throw new Error('Provider returned another Gateway hash.');return hash;}
  catch(e){e.hash=hash;throw e;}
 };
 const run=tail.then(submit,submit);tail=run.catch(()=>{});const hash=await run;
 const receipt=await client.waitForTransactionReceipt({hash,timeout:45000}).catch(e=>{e.hash=hash;throw e;});
 if(receipt.transactionHash.toLowerCase()!==hash.toLowerCase())throw Object.assign(new Error('Original Gateway receipt hash differs.'),{hash});
 return {hash,receipt};
}
