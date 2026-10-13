/**
 * Recent settled matches, read straight from the arena's `MatchSettled` events.
 *
 * The leaderboard and a player's history live in the relay's store, which only knows what clients
 * reported. This is the chain's own list: every pot the arena paid (or refunded by timeout),
 * with the settling transaction, so Empire can show real matches (and a judge can click through
 * to the explorer) even when the relay's store is empty or was restarted.
 */
import { parseEventLogs } from 'viem';
import { abis, deployment, publicClient } from './chain.js';

const CHUNK = 9_000n;
const KEEP = 50;
let cache = { at: 0, scanned: 0n, rows: [] };
let inflight = null;

async function scan() {
  const client = publicClient();
  const head = await client.getBlockNumber();
  let from = cache.scanned ? cache.scanned + 1n : BigInt(deployment.startBlock ?? 0);
  const rows = [...cache.rows];
  while (from <= head) {
    const to = from + CHUNK > head ? head : from + CHUNK;
    const raw = await client.getLogs({ address: deployment.arena, fromBlock: from, toBlock: to });
    for (const l of parseEventLogs({ abi: abis.arena, logs: raw, eventName: 'MatchSettled' })) {
      rows.push({
        matchId: Number(l.args.matchId), winnerSeat: Number(l.args.winner), winner: l.args.winnerAddress,
        pot: l.args.pot.toString(), rake: l.args.rake.toString(), byTimeout: Boolean(l.args.byTimeout),
        tx: l.transactionHash, block: Number(l.blockNumber),
      });
    }
    from = to + 1n;
  }
  const last = rows.slice(-KEEP);
  const times = new Map();
  for (const r of last.slice(-10)) {
    if (!r.at) times.set(r.block, (await client.getBlock({ blockNumber: BigInt(r.block) })).timestamp);
  }
  cache = { at: Date.now(), scanned: head, rows: last.map((r) => ({ ...r, at: r.at ?? (times.has(r.block) ? Number(times.get(r.block)) : null) })) };
}

export function registerRecentRoutes(app) {
  app.get('/api/arc/matches', async (_req, res) => {
    if (!deployment?.arena) return res.json({ matches: [], note: 'no deployment for this chain' });
    try {
      if (Date.now() - cache.at > 20_000) {
        inflight ??= scan().finally(() => { inflight = null; });
        await inflight;
      }
      res.json({ chainId: deployment.chainId, arena: deployment.arena, matches: cache.rows.slice(-10).reverse() });
    } catch (e) {
      res.status(502).json({ error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160), matches: cache.rows.slice(-10).reverse() });
    }
  });
}
