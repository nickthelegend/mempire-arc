/**
 * Which chain this relay talks to, and the facts it needs about it.
 *
 * One env var picks the network — `CHAIN_ID` — and everything else derives
 * from it: the deployment file (contract addresses), the RPC default, which
 * features are allowed to give anything away. A relay pointed at a chain with
 * no deployment file still boots; it simply has no contracts to read, and every
 * chain-backed route says so instead of guessing at an address.
 *
 * The roster, ABIs and deployments live in `server/shared/`, vendored from the
 * repo's `shared/` by `npm run sync-shared`. The relay is deployed from this
 * directory alone, so it cannot reach `../shared` at runtime.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, defineChain, erc20Abi, http, keccak256 } from 'viem';

/** Arc mainnet and Arc testnet. */
export const ARC_MAINNET = 5042;
export const ARC_TESTNET = 5042002;

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? ARC_TESTNET);
const DEFAULT_RPC = {
  [ARC_MAINNET]: 'https://rpc.mainnet.arc.io',
  [ARC_TESTNET]: 'https://rpc.testnet.arc.io',
};
export const RPC_URL = process.env.RPC_URL || DEFAULT_RPC[CHAIN_ID] || 'http://127.0.0.1:8710';

/**
 * Chains where handing out USDC is a test convenience rather than a gift of
 * real money: Arc testnet, and a local fork of it.
 *
 * The onboarding drip spends whatever the relayer key holds, and that key is a
 * hot wallet in an env var. On any other chain the drip is off regardless of
 * configuration — "free USDC endpoint on mainnet" is a drain waiting for a
 * scanner to find it. The starter deck is not gated: it costs only gas, the
 * contract allows it once per address, and it is the product on every chain.
 */
/** Local Arc forks: the dev stack (31337) and the throwaway test fork (31338). */
export const IS_DEV_CHAIN = CHAIN_ID === 31337 || CHAIN_ID === 31338;
export const IS_TEST_CHAIN = CHAIN_ID === ARC_TESTNET || IS_DEV_CHAIN;
export const IS_MAINNET = CHAIN_ID === ARC_MAINNET;

/** Arc's USDC ERC-20 interface (6 decimals): the same address on mainnet, testnet and a fork. */
export const USDC = '0x3600000000000000000000000000000000000000';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const abiOf = (name) => {
  const j = read(`./shared/abi/${name}.json`);
  return Array.isArray(j) ? j : j.abi;
};

export const abis = {
  cards: abiOf('MempireCards'),
  arena: abiOf('MempireArena'),
  token: abiOf('MempireToken'),
  marketMeta: abiOf('MarketMeta'),
  oracle: abiOf('SignedPriceOracle'),
  erc20: erc20Abi,
};

/** The deployment for CHAIN_ID, or null when this chain has none yet. */
export const deployment = (() => {
  const file = new URL(`./shared/deployments/${CHAIN_ID}.json`, import.meta.url);
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (Number(d.chainId) !== CHAIN_ID) {
    throw new Error(`shared/deployments/${CHAIN_ID}.json says chainId ${d.chainId}`);
  }
  return d;
})();

// ── the roster ───────────────────────────────────────────────────────────────

export const roster = read('./shared/roster.json').coins;
export const coinById = new Map(roster.map((c) => [c.coinId, c]));

/** Index = archetype id, exactly as `MempireCards` and the sim number them. */
export const ARCHETYPE_NAMES = ['Tank', 'Swarm', 'Ranged', 'Splash', 'Support', 'Spell'];

/**
 * `MempireCards.archetypeFor`, in JS: keccak256 over the 32 raw bytes of the
 * Pyth feed id, mod 6. The contract derives it at registration so nobody can
 * hand a favoured asset a better class; the relay derives it here to choose a
 * starter deck without a round trip per coin, and checks itself against the
 * contract once at boot (see `onboard.js`).
 */
export function archetypeOf(feedId) {
  return Number(BigInt(keccak256(feedId)) % 6n);
}

// ── addresses ────────────────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The one spelling of an address this relay stores.
 *
 * An EVM address arrives checksummed from one wallet and lowercase from
 * another, and both are the same account. Used raw as a Mongo `_id` or a map
 * key, that is two ladder rows, two clan memberships and two onboarding
 * claims for one person — the second of which is a second faucet drip.
 * Lowercase everywhere a key is made; checksums are a display concern.
 *
 * Returns null for anything that is not 0x plus 20 bytes of hex, so callers can
 * refuse it before it reaches a database.
 */
export function normAddress(a) {
  if (typeof a !== 'string' || !EVM_ADDRESS.test(a)) return null;
  return a.toLowerCase();
}

export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.toLowerCase() === b.toLowerCase();

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── clients ──────────────────────────────────────────────────────────────────

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === ARC_MAINNET ? 'Arc' : CHAIN_ID === ARC_TESTNET ? 'Arc Testnet' : IS_DEV_CHAIN ? 'Arc fork (local)' : `Chain ${CHAIN_ID}`,
  // Native USDC: 18 decimals natively; the ERC-20 at USDC views the same balance with 6.
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

let pub = null;
/**
 * The read client, created on first use. Retries are kept low: a request that
 * is waiting on this is usually a player waiting on a screen, and the public
 * testnet RPC rate-limits harder than it fails.
 */
export function publicClient() {
  pub ??= createPublicClient({
    chain,
    transport: http(RPC_URL, { retryCount: 2, timeout: 15_000 }),
  });
  return pub;
}

/** The arena's one stake currency, keyed by the address in `Match.currency`. */
export function currencyOf(address) {
  if (sameAddress(address, deployment?.usdc ?? USDC)) return { symbol: 'USDC', decimals: 6 };
  return null;
}

/**
 * EIP-1559 fees for a send. Arc's mempool silently drops a transaction whose
 * maxFeePerGas is under 20 gwei — no error and no receipt — so the node's
 * estimate is floored there. Gas is USDC: at Arc's ~20–25 gwei a 100k-gas call
 * costs about a fifth of a cent.
 */
export const MIN_FEE_PER_GAS = 20_000_000_000n;
export async function feeParams() {
  const f = await publicClient().estimateFeesPerGas().catch(() => null);
  const maxFeePerGas = f?.maxFeePerGas && f.maxFeePerGas > MIN_FEE_PER_GAS * 2n ? f.maxFeePerGas : MIN_FEE_PER_GAS * 2n;
  const maxPriorityFeePerGas = f?.maxPriorityFeePerGas ?? 1_000_000_000n;
  return { maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas };
}
