import { useCallback, useEffect, useState } from 'react';
import { erc20Abi, formatUnits, parseUnits, type Abi } from 'viem';
import { activeSigner, readableChainError, send } from '../chain/account';
import { explorerUrl, NETWORK_LABEL, USDC } from '../chain/provider';
import { recoverRemoteEntry, enterFromRemote, REMOTE_CHAINS, remoteBalances, type RemoteChain } from '../lib/ccip';
import { recoverTopUpArc, GATEWAY_WALLET, gatewayBalances, submitTopUpArc, type GatewayBalance } from '../lib/gateway';
import { fmtUsdc, shortAddr } from '../lib/format';
import { useChain } from '../state/chain';
import { useWallet } from '../state/wallet';
import { Pill } from './ui';

/*
 * "Your money, any chain": the cross-chain half of Mempire, on one panel.
 *
 *  - Circle Gateway: the player's unified USDC balance across Ethereum,
 *    Arbitrum, Base and Arc. "Top up Arc" signs burn intents with the passkey
 *    and the relay mints the USDC on Arc in about a second; "Park" deposits
 *    idle Arc USDC into the unified balance.
 *  - Chainlink CCIP + CCTP: open a match on Arc from Base or Ethereum in one
 *    source transaction (CCTP Fast Transfer moves the dollars, CCIP carries the
 *    instruction). Shown per chain, live only where a remote entry is deployed.
 *
 * Same address everywhere: the passkey account is a plain EOA.
 */

const GATEWAY_ABI = [{
  type: 'function', name: 'deposit', stateMutability: 'nonpayable',
  inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [],
}] as const satisfies Abi;

