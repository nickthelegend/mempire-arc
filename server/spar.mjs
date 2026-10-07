/**
 * A sparring partner that sits in the ranked queue.
 *
 * Two browser tabs cannot be relied on to queue together: only one tab is
 * foreground at a time and background tabs have their timers throttled, so the
 * two queue windows never overlapped and every "PvP" match was really the bot
 * fallback. This holds a queue slot open from node so a browser client can pair
 * with a genuine human seat on the relay, which is what C5 needs to exercise.
 *
 * It plays no cards and escrows nothing — the browser's behaviour is what is
 * under test. It stays connected so the pairing is real from the relay's side.
 */
import WebSocket from 'ws';
import { freshAccount, signed } from './test-util.mjs';

const WS = process.env.WS ?? 'ws://localhost:8787/ws';
const HOLD_MS = Number(process.env.HOLD_MS ?? 180000);
// A throwaway key per run: the ranked queue needs a signature, and a key
// that exists only for this process is the only kind worth signing with here.
const me = freshAccount();

const deck = Array.from({ length: 8 }, (_, i) => ({
  coinId: i,
  name: `S${i}`,
  archetype: i % 6,
  level: 1,
}));

const ws = new WebSocket(WS);
const t0 = Date.now();

ws.on('open', async () => {
  console.log(`spar: connected as ${me.address}, queueing tier 0 ranked`);
  ws.send(JSON.stringify({
    t: 'queue', ...(await signed(me, 'queue')), tier: 0, deck,
    format: 'standard', ranked: true, trophies: 16, name: 'Sparring Partner',
  }));
});

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  console.log(`spar: <- ${m.t}${m.opponent ? ` opponent=${m.opponent.address ?? m.opponent}` : ''}`);
  if (m.t === 'matched') {
    console.log('spar: PAIRED — the browser now has a real human seat');
  }
});

ws.on('close', () => console.log('spar: socket closed'));
ws.on('error', (e) => console.log('spar: error', e.message));

setTimeout(() => { console.log('spar: holding period over'); ws.close(); process.exit(0); }, HOLD_MS);
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
}, 15000);
