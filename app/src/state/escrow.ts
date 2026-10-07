import { create } from 'zustand';
import { toHex, type Address } from 'viem';
import {
  cancelMatchTx, claimTimeoutTx, claimTx, createMatchTx, joinMatchTx, readMatch, readableChainError,
  type Currency,
} from '../chain/actions';
import { activeSigner } from '../chain/account';
import { MATCH_STATE_ACTIVE, MATCH_STATE_OPEN, MATCH_STATE_SETTLED } from '../chain/read';
import { bindSession, prepareSession, sessionFor, sessionGasWei, sweepSession } from '../chain/session';
import { pvpSendChain } from '../lib/pvp';
import { track } from '../lib/track';
import { useChain } from './chain';

/*
 * The escrowed pot for one human match, on Monad.
 *
 * Seat 0 opens the match (stake + deck lock + session key, one transaction) and
 * relays the id; seat 1 reads the match back from chain, checks it is the one
 * it was paired into at the stake it agreed to, and joins. Neither can be made
 * to stake by the other: the relayed id is a hint, the chain is the authority.
 *
 * At the end each seat records the winner its own simulation produced, signed
 * by its session key — no prompt. The second claim settles the match in the
 * same transaction: paid if the two agree, voided and refunded if not. A seat
 * that never claims cannot hold the pot hostage: after the deadline the claim
 * that did arrive stands, and with none at all both stakes go home.
 *
 * Everything here is best effort around a match that is already being played.
 * The battle never waits on a transaction; this store carries the outcome and
 * the UI reports it honestly, including when it failed.
 */

export type EscrowPhase =
  | 'none' // nothing staked; this match is for the ladder only
  | 'opening' // createMatch in flight
  | 'waiting' // our stake is escrowed, waiting for the opponent's
  | 'joining' // joinMatch in flight
  | 'live' // both stakes escrowed, match Active
  | 'claiming' // recording this seat's result
  | 'claimed' // our claim is in; the opponent's may not be
  | 'settled' // the pot has been paid (or split)
  | 'refunded' // cancelled or voided; stake came back
  | 'failed'; // could not stake — the match continues unstaked

interface EscrowStore {
  phase: EscrowPhase;
  matchId: number | null;
  /** Stake per seat, in whole units of `currency`. */
  stake: number;
  currency: Currency;
  players: [string, string] | null;
  deckCardIds: number[];
  seat: 0 | 1 | null;
  metaEpoch: number;
  lastSignature: string | null;
  lastError: string | null;
  /** How the match ended on chain, once it has. */
  outcome: 'paid' | 'void' | null;

