// MempireCCIPGateway: the Arc side of cross-chain play. A player on Base or
// Ethereum burns USDC with CCTP to their own address on Arc and sends a CCIP
// message from MempireRemoteEntry saying what to do with it: ENTER (open or
// join a match) or CASH_OUT (burn their Arc USDC back home with CCTP).
//
// One CrossChainMessage row per CCIP messageId:
//   delivered and ran     → Entered | CashedOut
//   delivered and reverted → Failed (MessageFailed carries the full message)
//   retried successfully  → Entered | CashedOut, then MessageRecovered → Recovered
// The arena's own MatchCreated / MatchJoined (earlier in the same transaction)
// still build the Match and seats; this only records the message.
import { indexer, type CrossChainMessage } from "envio";
import { addr, isZero, logId, meta, type Meta } from "../lib/common.js";

/** MempireMessages.ENTER = 1, CASH_OUT = 2. */
const ACTIONS = { 1: "Enter", 2: "CashOut" } as const;

type Action = CrossChainMessage["action"];

/** What a failed message's data says: abi.encode(uint8 action, address player, bytes body). */
export interface DecodedMessage {
  action: Action;
  player?: string;
  /** ENTER: the match to join (0 = open a new one). */
  matchId?: bigint;
  /** CASH_OUT: USDC, 6 dp. */
  amount?: bigint;
}

const word = (hex: string, i: number): string | undefined => {
  const w = hex.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? w : undefined;
};
const wordBig = (hex: string, i: number): bigint | undefined => {
  const w = word(hex, i);
  return w === undefined ? undefined : BigInt(`0x${w}`);
};
const wordAddr = (hex: string, i: number): string | undefined => {
  const w = word(hex, i);
  return w === undefined ? undefined : `0x${w.slice(24)}`.toLowerCase();
};

/**
 * Decode the head of a gateway message without an ABI library. Unknown or
 * truncated data yields `{ action: "Unknown" }` (plus whatever did decode).
 */
export function decodeMessage(data: string): DecodedMessage {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const actionCode = wordBig(hex, 0);
  const action: Action = actionCode === undefined ? "Unknown" : (ACTIONS[Number(actionCode) as 1 | 2] ?? "Unknown");
  const player = wordAddr(hex, 1);
  const out: DecodedMessage = { action, player };
  const bodyOffset = wordBig(hex, 2);
  if (bodyOffset === undefined || bodyOffset % 32n !== 0n) return out;
  const body = Number(bodyOffset / 32n) + 1; // first word after the bytes length
  if (action === "Enter") {
    // abi.encode(Enter): a dynamic tuple (cardIds[]), so an offset word first.
    const tupleOffset = wordBig(hex, body);
    if (tupleOffset !== undefined && tupleOffset % 32n === 0n) {
      out.matchId = wordBig(hex, body + Number(tupleOffset / 32n));
    }
  } else if (action === "CashOut") {
    // abi.encode(CashOut): all static, amount first.
    out.amount = wordBig(hex, body);
  }
  return out;
}

function newMessage(id: string, m: Meta): CrossChainMessage {
  return {
    id,
    status: "Failed",
    action: "Unknown",
    player: undefined,
    matchId: undefined,
    match_id: undefined,
    created: undefined,
    amount: undefined,
    cctpDomain: undefined,
    sourceChainSelector: undefined,
    sender: undefined,
    failData: undefined,
    failReason: undefined,
    createdAt: m.ts,
    updatedAt: m.ts,
    completedAt: undefined,
    failedAt: undefined,
    recoveredAt: undefined,
    txHash: m.tx,
    failedTxHash: undefined,
  };
}

async function upsertMessage(
  context: { CrossChainMessage: { get: (id: string) => Promise<CrossChainMessage | undefined>; set: (e: CrossChainMessage) => void } },
  messageId: string,
  m: Meta,
  fn: (x: CrossChainMessage) => CrossChainMessage,
): Promise<CrossChainMessage> {
  const id = messageId.toLowerCase();
  const current = (await context.CrossChainMessage.get(id)) ?? newMessage(id, m);
  const next = fn({ ...current, updatedAt: m.ts, txHash: m.tx });
  context.CrossChainMessage.set(next);
  return next;
}

indexer.onEvent({ contract: "MempireCCIPGateway", event: "Entered" }, async ({ event, context }) => {
  const m = meta(event);
  const matchId = event.params.matchId;
  await upsertMessage(context, event.params.messageId, m, (x) => ({
    ...x,
    status: "Entered",
    action: "Enter",
    player: addr(event.params.player),
    matchId,
    match_id: matchId.toString(),
    created: event.params.created,
    completedAt: m.ts,
  }));
});

indexer.onEvent({ contract: "MempireCCIPGateway", event: "CashedOut" }, async ({ event, context }) => {
  const m = meta(event);
  await upsertMessage(context, event.params.messageId, m, (x) => ({
    ...x,
    status: "CashedOut",
    action: "CashOut",
    player: addr(event.params.player),
    amount: event.params.amount,
    cctpDomain: Number(event.params.domain),
    completedAt: m.ts,
  }));
});

indexer.onEvent({ contract: "MempireCCIPGateway", event: "MessageFailed" }, async ({ event, context }) => {
  const m = meta(event);
  const decoded = decodeMessage(event.params.data);
  // sender is abi.encode(address) of the MempireRemoteEntry on the source chain.
  const senderHex = event.params.sender.replace(/^0x/, "");
  const sender = senderHex.length >= 40 ? `0x${senderHex.slice(-40)}`.toLowerCase() : event.params.sender.toLowerCase();
  await upsertMessage(context, event.params.messageId, m, (x) => ({
    ...x,
    status: "Failed",
    action: decoded.action,
    player: x.player ?? decoded.player,
    matchId: x.matchId ?? (decoded.matchId ? decoded.matchId : undefined),
    match_id: x.match_id ?? (decoded.matchId ? decoded.matchId.toString() : undefined),
    amount: x.amount ?? decoded.amount,
    sourceChainSelector: event.params.sourceChainSelector,
    sender,
    failData: event.params.data,
    failReason: event.params.reason,
    failedAt: m.ts,
    failedTxHash: m.tx,
  }));
});

// retryFailedMessage(): emitted after the retried action's Entered / CashedOut.
indexer.onEvent({ contract: "MempireCCIPGateway", event: "MessageRecovered" }, async ({ event, context }) => {
  const m = meta(event);
  await upsertMessage(context, event.params.messageId, m, (x) => ({
    ...x,
    status: "Recovered",
    recoveredAt: m.ts,
  }));
});

// setRemoteEntry(): allow (or, with sender 0, disallow) a source chain.
indexer.onEvent({ contract: "MempireCCIPGateway", event: "RemoteEntrySet" }, async ({ event, context }) => {
  const m = meta(event);
  const selector = event.params.selector;
  const sender = addr(event.params.sender);
  const cctpDomain = Number(event.params.cctpDomain);
  const prior = await context.CCIPSource.get(selector.toString());
  context.CCIPSource.set({
    id: selector.toString(),
    selector,
    sender,
    cctpDomain,
    enabled: !isZero(sender),
    changes: (prior?.changes ?? 0) + 1,
    updatedAt: m.ts,
    txHash: m.tx,
  });
  context.AdminChange.set({
    id: logId(m),
    contract: "MempireCCIPGateway",
    change: "RemoteEntrySet",
    address: sender,
    coinId: undefined,
    selector,
    cctpDomain,
    timestamp: m.ts,
    blockNumber: m.block,
    txHash: m.tx,
  });
});
