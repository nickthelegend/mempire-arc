import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient } from 'viem';

/*
 * One chain per build, chosen by `VITE_CHAIN_ID`, and the choice decides
 * everything downstream: the RPC, the explorer, and which deployment's contract
 * addresses the app talks to.
 *
 *  - 5042    Arc mainnet
 *  - 5042002 Arc testnet (the default)
 *  - 31337   a local fork of Arc testnet (arc-anvil, scripts/local-up.sh):
 *            Arc's real USDC, our contracts, a signed price oracle.
 *
 * Gas on Arc is USDC: the native balance (18 decimals) and the ERC-20 at
 * 0x3600…0000 (6 decimals) are one balance, so a player holds one token.
 */
export const ARC_MAINNET = 5042;
export const ARC_TESTNET = 5042002;
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? ARC_TESTNET);

/** Label for badges and copy. */
export const CLUSTER = CHAIN_ID === ARC_MAINNET ? 'arc' : CHAIN_ID === ARC_TESTNET ? 'arc-testnet' : 'localhost';
export const IS_MAINNET = CHAIN_ID === ARC_MAINNET;
/** The network's name as the UI says it. */
export const NETWORK_LABEL = CHAIN_ID === ARC_MAINNET ? 'Arc' : CHAIN_ID === ARC_TESTNET ? 'Arc testnet' : 'Local Arc fork';
/** Every card is an ERC-721 on this chain; there is no separate tokenise step. */
export const NFT_ENABLED = true;

/** Arc's USDC ERC-20 interface: 6 decimals, the same address on every Arc network. */
export const USDC: Address = '0x3600000000000000000000000000000000000000';
/** Native USDC has 18 decimals; the ERC-20 view has 6. */
export const NATIVE_PER_USDC_UNIT = 1_000_000_000_000n;

const usdc = { name: 'USDC', symbol: 'USDC', decimals: 18 } as const;

const CHAINS: Record<number, Chain> = {
  [ARC_MAINNET]: defineChain({
    id: ARC_MAINNET,
    name: 'Arc',
    nativeCurrency: usdc,
    rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
    blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
  }),
  [ARC_TESTNET]: defineChain({
    id: ARC_TESTNET,
    name: 'Arc Testnet',
    nativeCurrency: usdc,
    rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
    blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } },
    testnet: true,
  }),
};

const LOCAL: Chain = defineChain({
  id: CHAIN_ID,
  name: 'Arc fork (local)',
  nativeCurrency: usdc,
  rpcUrls: { default: { http: ['http://127.0.0.1:8710'] } },
  testnet: true,
});

export const CHAIN: Chain = CHAINS[CHAIN_ID] ?? LOCAL;

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) ?? CHAIN.rpcUrls.default.http[0];

export interface Deployment {
  chainId: number;
  token: Address;
  cards: Address;
  arena: Address;
  marketMeta: Address;
  usdc: Address;
  oracle: Address;
  oracleKind: 'signed' | 'pyth';
  relayer: Address;
  maxTier: number;
  startBlock: number;
}

/*
 * The deployment file appears once the contracts are deployed (scripts/deploy.sh
 * or scripts/local-up.sh write it); until then a build has no addresses and
 * runs in offline/practice mode rather than pointing at somebody else's
 * contracts.
 */
const DEPLOYMENTS = import.meta.glob<{ default: Deployment }>('../shared/deployments/*.json', { eager: true });

function loadDeployment(): Deployment | null {
  const hit = Object.entries(DEPLOYMENTS).find(([path]) => path.endsWith(`/${CHAIN_ID}.json`));
  return hit ? hit[1].default : null;
}

export const DEPLOYMENT: Deployment | null = loadDeployment();

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * fetch with a short backoff on rate limits and gateway errors.
 *
 * A public RPC rate-limits bursts, and a match start fires a handful of
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
      // Arc finalises in under a second; polling slower than that only makes
      // a confirmed transaction look slow.
      pollingInterval: 300,
    }) as PublicClient;
  }
  return client;
}

export function explorerUrl(hashOrAddress: string, kind: 'tx' | 'address' = 'tx'): string {
  const base = CHAIN.blockExplorers?.default.url;
  if (!base) return '#';
  return `${base}/${kind === 'tx' ? 'tx' : 'address'}/${hashOrAddress}`;
}