  reset: () => void;
  open: (tier: number, currency: Currency, deckCardIds: number[]) => Promise<number | null>;
  join: (matchId: number, expectedStake: number, currency: Currency, opponent: string, deckCardIds: number[]) => Promise<boolean>;
  /** Seat 0: wait until seat 1's join lands, so the match is Active. */
  awaitActive: (matchId: number) => Promise<boolean>;
  finish: (winnerSeat: number, finalHash: bigint) => Promise<void>;
  withdraw: () => Promise<void>;
  recover: (matchId?: number) => Promise<'paid' | 'too-early' | 'nothing' | 'failed'>;
}

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const useEscrow = create<EscrowStore>((set, get) => ({
  phase: 'none',
  matchId: null,
  stake: 0,
  currency: 'MON',
  players: null,
  deckCardIds: [],
  seat: null,
  metaEpoch: 0,
  lastSignature: null,
  lastError: null,
  outcome: null,

  reset: () => set({
    phase: 'none', matchId: null, stake: 0, players: null, deckCardIds: [], seat: null,
    metaEpoch: 0, lastSignature: null, lastError: null, outcome: null,
  }),

  open: async (tier, currency, deckCardIds) => {
    set({ phase: 'opening', seat: 0, deckCardIds, currency, lastError: null });
    try {
      const session = prepareSession();
      const { matchId, hash } = await createMatchTx(tier, currency, deckCardIds, session, sessionGasWei());
      bindSession(matchId);
      const m = await readMatch(matchId);
      set({ phase: 'waiting', matchId, lastSignature: hash, stake: m?.stake ?? 0 });
      void useChain.getState().refresh();
      pvpSendChain({ stage: 'opened', onchainMatchId: matchId });
      return matchId;
    } catch (e) {
      const reason = readableChainError(e);
      set({ phase: 'failed', lastError: reason });
      pvpSendChain({ stage: 'failed', reason });
      return null;
    }
  },

  join: async (matchId, expectedStake, currency, opponent, deckCardIds) => {
    set({ phase: 'joining', seat: 1, deckCardIds, currency, lastError: null });
    try {
      const m = await readMatch(matchId);
      if (!m) throw new Error('that match does not exist on chain');
      if (m.state !== MATCH_STATE_OPEN) throw new Error('that match is not open');
      if (!same(m.players[0], opponent)) throw new Error('that match belongs to a different player');
      if (m.currency !== currency || Math.abs(m.stake - expectedStake) > 1e-9) {
        throw new Error(`stake mismatch: the match is for ${m.stake} ${m.currency}`);
      }
      const session = prepareSession();
      const { hash } = await joinMatchTx(m, deckCardIds, session, sessionGasWei());
      bindSession(matchId);
      const now = await readMatch(matchId);
      const me = activeSigner()?.address ?? '';
      set({
        phase: 'live', matchId, lastSignature: hash, stake: m.stake,
        players: [m.players[0], me], metaEpoch: now?.metaEpoch ?? 0,
      });
      void useChain.getState().refresh();
      pvpSendChain({ stage: 'joined', onchainMatchId: matchId });
      return true;
    } catch (e) {
      const reason = readableChainError(e);
      set({ phase: 'failed', lastError: reason });
      pvpSendChain({ stage: 'failed', reason });
      return false;
    }
  },

  awaitActive: async (matchId) => {
    // 400 ms blocks: a join that is coming arrives in seconds. Poll briefly.
    for (let i = 0; i < 60; i += 1) {
      const m = await readMatch(matchId).catch(() => null);
      if (m?.state === MATCH_STATE_ACTIVE) {
        set({ phase: 'live', players: m.players, metaEpoch: m.metaEpoch });
        return true;
      }
      if (m && m.state === MATCH_STATE_SETTLED) return false;
      await sleep(1000);
    }
    return false;
  },

  finish: async (winnerSeat, finalHash) => {
    const { matchId, phase } = get();
    if (matchId === null || phase === 'none' || phase === 'failed') return;
    set({ phase: 'claiming' });
    const hash = toHex(finalHash, { size: 32 });
    try {
      const m0 = await readMatch(matchId);
      if (!m0 || m0.state !== MATCH_STATE_ACTIVE) {
        if (m0?.state === MATCH_STATE_SETTLED) set({ phase: m0.winner === 3 ? 'refunded' : 'settled' });
        return;
      }
      const seat = get().seat ?? 0;
      if (m0.claims[seat] === 3) {
        const by = sessionFor(matchId) ?? activeSigner();
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            const r = await claimTx(matchId, winnerSeat, hash, by);
            set({ lastSignature: r.hash, lastError: null });
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (/already recorded/.test(readableChainError(e))) { lastErr = null; break; }
            await sleep(1000 * (attempt + 1));
          }
        }
        if (lastErr) throw lastErr;
      }
      set({ phase: 'claimed' });
      track('match.claimed', { matchId, winnerSeat });

      // The opponent's claim settles it. Watch for that; at the deadline, finish it ourselves.
      for (;;) {
        const m = await readMatch(matchId);
        if (!m) return;
        if (m.state === MATCH_STATE_SETTLED) {
          const outcome = m.winner === 3 ? 'void' : 'paid';
          set({ phase: outcome === 'void' ? 'refunded' : 'settled', outcome });
          track('match.settled', { matchId, winner: m.winner });
          break;
        }
        if (Date.now() / 1000 >= m.deadline) {
          const r = await claimTimeoutTx(matchId);
          set({ lastSignature: r.hash });
          continue;
        }
        const wait = Math.min(3000, Math.max(800, m.deadline * 1000 - Date.now()));
        await sleep(wait);
      }
      void useChain.getState().refreshSettled();
      const me = activeSigner()?.address;
      if (me) void sweepSession(matchId, me as Address);
    } catch (e) {
      set({ lastError: readableChainError(e) });
    }
  },

  recover: async (explicitId) => {
    const matchId = explicitId ?? get().matchId;
    if (matchId === null || matchId === undefined) return 'nothing';
    const m = await readMatch(matchId);
    if (!m || m.state === MATCH_STATE_SETTLED) return 'nothing';
    const me = activeSigner()?.address;
    if (!me || !m.players.some((p) => same(p, me))) return 'nothing';
    try {
      if (m.state === MATCH_STATE_OPEN) {
        const r = await cancelMatchTx(matchId);
        set({ phase: 'refunded', lastSignature: r.hash });
        void useChain.getState().refresh();
        return 'paid';
      }
      if (Date.now() / 1000 < m.deadline) return 'too-early';
      const r = await claimTimeoutTx(matchId);
      set({ phase: 'settled', lastSignature: r.hash });
      void useChain.getState().refresh();
      return 'paid';
    } catch (e) {
      const reason = readableChainError(e);
      set({ lastError: reason });
      console.warn('[escrow] recovery failed:', reason);
      return 'failed';
    }
  },

  withdraw: async () => {
    for (let i = 0; i < 20 && get().phase === 'opening'; i += 1) await sleep(500);
    const { matchId, phase } = get();
    if (matchId === null || (phase !== 'waiting' && phase !== 'failed')) return;
    try {
      const m = await readMatch(matchId);
      if (m?.state !== MATCH_STATE_OPEN) return;
      const r = await cancelMatchTx(matchId);
      set({ phase: 'refunded', lastSignature: r.hash });
      void useChain.getState().refresh();
    } catch (e) {
      set({ lastError: readableChainError(e) });
    }
  },
}));
