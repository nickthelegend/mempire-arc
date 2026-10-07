/**
 * The relayer: the one key this server signs transactions with.
 *
 * # What it may do
 *
 * `MempireCards.mintStarter` is relayer-only, so this key is what turns a new
 * address into a player with a deck. It also pays the onboarding MON drip and
 * pokes the AUSD faucet. It is deliberately NOT the deployer or owner key —
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
 * Monad charges for the gas *limit*, not the gas used. A generous default limit
 * is therefore a fee, paid on every transaction, for nothing. Every send is
 * estimated and given a 15% margin — enough to absorb state moving between
 * the estimate and inclusion, and no more.
 */
import { createWalletClient, http } from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID } from './chain.js';
import { RPC_URL, abis, chain, deployment, publicClient, sameAddress } from './chain.js';

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
 * the contract's reason and costs nothing — on Monad a reverted transaction
 * still pays for its whole gas limit.
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
      return wallet.writeContract({ account, ...call, gas: (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN });
    }
    const gas = await client.estimateGas({ account, to: call.to, value: call.value });
    return wallet.sendTransaction({ to: call.to, value: call.value, gas: (gas * GAS_MARGIN_NUM) / GAS_MARGIN_DEN });
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
