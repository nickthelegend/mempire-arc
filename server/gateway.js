/**
 * Circle Gateway: one USDC balance across chains, spendable on Arc instantly.
 *
 * A player deposits USDC into the GatewayWallet on any supported chain (Base,
 * Ethereum, Arbitrum… or Arc itself) and it joins their unified balance. To
 * stake, the app signs a Gateway *burn intent* with the player's passkey key
 * (EIP-712, domain "GatewayWallet" v1) naming their own address on Arc as the
 * recipient; this relay forwards it to Circle's Gateway API, which answers with
 * an attestation, and submits `GatewayMinter.gatewayMint` on Arc — paying the
 * mint's gas in USDC so the player needs nothing on Arc first. The USDC lands
 * at the player's address on Arc in about a second, ready to stake.
 *
 * The relay holds no funds and decides nothing: the intent is the player's
 * signature, the attestation is Circle's, the recipient is fixed inside both,
 * and a mint that would revert is simulated and refused before any gas is
 * spent. The browser talks to Circle through this route only because the API
 * is not CORS-enabled for arbitrary origins.
 */
import { ARC_TESTNET, CHAIN_ID, IS_MAINNET, normAddress, publicClient } from './chain.js';
import { relayerAddress, sendRelayerTx } from './relayer.js';

// A local fork of Arc mainnet uses mainnet's Gateway; Arc testnet uses testnet's.
const TESTNET = CHAIN_ID === ARC_TESTNET;
export const GATEWAY = TESTNET
  ? { api: 'https://gateway-api-testnet.circle.com/v1', wallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9', minter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' }
  : { api: 'https://gateway-api.circle.com/v1', wallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE', minter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205' };

/** Source chains the app offers, by CCTP/Gateway domain. */
export const GATEWAY_DOMAINS = { 0: 'Ethereum', 3: 'Arbitrum', 6: 'Base', 26: 'Arc' };

const MINTER_ABI = [{
  type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable',
  inputs: [{ name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }], outputs: [],
}];

/** Most a single relayed top-up may move, in USDC (bounded on mainnet: real money, relayer gas). */
const MAX_TOPUP = Number(process.env.GATEWAY_MAX_TOPUP ?? 100);

const short = (e) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 200);

async function circle(path, body) {
  const res = await fetch(`${GATEWAY.api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/** Basic shape checks before anything is forwarded: Arc destination, the depositor is the recipient. */
function checkIntents(requests) {
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > 4) return 'requests must be 1–4 signed burn intents';
  let total = 0;
  for (const r of requests) {
    const spec = r?.burnIntent?.spec;
    if (!spec || typeof r.signature !== 'string') return 'each request needs { burnIntent, signature }';
    if (Number(spec.destinationDomain) !== 26) return 'the destination must be Arc (domain 26)';
    if (String(spec.destinationRecipient).toLowerCase() !== String(spec.sourceDepositor).toLowerCase()) {
      return 'top-ups mint to the depositor themself only';
    }
    total += Number(spec.value) / 1e6;
  }
  if (!(total > 0) || (IS_MAINNET && total > MAX_TOPUP)) return `a top-up must be between 0 and ${MAX_TOPUP} USDC`;
  return null;
}

export function registerGatewayRoutes(app, gate) {
  const pass = (_req, _res, next) => next();

  app.get('/api/gateway/config', (_req, res) => {
    res.json({ api: GATEWAY.api, wallet: GATEWAY.wallet, minter: GATEWAY.minter, domains: GATEWAY_DOMAINS, relayedMint: Boolean(relayerAddress()) });
  });

  /** The player's unified balance, per source chain (Circle's numbers, 6-decimal strings). */
  app.get('/api/gateway/balances/:address', gate ?? pass, async (req, res) => {
    const depositor = normAddress(req.params.address);
    if (!depositor) return res.status(400).json({ error: 'bad address' });
    try {
      const r = await circle('/balances', {
        token: 'USDC',
        sources: Object.keys(GATEWAY_DOMAINS).map((d) => ({ domain: Number(d), depositor })),
      });
      if (!r.ok) return res.status(502).json({ error: r.json?.message ?? `gateway answered ${r.status}` });
      const balances = (r.json.balances ?? []).map((b) => ({ ...b, chain: GATEWAY_DOMAINS[b.domain] ?? `domain ${b.domain}` }));
      const total = balances.reduce((s, b) => s + Number(b.balance || 0), 0);
      res.json({ depositor, total: total.toFixed(6), balances });
    } catch (e) {
      res.status(502).json({ error: `could not reach Circle Gateway: ${short(e)}` });
    }
  });

  /**
   * Forward signed burn intents to Circle and mint the attested USDC on Arc.
   * Body: { requests: [{ burnIntent, signature }] } exactly as Circle's /transfer takes it.
   */
  app.post('/api/gateway/mint', gate ?? pass, async (req, res) => {
    const bad = checkIntents(req.body?.requests);
    if (bad) return res.status(400).json({ error: bad });
    if (!relayerAddress()) return res.status(503).json({ error: 'no relayer key: the app can call gatewayMint itself' });
    let attestation;
    try {
      const r = await circle('/transfer', req.body.requests);
      if (!r.ok) return res.status(r.status === 400 ? 400 : 502).json({ error: r.json?.message ?? `gateway answered ${r.status}`, gateway: r.json });
      attestation = r.json;
    } catch (e) {
      return res.status(502).json({ error: `could not reach Circle Gateway: ${short(e)}` });
    }
    const call = { address: GATEWAY.minter, abi: MINTER_ABI, functionName: 'gatewayMint', args: [attestation.attestation, attestation.signature] };
    try {
      await publicClient().simulateContract({ ...call, account: relayerAddress() });
    } catch (e) {
      return res.status(409).json({ error: `the attestation would not mint: ${short(e)}`, attestation });
    }
    try {
      const { hash } = await sendRelayerTx(call);
      res.json({ ok: true, hash, transferId: attestation.transferId ?? null });
    } catch (e) {
      res.status(502).json({ error: `mint failed: ${short(e)}`, hash: e?.hash ?? null });
    }
  });
}

// Exported for tests.
export { checkIntents };
