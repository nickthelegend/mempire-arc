import { parseEventLogs } from 'viem';
import { abis, deployment, publicClient } from './chain.js';
import { settlementBoard } from './shared/settlements.mjs';
export { settlementBoard };
let database = () => null;
let cache = { at: 0, scanned: 0n, rows: [] };
let inflight = null;
export function setHistoryDb(getDb) { database = getDb; }
async function scan() {
  if (!deployment?.arena) return [];
  const client = publicClient();
  const head = await client.getBlockNumber();
  let from = cache.scanned ? cache.scanned + 1n : BigInt(deployment.startBlock ?? 0);
  const rows = [...cache.rows];
  while (from <= head) {
    const to = from + 8999n < head ? from + 8999n : head;
    const raw = await client.getLogs({ address: deployment.arena, fromBlock: from, toBlock: to });
    for (const l of parseEventLogs({ abi: abis.arena, logs: raw, eventName: 'MatchSettled' })) {
      const m = await client.readContract({address: deployment.arena, abi: abis.arena, functionName: 'getMatch', args: [l.args.matchId]});
      const block = await client.getBlock({blockNumber: l.blockNumber});
      rows.push({ matchId: Number(l.args.matchId), winnerSeat: Number(l.args.winner), winner: l.args.winnerAddress,
        players: [m.p0, m.p1], pot: l.args.pot.toString(), rake: l.args.rake.toString(), byTimeout: Boolean(l.args.byTimeout),
        tx: l.transactionHash, block: Number(l.blockNumber), at: Number(block.timestamp) });
    }
    from = to + 1n;
  }
  // Mongo is a durable materialized view; chain events remain authoritative.
  const db = database();
  if (db) {
    try {
      for (const r of rows) await db.collection('match_history').updateOne({_id: `${deployment.chainId}:${r.matchId}`}, {$set:r}, {upsert:true});
      for (const r of settlementBoard(rows)) await db.collection('chain_leaderboard').updateOne({_id:r.address}, {$set:r}, {upsert:true});
    } catch { /* reads must survive a Mongo outage */ }
  }
  cache = { at: Date.now(), scanned: head, rows };
  return rows;
}
export async function recentMatches() {
  if (Date.now() - cache.at > 20_000) {
    inflight ??= scan().finally(() => { inflight = null; });
    await inflight;
  }
  return [...cache.rows].sort((a,b) => b.matchId-a.matchId);
}
export function registerRecentRoutes(app) {
  app.get('/api/arc/matches', async (req, res) => {
    try {
      let matches = await recentMatches();
      if (req.query.address) matches = matches.filter(m => m.players.some(a => a.toLowerCase() === String(req.query.address).toLowerCase()));
      res.json({chainId:deployment?.chainId, arena:deployment?.arena, source:'chain', matches:matches.slice(0,50)});
    } catch {
      try {
        const matches = await database()?.collection('match_history').find({}).sort({matchId:-1}).limit(50).toArray();
        if (matches) return res.json({source:'mongo-cache', stale:true, matches});
      } catch { /* no database either */ }
      res.status(503).json({error:'Arc history is temporarily unavailable', matches:cache.rows, stale:true});
    }
  });
}
