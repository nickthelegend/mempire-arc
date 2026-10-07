import { create } from 'zustand';
import {
  fetchCardsFor, fetchChests, fetchConfig, fetchMarketMeta, fetchMonBalance, fetchRegisteredCoins,
  fetchTokenBalances, type ChainCard, type ChainChest, type ChainCoin, type ChainConfig,
} from '../chain/read';
import { canSign } from '../chain/account';
import { CLUSTER, DEPLOYMENT, explorerUrl } from '../chain/provider';
import { apiFetch, hasApi } from '../lib/api';
import { overlayLivePrices, overlayMeta } from '../lib/coins';
import { useWallet } from './wallet';

/*
 * What the chain says, for whoever is signed in.
 *
 *  - offline: no deployment on this chain, or the RPC is unreachable — the
 *    game runs on local state and says so
 *  - simulated: the contracts are readable but nobody who can sign is in
 *  - onchain: a signer is in, and mints, merges and stakes are real
 */

export type ChainMode = 'offline' | 'simulated' | 'onchain';

interface ChainState {
  mode: ChainMode;
  cluster: string;
  loading: boolean;
  error: string | null;
  config: ChainConfig | null;
  coins: ChainCoin[];
  cards: ChainCard[];
  chests: ChainChest[];
  /** Token balances keyed by lowercase token address. */
  balances: Map<string, number>;
  /** MON. Named for the field it replaced so existing readers keep working. */
  solBalance: number;
  ausdBalance: number;
  mempireBalance: number;
  metaEpoch: number;
  /** Bumped when live prices or the market meta change, so views re-render. */
  marketVersion: number;
  owner: string | null;
  lastSignature: string | null;

  init: () => Promise<void>;
  loadWallet: (owner: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshSettled: () => Promise<void>;
  clearWallet: () => void;
  noteSignature: (sig: string) => void;
  explorer: (idOrSig: string, kind?: 'tx' | 'address') => string;
  cardById: (id: number) => ChainCard | undefined;
}

let marketTimer: ReturnType<typeof setInterval> | null = null;

export const useChain = create<ChainState>((set, get) => {
  const pullMarket = async () => {
    let changed = false;
    if (hasApi()) {
      try {
        const res = await apiFetch('/api/coins');
        const body = res && res.ok ? await res.json() : null;
        const rows = Array.isArray(body) ? body : Array.isArray(body?.coins) ? body.coins : null;
        if (rows) changed = overlayLivePrices(rows) || changed;
      } catch { /* stale prices beat no app; the next tick retries */ }
    }
    try {
      const { epoch, bps } = await fetchMarketMeta();
      changed = overlayMeta(bps) || changed;
      if (epoch !== get().metaEpoch) set({ metaEpoch: epoch });
    } catch { /* the meta is a modifier; no meta means 0 */ }
    if (changed) set((s) => ({ marketVersion: s.marketVersion + 1 }));
  };

  const readWallet = async (owner: string) => {
    const [cards, balances, mon, chests] = await Promise.all([
      fetchCardsFor(owner),
      fetchTokenBalances(owner),
      fetchMonBalance(owner),
      fetchChests(owner).catch(() => []),
    ]);
    const ausd = DEPLOYMENT ? balances.get(DEPLOYMENT.ausd.toLowerCase()) ?? 0 : 0;
    const mem = DEPLOYMENT ? balances.get(DEPLOYMENT.token.toLowerCase()) ?? 0 : 0;
    set({ cards, balances, solBalance: mon, ausdBalance: ausd, mempireBalance: mem, chests });
    useWallet.getState().setChainBalance(mon);
  };

  return {
    mode: 'offline',
    cluster: CLUSTER,
    loading: false,
    error: null,
    config: null,
    coins: [],
    cards: [],
    chests: [],
    balances: new Map(),
    solBalance: 0,
    ausdBalance: 0,
    mempireBalance: 0,
    metaEpoch: 0,
    marketVersion: 0,
    owner: null,
    lastSignature: null,

    init: async () => {
      set({ loading: true, error: null });
      void pullMarket();
      if (!marketTimer) marketTimer = setInterval(() => { void pullMarket(); }, 60_000);
      if (!DEPLOYMENT) {
        set({ mode: 'offline', loading: false, error: 'No Mempire deployment on this chain yet' });
        return;
      }
      try {
        const [config, coins] = await Promise.all([fetchConfig(), fetchRegisteredCoins()]);
        set({
          config, coins, loading: false, error: null,
          mode: get().mode === 'offline' ? 'simulated' : get().mode,
        });
      } catch (e) {
        set({ mode: 'offline', loading: false, error: e instanceof Error ? e.message : 'Could not reach Monad' });
      }
    },

    loadWallet: async (owner) => {
      set({ loading: true, owner });
      try {
        if (!get().config) await get().init();
        await readWallet(owner);
        set({
          loading: false, error: null,
          mode: get().config ? (canSign() ? 'onchain' : 'simulated') : 'offline',
        });
      } catch (e) {
        set({ loading: false, mode: 'offline', error: e instanceof Error ? e.message : 'Could not read wallet state' });
      }
    },

    // A settlement or a chest reveal lands in the next block — 400 ms — but the
    // RPC a read hits may be a block behind. Three reads over a few seconds is
    // the difference between "it worked" and "it worked after a refresh".
    refreshSettled: async () => {
      for (const delay of [0, 800, 2500]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        await get().refresh();
      }
    },

    refresh: async () => {
      const { owner, mode } = get();
      if (!owner || mode === 'offline') return;
      try {
        const [config] = await Promise.all([fetchConfig(), readWallet(owner)]);
        set({ config: config ?? get().config, mode: canSign() ? 'onchain' : 'simulated' });
      } catch { /* the next refresh will try again */ }
    },

    clearWallet: () => set({
      owner: null, cards: [], chests: [], balances: new Map(), solBalance: 0, ausdBalance: 0,
      mempireBalance: 0, mode: get().config ? 'simulated' : 'offline', lastSignature: null,
    }),
    noteSignature: (sig) => set({ lastSignature: sig }),
    explorer: (idOrSig, kind = 'tx') => explorerUrl(idOrSig, kind),
    cardById: (id) => get().cards.find((c) => c.id === id),
  };
});

export const isOnchain = (s: ChainState): boolean => s.mode === 'onchain';
