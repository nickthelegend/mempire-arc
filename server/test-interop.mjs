/**
 * The relay's interop routes against the real services — no mocks:
 *
 *  - Circle Gateway (testnet API): a fresh account's unified balance across
 *    Ethereum, Arbitrum, Base and Arc; a burn intent signed exactly as the app
 *    signs it is accepted by Circle up to the balance check ("insufficient
 *    balance" means the EIP-712 signature and every field verified); intents
 *    that would mint to someone else, or anywhere but Arc, are refused by the
 *    relay before Circle is asked.
 *  - ERC-8004 (Arc testnet registries): the agent card, and the agent route
 *    reading identity and reputation for an existing testnet agent.
 *
 *   node test-interop.mjs   (needs network; Arc testnet RPC + Circle's API)
 */
import { maxUint256, pad, toHex, zeroAddress } from 'viem';
import { client, freshAccount, startRelay, tally } from './test-util.mjs';

const W = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const M = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' }, { name: 'sourceDomain', type: 'uint32' }, { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' }, { name: 'destinationContract', type: 'bytes32' }, { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' }, { name: 'sourceDepositor', type: 'bytes32' }, { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' }, { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [{ name: 'maxBlockHeight', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'spec', type: 'TransferSpec' }],
};
const b32 = (a) => pad(a.toLowerCase(), { size: 32 });
async function intent(a, { dest = 26, recipient = a.address, value = 1_000_000n } = {}) {
  const burnIntent = {
    maxBlockHeight: maxUint256, maxFee: 20_000n,
    spec: {
      version: 1, sourceDomain: 6, destinationDomain: dest, sourceContract: b32(W), destinationContract: b32(M),
      sourceToken: b32(BASE_SEPOLIA_USDC), destinationToken: b32(ARC_USDC), sourceDepositor: b32(a.address),
      destinationRecipient: b32(recipient), sourceSigner: b32(a.address), destinationCaller: b32(zeroAddress),
      value, salt: toHex(crypto.getRandomValues(new Uint8Array(32))), hookData: '0x',
    },
  };
  const signature = await a.signTypedData({ domain: { name: 'GatewayWallet', version: '1' }, types: TYPES, primaryType: 'BurnIntent', message: burnIntent });
  return JSON.parse(JSON.stringify({ requests: [{ burnIntent, signature }] }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const { check, done } = tally();
const relayer = freshAccount(); // a relayer key exists, holding nothing: the mint route must refuse before spending gas
const relay = await startRelay(Number(process.env.PORT ?? 8797), {
  CHAIN_ID: '5042002', RPC_URL: 'https://rpc.testnet.arc.io', RELAYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  AI_AGENT_ID: '1', PUBLIC_API_URL: 'https://api.mempire.test',
});
void relayer;
const req = client(relay.base);
try {
  console.log('1. Circle Gateway');
  const cfg = await req('GET', '/api/gateway/config');
  check('config names the testnet GatewayWallet/Minter and four source chains',
    cfg.data?.wallet === W && cfg.data?.minter === M && Object.keys(cfg.data?.domains ?? {}).length === 4);
  const a = freshAccount();
  const bal = await req('GET', `/api/gateway/balances/${a.address}`);
  check('the unified balance comes from Circle for every source chain', bal.status === 200 && bal.data.balances.length === 4 && bal.data.total === '0.000000',
    JSON.stringify(bal.data).slice(0, 160));
  const ok = await req('POST', '/api/gateway/mint', await intent(a));
  check('Circle accepts the signed burn intent and refuses only for balance', ok.status === 400 && /insufficient balance/i.test(ok.data?.error ?? ''),
    `${ok.status} ${ok.data?.error}`);
  const other = await req('POST', '/api/gateway/mint', await intent(a, { recipient: freshAccount().address }));
  check('an intent minting to someone else is refused by the relay', other.status === 400 && /depositor/.test(other.data?.error), other.data?.error);
  const elsewhere = await req('POST', '/api/gateway/mint', await intent(a, { dest: 6 }));
  check('an intent minting anywhere but Arc is refused', elsewhere.status === 400 && /Arc/.test(elsewhere.data?.error), elsewhere.data?.error);
  const junk = await req('POST', '/api/gateway/mint', { requests: [] });
  check('an empty request is refused', junk.status === 400);

  console.log('\n2. ERC-8004');
  const card = await req('GET', '/agents/mempire-ai.json');
  check('the agent card names the registry and endpoint', card.status === 200
    && card.data.registrations?.[0]?.agentRegistry === 'eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e'
    && card.data.services?.[0]?.endpoint === 'https://api.mempire.test/api/ai/plan', JSON.stringify(card.data).slice(0, 200));
  const ag = await req('GET', '/api/agent');
  check('identity and reputation read from the real Arc testnet registries', ag.status === 200 && ag.data.registered
    && /^0x[0-9a-fA-F]{40}$/.test(ag.data.owner) && ag.data.raters > 0 && typeof ag.data.summary?.count === 'number',
    JSON.stringify(ag.data).slice(0, 220));
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 400));
  console.log(relay.log().slice(-1500));
} finally {
  await relay.stop();
}
process.exit(done() ? 1 : 0);
