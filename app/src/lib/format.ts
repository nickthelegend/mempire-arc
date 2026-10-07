/**
 * Formatting for money, tokens and time.
 *
 * Every numeric formatter defends against NaN/Infinity/undefined at this
 * boundary. Saved state crosses versions and networks, so a missing field
 * arriving here is a matter of time — and "$NaN" in a pot readout is the
 * single worst string this app could ever render.
 */
const safe = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** A USDC amount as dollars: "$1", "$0.05", "$0.0043" for gas-sized amounts. */
export const fmtUsdc = (n: number): string => {
  const v = safe(n);
  if (v > 0 && v < 0.01) return `$${v.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
};

/** A stake or pot. USDC is the one stake currency on Arc, and it reads as dollars. */
export const fmtStake = (n: number, _currency: 'USDC' = 'USDC'): string => fmtUsdc(n);

export const fmtUsd = (n: number): string => {
  const v = safe(n);
  // Memecoins trade far below a cent: show significant digits, never "$0".
  if (v > 0 && v < 0.01) return `$${v.toLocaleString('en-US', { maximumSignificantDigits: 3 })}`;
  return v >= 1000
    ? `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 4 : 0 })}`;
};

export const fmtTokens = (n: number): string => {
  const v = safe(n);
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M`
    : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k`
      : v.toFixed(0);
};

export const shortAddr = (a: string): string =>
  (a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '—');

export const fmtClock = (ticks: number): string => {
  const s = Math.max(0, Math.ceil(safe(ticks) / 20));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
