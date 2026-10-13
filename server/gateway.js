import {encodeFunctionData,isHex,keccak256} from 'viem';
import {GatewayJournal} from './gateway-journal.js';
import {authenticateGatewayRequests} from './gateway-intent.js';
import {GATEWAY_MINT_ABI,verifyOriginalGatewayMint} from './gateway-receipt.js';
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
import { ARC_TESTNET, CHAIN_ID, IS_MAINNET, USDC, normAddress, publicClient } from './chain.js';
import { relayerAddress, sendGatewayRelayerTx } from './relayer.js';

// A local fork of Arc mainnet uses mainnet's Gateway; Arc testnet uses testnet's.
const TESTNET = CHAIN_ID === ARC_TESTNET;
export const GATEWAY = TESTNET
  ? { api: 'https://gateway-api-testnet.circle.com/v1', wallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9', minter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' }
  : { api: 'https://gateway-api.circle.com/v1', wallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE', minter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205' };

/** Source chains the app offers, by CCTP/Gateway domain. */
export const GATEWAY_DOMAINS = { 0: 'Ethereum', 3: 'Arbitrum', 6: 'Base', 26: 'Arc' };

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

export function registerGatewayRoutes(app, gate, getDurableDb=()=>null) {
  const journal=new GatewayJournal(getDurableDb);
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
    let batch;
    try {
      if(CHAIN_ID!==5042002)return res.status(503).json({error:'Durable relayed Gateway mint requires Arc testnet 5042002.'});
      batch=await authenticateGatewayRequests(req.body?.requests,GATEWAY,MAX_TOPUP);
      // Refuse memory fallback before any provider/signing handoff.
      journal.collection();
      const recoverOriginal=async old=>{
        if(old.owner!==batch.owner)throw Object.assign(new Error('Original Gateway owner differs.'),{status:403});
        if(old.identity){
          try {const proof=await verifyOriginalGatewayMint(publicClient(),old);if(old.state==='mint-submitted')await journal.advance(batch.id,batch.owner,'mint-submitted','confirmed',{finalizedBlock:proof.blockNumber,finalizedBlockHash:proof.blockHash});return res.json({ok:true,hash:proof.hash,transferId:old.transferId,recovered:true});}
          catch{return res.status(409).json({error:'Original mint outcome remains unresolved. No provider or signer request was repeated.',hash:old.identity.hash,transferId:old.transferId});}
        }
        return res.status(409).json({error:'Original Gateway transfer is durably recorded but unresolved. Genuine Circle/relayer history is required; do not authorize another transfer.',transferId:old.transferId});
      };
      const prior=await journal.get(batch.id);if(prior)return await recoverOriginal(prior);
      const relayer=relayerAddress();if(!relayer)return res.status(503).json({error:'Gateway relayer signing is unavailable.'});
      const actual=publicClient();if(await actual.getChainId()!==5042002)throw new Error('Gateway RPC network differs.');
      const minterCode=await actual.getCode({address:GATEWAY.minter});if(!minterCode||minterCode==='0x')throw new Error('Gateway minter deployment is unavailable.');
      const claimed=await journal.claim({id:batch.id,owner:batch.owner,chainId:CHAIN_ID,minter:GATEWAY.minter,token:USDC,relayer,intents:batch.intents,intentHashes:batch.intentHashes,signatureHashes:batch.signatureHashes});
      if(!claimed.created)return await recoverOriginal(claimed.entry);
      // A permanent atomic original-intent claim exists before Circle can receive the authorization.
      const r=await circle('/transfer',batch.requests);
      if(!r.ok)return res.status(502).json({error:'Original Circle transfer outcome remains locked; no automatic retry is allowed.'});
      const a=r.json;if(!isHex(a.attestation)||!isHex(a.signature))throw Error('Original Circle response has no usable attestation. History is required.');
      if(a.transferId!==undefined&&(typeof a.transferId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.transferId)))throw Error('Original Circle transfer ID is invalid.');
      await journal.advance(batch.id,batch.owner,'circle-unknown','attested',{transferId:a.transferId,attestationHash:keccak256(a.attestation),attestationSignatureHash:keccak256(a.signature)});
      const call={address:GATEWAY.minter,abi:GATEWAY_MINT_ABI,functionName:'gatewayMint',args:[a.attestation,a.signature]};
      await publicClient().simulateContract({...call,account:relayer});
      await journal.advance(batch.id,batch.owner,'attested','mint-unknown',{mintDataHash:keccak256(encodeFunctionData(call))});
      await sendGatewayRelayerTx(call,{minimumNonce:from=>journal.nonceFloor(from),persistSigned:identity=>journal.recordSigned(batch.id,batch.owner,identity)});
      const saved=await journal.get(batch.id);const proof=await verifyOriginalGatewayMint(publicClient(),saved);
      await journal.advance(batch.id,batch.owner,'mint-submitted','confirmed',{finalizedBlock:proof.blockNumber,finalizedBlockHash:proof.blockHash});
      return res.json({ok:true,hash:proof.hash,transferId:saved.transferId});
    } catch(e) {
      let saved;try{if(batch)saved=await journal.get(batch.id);}catch{}
      return res.status(e.status??(batch?503:400)).json({error:batch?'Original Gateway outcome requires recovery. No new transfer or mint was retried.':short(e),hash:saved?.identity?.hash,transferId:saved?.transferId});
    }
  });
}

// Exported for tests.
export { checkIntents };
