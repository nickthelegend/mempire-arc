import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';
import local from '../shared/deployments/31337.json';

/*
 * One chain per build, chosen by `VITE_CHAIN_ID`, and the choice decides
 * everything downstream: the RPC, the explorer, and which deployment's contract
 * addresses the app talks to.
 *
 * Monad testnet is the target. 31337 is a local anvil running the same
 * contracts on an anvil fork of Monad testnet (real AUSD, a signed local price
 * oracle), for development without spending MON.
 */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 10143);

/** Label for badges and copy. Kept as CLUSTER so call sites read the same as before. */
export const CLUSTER = CHAIN_ID === 143 ? 'monad' : CHAIN_ID === 10143 ? 'monad-testnet' : 'localhost';
export const IS_MAINNET = CHAIN_ID === 143;
/** The network's name as the UI says it. */
export const NETWORK_LABEL = CHAIN_ID === 143 ? 'Monad mainnet' : CHAIN_ID === 10143 ? 'Monad testnet' : 'Local Monad fork';
/** Every card is an ERC-721 on this chain; there is no separate tokenise step. */
export const NFT_ENABLED = true;

const LOCAL: Chain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8612'] } },
});

export const CHAIN: Chain = CHAIN_ID === 31337
  ? LOCAL
  : {
    ...monadTestnet,
    // MonadVision is BlockVision's explorer, which is also where Sourcify
    // verification shows up.
    blockExplorers: { default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' } },
  };

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) ?? CHAIN.rpcUrls.default.http[0];

export interface Deployment {
  chainId: number;
  token: Address;
  cards: Address;
  arena: Address;
  marketMeta: Address;
  ausd: Address;
  pyth: Address;
  relayer: Address;
  startBlock: number;
}

/*
 * The testnet deployment file appears once the contracts are deployed; until
 * then a testnet build has no addresses and runs in offline/practice mode
 * rather than pointing at somebody else's contracts.
 */
const DEPLOYMENTS = import.meta.glob<{ default: Deployment }>('../shared/deployments/*.json', { eager: true });

function loadDeployment(): Deployment | null {
  if (CHAIN_ID === 31337) return local as unknown as Deployment;
  const hit = Object.entries(DEPLOYMENTS).find(([path]) => path.endsWith(`/${CHAIN_ID}.json`));
  return hit ? hit[1].default : null;
}

export const DEPLOYMENT: Deployment | null = loadDeployment();

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * fetch with a short backoff on rate limits and gateway errors.
 *
 * The public Monad RPC rate-limits bursts, and a match start fires a handful of
 * reads at once. A 429 is a "slow down", not a failure, and surfacing it as a
 * broken game would be the wrong answer.
 */
export async function resilientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let wait = 250;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= 3) return res;
    const after = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(after) && after > 0
      ? Math.min(after * 1000, 4000)
      : wait + Math.floor(Math.random() * 150);
    await new Promise((r) => setTimeout(r, delay));
    wait *= 2;
  }
}

let client: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: CHAIN,
      transport: http(RPC_URL, { retryCount: 3, retryDelay: 250, batch: { wait: 16 } }),
      // Monad produces a block every 400 ms; polling slower than that only
      // makes a confirmed transaction look slow.
      pollingInterval: 400,
    }) as PublicClient;
  }
  return client;
}

export function explorerUrl(hashOrAddress: string, kind: 'tx' | 'address' = 'tx'): string {
  const base = CHAIN.blockExplorers?.default.url;
  if (!base) return '#';
  return `${base}/${kind === 'tx' ? 'tx' : 'address'}/${hashOrAddress}`;
}
