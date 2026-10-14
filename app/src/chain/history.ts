import { parseAbiItem } from 'viem';
import { DEPLOYMENT, publicClient } from './provider';
import { fetchMatchById } from './read';
import { settlementBoard, type Settlement } from '../shared/settlements.mjs';
export { settlementBoard };
export type { Settlement };
const event = parseAbiItem('event MatchSettled(uint64 indexed matchId, uint8 winner, address currency, uint256 pot, uint256 rake, address indexed winnerAddress, bool byTimeout)');
let cache: { at: number; head: bigint; rows: Settlement[] } | null = null;
let pending: Promise<Settlement[]> | null = null;
/** No relay required. Incremental event scan, with real receipts and both seats. */
export function chainHistory(): Promise<Settlement[]> {
  if (!DEPLOYMENT) return Promise.resolve([]);
  if (cache && Date.now() - cache.at < 20_000) return Promise.resolve(cache.rows);
  if (pending) return pending;
  pending = (async () => {
    const d = DEPLOYMENT!;
    const c = publicClient();
    const head = await c.getBlockNumber();
    const rows = [...(cache?.rows ?? [])];
    for (let from = cache ? cache.head + 1n : BigInt(d.startBlock); from <= head; from += 9000n) {
      const logs = await c.getLogs({address: d.arena, event, fromBlock: from, toBlock: from + 8999n < head ? from + 8999n : head});
      for (const l of logs) {
        const m = await fetchMatchById(Number(l.args.matchId));
        if (!m || !l.transactionHash) continue;
        const b = await c.getBlock({blockNumber: l.blockNumber});
        rows.push({matchId: m.id, winnerSeat: Number(l.args.winner), winner: l.args.winnerAddress!, players: m.players,
          pot: String(l.args.pot), rake: String(l.args.rake), byTimeout: Boolean(l.args.byTimeout), tx: l.transactionHash,
          block: Number(l.blockNumber), at: Number(b.timestamp)});
      }
    }
    cache = {at: Date.now(), head, rows: rows.sort((a,b) => b.matchId-a.matchId)};
    return cache.rows;
  })().finally(() => { pending = null; });
  return pending;
}
