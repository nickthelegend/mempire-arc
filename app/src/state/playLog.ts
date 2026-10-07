import { create } from 'zustand';
import type { Hash } from 'viem';
import { checkpointTx, playTx, readableChainError } from '../chain/actions';
import { publicClient } from '../chain/provider';
import { CLAIM_RESERVE_WEI, sessionFor } from '../chain/session';

/*
 * The match, written to Monad while it is played.
 *
 * Every card drop is a transaction from the seat's session key to
 * `MempireArena.play`, sent the moment the card leaves the player's hand and
 * never awaited by the battle. Monad's 400 ms blocks mean it is usually in a
 * block before the unit has crossed the bridge; the badge shows how long that
 * actually took, measured from send to receipt, because "fast" is a claim and a
 * number is evidence.
 *
 * State-hash checkpoints go on chain every 20 seconds of play. They state the
 * past and never move the play cursor, so a slow checkpoint can never make a
 * later card look out of order.
 *
 * Gas comes from the float the stake transaction forwarded to the session key,
 * priced at the chain's own gas price when the match begins. Logging stops
 * short of the claim reserve, so the seat can always afford to record its
 * result, and checkpoints stop well before plays do: a play is the record of
 * the match, a checkpoint only bounds a divergence the relay also watches.
 * Plays that still don't fit are counted as unlogged, never hidden.
 */

export type LogPhase = 'off' | 'live' | 'done';

/** A typical play's gas limit (estimate × 1.15). */
const PLAY_GAS = 45_000n;
/** If the gas price can't be read, assume a little over testnet's 100 gwei floor. */
const FALLBACK_GAS_PRICE = 110_000_000_000n;
/** Checkpoints stop while this many plays' worth of budget is left. */
const PLAYS_KEPT_FOR = 8n;

interface PlayLogState {
  phase: LogPhase;
  matchId: number | null;
  sent: number;
  confirmed: number;
  playsLost: number;
  marksLost: number;
  lastHash: Hash | null;
  /** Send → receipt, in ms, for the most recent confirmed play. */
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  budgetWei: bigint;
  /** One logged transaction's cost at this match's gas price. */
  costWei: bigint;

  begin: (matchId: number) => Promise<void>;
  play: (tick: number, deckIndex: number, x: number, y: number) => void;
  mark: (tick: number, stateHash: bigint) => void;
  end: () => void;
  reset: () => void;
}

/** Coordinates are fixed-point in the sim; the log stores them as int16. */
const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

export const usePlayLog = create<PlayLogState>((set, get) => {
  const watch = (hash: Hash, startedAt: number) => {
    void publicClient().waitForTransactionReceipt({ hash, pollingInterval: 200, timeout: 30_000 })
      .then((r) => {
        if (r.status !== 'success') {
          set((s) => ({ playsLost: s.playsLost + 1 }));
          return;
        }
        const ms = Date.now() - startedAt;
        set((s) => {
          const n = s.confirmed + 1;
          return {
            confirmed: n,
            lastHash: hash,
            lastLatencyMs: ms,
            avgLatencyMs: s.avgLatencyMs === null ? ms : Math.round((s.avgLatencyMs * (n - 1) + ms) / n),
          };
        });
      })
      .catch(() => set((s) => ({ playsLost: s.playsLost + 1 })));
  };

  return {
    phase: 'off',
    matchId: null,
    sent: 0,
    confirmed: 0,
    playsLost: 0,
    marksLost: 0,
    lastHash: null,
    lastLatencyMs: null,
    avgLatencyMs: null,
    budgetWei: 0n,
    costWei: PLAY_GAS * FALLBACK_GAS_PRICE,

    begin: async (matchId) => {
      const session = sessionFor(matchId);
      if (!session) { set({ phase: 'off' }); return; }
      // A Privy session signer's calls are sponsored: there is no float to ration.
      const [balance, gasPrice] = await Promise.all([
        session.kind === 'privy'
          ? Promise.resolve(10n ** 24n)
          : publicClient().getBalance({ address: session.address }).catch(() => 0n),
        publicClient().getGasPrice().catch(() => FALLBACK_GAS_PRICE),
      ]);
      // 10% over the quoted price, as the sender pads it.
      const costWei = PLAY_GAS * ((gasPrice * 11n) / 10n);
      set({
        phase: 'live', matchId, sent: 0, confirmed: 0, playsLost: 0, marksLost: 0,
        lastHash: null, lastLatencyMs: null, avgLatencyMs: null, costWei,
        budgetWei: balance > CLAIM_RESERVE_WEI ? balance - CLAIM_RESERVE_WEI : 0n,
      });
    },

    play: (tick, deckIndex, x, y) => {
      const { phase, matchId, budgetWei, costWei } = get();
      if (phase !== 'live' || matchId === null) return;
      const session = sessionFor(matchId);
      if (!session || budgetWei < costWei) {
        set((s) => ({ playsLost: s.playsLost + 1 }));
        return;
      }
      set((s) => ({ sent: s.sent + 1, budgetWei: s.budgetWei - costWei }));
      const startedAt = Date.now();
      playTx(session, matchId, tick, deckIndex, clamp16(x), clamp16(y))
        .then((hash) => watch(hash, startedAt))
        .catch((e) => {
          console.warn(`[log] play at tick ${tick} not sent: ${readableChainError(e)}`);
          set((s) => ({ playsLost: s.playsLost + 1 }));
        });
    },

    mark: (tick, stateHash) => {
      const { phase, matchId, budgetWei, costWei } = get();
      if (phase !== 'live' || matchId === null) return;
      const session = sessionFor(matchId);
      // Never spend what the remaining plays need on a checkpoint.
      if (!session || budgetWei < costWei * (PLAYS_KEPT_FOR + 1n)) return;
      set((s) => ({ budgetWei: s.budgetWei - costWei }));
      checkpointTx(session, matchId, tick, stateHash)
        .catch(() => set((s) => ({ marksLost: s.marksLost + 1 })));
    },

    end: () => { if (get().phase === 'live') set({ phase: 'done' }); },

    reset: () => set({
      phase: 'off', matchId: null, sent: 0, confirmed: 0, playsLost: 0, marksLost: 0,
      lastHash: null, lastLatencyMs: null, avgLatencyMs: null, budgetWei: 0n,
      costWei: PLAY_GAS * FALLBACK_GAS_PRICE,
    }),
  };
});
