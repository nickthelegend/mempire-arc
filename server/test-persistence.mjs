/**
 * The relay's data survives a restart — on a real MongoDB, not the in-memory
 * store.
 *
 * Starts the relay on `MONGODB_URI` with a throwaway database, saves a signed
 * player slice, stops the relay, starts a fresh one on the same database, and
 * reads the slice back. The database is dropped at the end.
 *
 *   node test-persistence.mjs   (needs mongod; scripts/local-up.sh runs one on :27019)
 */
import { MongoClient } from 'mongodb';
import { client, freshAccount, signed, startRelay, tally } from './test-util.mjs';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB = `mempire_persist_test_${Date.now()}`;
const PORT = Number(process.env.PORT ?? 8797);
const { check, done } = tally();

const mongo = new MongoClient(URI, { serverSelectionTimeoutMS: 3000 });
try {
  await mongo.connect();
} catch (e) {
  console.log(`no MongoDB at ${URI} — start one with scripts/local-up.sh (${e.message})`);
  process.exit(1);
}

console.log(`persistence → ${URI}/${DB}, relay :${PORT}\n`);
// A dev chain id with nothing listening: this suite needs no chain at all.
const env = { MONGODB_URI: URI, MONGODB_DB: DB, CHAIN_ID: '31338', RPC_URL: 'http://127.0.0.1:1' };
const player = freshAccount();
const slice = { cards: [{ id: 'c1', coinId: 0, level: 3 }], deck: ['c1'], tier: 1, gems: 42, history: [{ won: true }] };

try {
  console.log('1. write through the first relay');
  let relay = await startRelay(PORT, env);
  let req = client(relay.base);
  const health = await req('GET', '/api/health');
  check('health reports a persistent store', health.data?.persistent === true && health.data?.db === DB, JSON.stringify(health.data).slice(0, 120));
  const put = await req('PUT', `/api/player/${player.address}`, await signed(player, 'player.put', slice));
  check('signed save is 200', put.status === 200, `${put.status} ${put.data?.error ?? ''}`);
  await relay.stop();

  console.log('\n2. read through a fresh relay process');
  relay = await startRelay(PORT, env);
  req = client(relay.base);
  const got = await req('GET', `/api/player/${player.address}`);
  check('the slice is still there after a restart', got.status === 200 && got.data?.gems === 42 && got.data?.cards?.[0]?.level === 3,
    JSON.stringify(got.data).slice(0, 160));
  check('history survived too', got.data?.history?.length === 1);
  const raw = await mongo.db(DB).collection('players').findOne({ _id: player.address.toLowerCase() })
    ?? await mongo.db(DB).collection('players').findOne({ _id: player.address });
  check('and it is a real document in MongoDB', Boolean(raw) && raw.gems === 42);
  await relay.stop();
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 400));
} finally {
  await mongo.db(DB).dropDatabase().catch(() => {});
  await mongo.close();
}
process.exit(done() ? 1 : 0);
