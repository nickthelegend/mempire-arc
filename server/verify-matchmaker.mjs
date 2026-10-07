/**
 * B14 — two clients at the same tier must pair with each other.
 *
 * Talks to the deployed relay's socket directly, so a failure here is the
 * matchmaker's and a pass here puts the fault in the client's queue path.
 */
import WebSocket from 'ws';

const WS = process.env.WS ?? 'ws://localhost:8787/ws';
// Throwaway addresses: this queues casual, and a casual queue needs no signature.
const A = '0x2c00000000000000000000000000000000000a0a';
const B = '0x2c00000000000000000000000000000000000b0b';

const deck = () => Array.from({ length: 8 }, (_, i) => ({
  coinId: i,
  name: `C${i}`,
  archetype: i % 6,
  level: 1,
}));

function client(label, address, trophies) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS);
    const seen = [];
    const timer = setTimeout(() => { ws.close(); resolve({ label, matched: false, seen }); }, 25000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        t: 'queue', tier: 0, address, deck: deck(label),
        format: 'standard', ranked: false, trophies, name: label,
      }));
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      seen.push(m.t);
      if (m.t === 'matched' || m.t === 'match') {
        clearTimeout(timer);
        resolve({ label, matched: true, opponent: m.opponent?.address ?? m.opponent ?? '?', seen });
        ws.close();
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); resolve({ label, matched: false, error: e.message, seen }); });
  });
}

const [a, b] = await Promise.all([client('A', A, 0), client('B', B, 16)]);
console.log(JSON.stringify({ a, b }, null, 1));
console.log(a.matched && b.matched
  ? 'B14 PASS — the relay paired two same-tier clients'
  : 'B14 FAIL — the relay did not pair them');
