import type { InputEvent, MatchCard } from '../sim/types';
import { wsUrl } from './api';

/**
 * PvP transport — the client half of the matchmaker.
 *
 * One socket per queue-or-match lifecycle, no reconnect by design: in a
 * lockstep sim a client that drops has already diverged from the shared
 * timeline, so the honest outcomes are exactly two — the opponent wins by
 * forfeit, or the match voids on the next hash check. Reconnection theatre
 * would only delay one of those.
 */

export interface MatchedPayload {
  matchId: number;
  /**
   * A token for this pairing, issued to these two sockets and nobody else.
   *
   * A ranked result has to cite it. Without one the relay has no record that
   * the match happened, and a rating written from a body the winner authored
   * is not a rating. Optional so an older relay still plays — it just cannot
   * move trophies.
   */
  pairKey?: string;
  role: 0 | 1;
  seed: number;
  startAt: number;
  /**
   * The server's own clock when it sent this, so a client can measure how far
   * its wall clock is out and step the sim against the shared one instead.
   * Optional: an older server does not send it, and no correction is better
   * than a wrong correction.
   */
  serverNow?: number;
  /**
   * Ticks of lockstep input delay, chosen by the server from the worse of the
   * two connections' round-trip times. Both clients receive the same number in
   * the same message — each measuring its own would disagree, and disagreeing
   * about which tick an input lands on *is* a desync.
   *
   * Optional: an older matchmaker does not send it, and the client's own
   * constant is the fallback.
   */
  inputDelayTicks?: number;
  /**
   * The MarketMeta epoch the matchmaker read when it paired these two. Both
   * clients apply that epoch's modifiers to both decks, so the sim agrees.
   * Optional: an older relay sends none and the match plays at 0 bps.
   */
  metaEpoch?: number;
  opponent: {
    address: string; name: string | null; power: number; deck: MatchCard[];
    /** Ladder rating, so the winner can be scored without a second round trip. */
    trophies?: number;
  };
  /** Agreed format. Both clients must build the sim with the same one. */
  format?: 'standard' | 'rush';
}

export interface PvpCallbacks {
  onQueued?: () => void;
  onMatched?: (m: MatchedPayload) => void;
  onInput?: (input: InputEvent) => void;
  onDesync?: (tick: number) => void;
  onOpponentLeft?: () => void;
  /** Socket failed or closed before a match formed — callers fall back to the bot. */
  onUnavailable?: () => void;
  /**
   * Socket died unexpectedly *after* a match formed — laptop slept, network
   * dropped. The server has already told the opponent they won by forfeit, so
   * the honest local outcome is a loss, and the caller settles it as one.
   */
  onSocketLost?: () => void;
  /**
   * The opponent's escrow progressed (or failed).
   *
   * Relayed verbatim by the matchmaker, so treat it as a hint, never as
   * authority: the receiving client reads the match account on chain before
   * committing a stake to it.
   */
  onChain?: (m: ChainRelay) => void;
  /** The opponent's current sim tick, so neither side runs away from the other. */
  onTick?: (tick: number) => void;
}

/** What one seat tells the other about the on-chain half of the match. */
export interface ChainRelay {
  stage: 'opened' | 'joined' | 'failed';
  onchainMatchId: number | null;
  matchAccount: string | null;
  reason: string | null;
}



let socket: WebSocket | null = null;
let callbacks: PvpCallbacks = {};
let matched = false;

export function pvpConnect(cb: PvpCallbacks): void {
  pvpClose();
  callbacks = cb;
  matched = false;

  const url = wsUrl();
  if (!url) {
    // No matchmaker configured for this build. Same outcome as an unreachable
    // one, reached without opening a socket that could never connect.
    cb.onUnavailable?.();
    return;
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    cb.onUnavailable?.();
    return;
  }
  socket = ws;

  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(e.data)); } catch { return; }
    switch (msg.t) {
      case 'queued': callbacks.onQueued?.(); break;
      case 'matched':
        matched = true;
        callbacks.onMatched?.(msg as unknown as MatchedPayload);
        break;
      case 'input': callbacks.onInput?.(msg.input as InputEvent); break;
      case 'desync': callbacks.onDesync?.(Number(msg.tick)); break;
      case 'opponent_left': callbacks.onOpponentLeft?.(); break;
      case 'chain': callbacks.onChain?.(msg as unknown as ChainRelay); break;
      case 'tick': callbacks.onTick?.(Number(msg.tick)); break;
      default: break;
    }
  };

  ws.onerror = () => {
    if (!matched) callbacks.onUnavailable?.();
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (!matched) callbacks.onUnavailable?.();
    else callbacks.onSocketLost?.();
  };
}

function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function pvpQueue(payload: {
  address: string; name: string; tier: number; power: number;
  deck: MatchCard[]; deckHash: string;
  /** Ladder rating, for rating-banded pairing. */
  trophies?: number;
  /** Ranked queues only pair with other ranked queues. */
  ranked?: boolean;
  /** A 30s Rush must never be seated against a 3-minute standard match. */
  format?: 'standard' | 'rush';
  /** MON and AUSD stakes are never paired with each other. */
  currency?: 'MON' | 'AUSD';
}): void {
  const go = () => send({ t: 'queue', ...payload });
  if (socket?.readyState === WebSocket.OPEN) go();
  else if (socket) socket.addEventListener('open', go, { once: true });
;
}

export const pvpSendInput = (input: InputEvent): void => send({ t: 'input', input });
export const pvpSendHash = (tick: number, hash: number): void => send({ t: 'hash', tick, hash });
export const pvpSendEnded = (): void => send({ t: 'ended' });
/** Tell the opponent where our sim is, so they do not outrun us. */
export const pvpSendTick = (tick: number): void => send({ t: 'tick', tick });
export const pvpCancel = (): void => send({ t: 'cancel' });

/** Tell the other seat where the escrow got to. */
export const pvpSendChain = (m: {
  stage: 'opened' | 'joined' | 'failed';
  onchainMatchId?: number | null;
  matchAccount?: string | null;
  reason?: string | null;
}): void => send({ t: 'chain', ...m });

/** Closes without firing onUnavailable — for deliberate teardown. */
export function pvpClose(): void {
  const ws = socket;
  socket = null;
  callbacks = {};
  matched = true; // suppresses the unavailable callback on this close
  try { ws?.close(); } catch { /* already closed */ }
}