export function ArcStack() {
  const wallet = useWallet();
  const refresh = useChain((s) => s.refresh);
  const cards = useChain((s) => s.cards);
  const [bal, setBal] = useState<{ total: string; balances: GatewayBalance[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; href?: string; bad?: boolean } | null>(null);
  const [remote, setRemote] = useState<Record<string, { usdc: bigint; native: bigint } | null>>({});

  const load = useCallback(async () => {
    if (!wallet.address) return;
    setBal(await gatewayBalances(wallet.address));
    const out: Record<string, { usdc: bigint; native: bigint } | null> = {};
    await Promise.all(REMOTE_CHAINS.map(async (rc) => {
      out[rc.key] = await remoteBalances(rc, wallet.address as `0x${string}`).catch(() => null);
    }));
    setRemote(out);
  }, [wallet.address]);
  useEffect(() => { void load(); }, [load]);

  if (!wallet.connected) return null;

  const run = async (key: string, fn: () => Promise<{ text: string; href?: string }>) => {
    setBusy(key);
    setNote(null);
    try {
      setNote(await fn());
      void refresh();
      void load();
    } catch (e) {
      setNote({ text: readableChainError(e), bad: true });
    } finally {
      setBusy(null);
    }
  };

  const topUp = () => run('topup', async () => {
    const s = activeSigner();
    if (!s || !bal) throw new Error('sign in first');
    // Take $1 (one Pauper stake) from the first chains that hold it — Arc's own last.
    let need = 1_000_000n;
    const amounts: { domain: number; units: bigint }[] = [];
    for (const b of [...bal.balances].sort((x, y) => (x.domain === 26 ? 1 : 0) - (y.domain === 26 ? 1 : 0))) {
      const have = parseUnits(b.balance, 6);
      if (need === 0n || have === 0n) continue;
      const take = have < need ? have : need;
      amounts.push({ domain: b.domain, units: take });
      need -= take;
    }
    if (!amounts.length) throw new Error('your unified balance is empty — deposit USDC on any chain first');
    const { hash } = await submitTopUpArc(s, amounts);
    return { text: 'Minted on Arc from your unified balance', href: explorerUrl(hash) };
  });

  const park = () => run('park', async () => {
    const s = activeSigner();
    if (!s) throw new Error('sign in first');
    const units = 1_000_000n;
    await send({ address: USDC, abi: erc20Abi as unknown as Abi, functionName: 'approve', args: [GATEWAY_WALLET, units] });
    const r = await send({ address: GATEWAY_WALLET, abi: GATEWAY_ABI as unknown as Abi, functionName: 'deposit', args: [USDC, units] });
    return { text: '$1 parked in your unified balance', href: explorerUrl(r.hash) };
  });

  const enter = (rc: RemoteChain) => run(`enter-${rc.key}`, async () => {
    const s = activeSigner();
    if (!s) throw new Error('sign in first');
    const seen = new Set<number>();
    const deck = cards.filter((c) => !c.inMatch && !seen.has(c.coinId) && seen.add(c.coinId)).slice(0, 8).map((c) => BigInt(c.id));
    if (deck.length < 8) throw new Error('you need eight free cards of different fighters');
    const { explorer } = await enterFromRemote(s, rc, { tier: 0, cardIds: deck, bridgeUnits: 1_000_000n });
    return { text: `Entry instruction sent from ${rc.label}; Arc match completion is not yet verified`, href: explorer };
  });

  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } as const;
  return (
    <section aria-label="Your USDC on any chain" className="panel" style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
      <div style={row}>
        <span className="label">Your USDC, any chain</span>
        <span className="mono fine" title="The same passkey address on every EVM chain">{shortAddr(wallet.address)} · everywhere</span>
      </div>

      <div className="well" style={{ padding: '8px 10px', display: 'grid', gap: 6 }}>
        <div style={row}>
          <span className="display display--sm" style={{ fontSize: 14 }}>Circle Gateway · unified balance</span>
          <span className="money">{bal ? fmtUsdc(Number(bal.total)) : '…'}</span>
        </div>
        <span className="fine" style={{ fontSize: 12 }}>
          {bal ? bal.balances.map((b) => `${b.chain} ${fmtUsdc(Number(b.balance))}`).join(' · ') : 'reading Circle Gateway…'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Pill tone="blue" disabled={busy!==null} onClick={()=>void run('recover-gateway',async()=>{const r=await recoverTopUpArc();return {text:'Original Gateway mint verified finalized',href:explorerUrl(r.hash)};})}>Check original Gateway transfer</Pill>
          <Pill tone="gold" disabled={busy !== null || !bal || Number(bal.total) <= 0} onClick={() => void topUp()}>
            {busy === 'topup' ? 'Minting…' : 'Top up Arc · $1'}
          </Pill>
          <Pill tone="blue" disabled={busy !== null || wallet.usdc < 1.01} onClick={() => void park()}>
            {busy === 'park' ? 'Parking…' : 'Park $1'}
          </Pill>
        </div>
      </div>

      <div className="well" style={{ padding: '8px 10px', display: 'grid', gap: 6 }}>
        <span className="display display--sm" style={{ fontSize: 14 }}>Enter from another chain · Chainlink CCIP + CCTP</span>
        <Pill tone="blue" disabled={busy!==null} onClick={()=>void run('recover-remote',async()=>{const s=activeSigner();if(!s)throw Error('Restore the original player.');const r=await recoverRemoteEntry(s);return {text:r.message,href:`https://ccip.chain.link/tx/${r.hash}`};})}>Check original remote entry</Pill>
        <span className="fine" style={{ fontSize: 12 }}>
          One transaction on the source chain: CCTP moves your $1 to {NETWORK_LABEL}, CCIP carries the instruction, and the match opens here.
        </span>
        {REMOTE_CHAINS.map((rc) => {
          const b = remote[rc.key];
          return (
            <div key={rc.key} style={row}>
              <span className="fine" style={{ fontSize: 12 }}>
                {rc.label}{b ? ` · ${fmtUsdc(Number(formatUnits(b.usdc, 6)))} USDC` : ''}
                {!rc.entry ? ' · entry not deployed yet' : ''}
              </span>
              <Pill tone="blue" disabled={busy !== null || !rc.entry || !b || b.usdc < 1_000_000n || b.native === 0n} onClick={() => void enter(rc)}>
                {busy === `enter-${rc.key}` ? 'Sending…' : `Enter from ${rc.label.split(' ')[0]}`}
              </Pill>
            </div>
          );
        })}
      </div>

      {note && (
        note.href
          ? <a className="fine" href={note.href} target="_blank" rel="noreferrer" style={{ color: note.bad ? 'var(--red)' : 'var(--teal)' }}>{note.text} ↗</a>
          : <span className="fine" style={{ color: note.bad ? 'var(--red)' : 'var(--teal)' }}>{note.text}</span>
      )}
      <span className="fine" style={{ fontSize: 11, color: 'var(--dim)' }}>
        Gas on Arc is USDC too, and every transaction is final in under a second.
      </span>
    </section>
  );
}
