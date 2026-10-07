/**
 * Recorded source responses for the unit tests (which never touch the network).
 *
 * The Frankfurter bodies are verbatim answers from https://api.frankfurter.dev/v1
 * captured on 2026-10-07:
 *   /latest?from=USD&to=AUD,BRL,CAD,EUR,JPY,KRW,MXN      → FX_LATEST_2026_10_07
 *   /2026-10-06?from=USD&to=…                             → FX_2026_10_06
 *   /2026-10-04?from=USD&to=…  (a Sunday: answers with Friday's fixing,
 *                               note `date` is 2026-10-02) → FX_2026_10_04_SUNDAY
 * Rates are USD → XXX (units of XXX per US dollar).
 */

export const FX_LATEST_2026_10_07 = {
	amount: 1.0,
	base: 'USD',
	date: '2026-10-07',
	rates: { AUD: 1.4386, BRL: 5.0061, CAD: 1.4253, EUR: 0.89469, JPY: 158.23, KRW: 1338.69, MXN: 18.0943 },
}

export const FX_2026_10_06 = {
	amount: 1.0,
	base: 'USD',
	date: '2026-10-06',
	rates: { AUD: 1.4322, BRL: 4.9686, CAD: 1.425, EUR: 0.88739, JPY: 158.09, KRW: 1338.78, MXN: 17.9448 },
}

export const FX_2026_10_04_SUNDAY = {
	amount: 1.0,
	base: 'USD',
	date: '2026-10-02',
	rates: { AUD: 1.4411, BRL: 5.2214, CAD: 1.424, EUR: 0.89087, JPY: 157.67, KRW: 1348.28, MXN: 18.335 },
}

/**
 * Expected fiat-fighter bps for FX_LATEST_2026_10_07 vs FX_2026_10_06:
 * round((past / latest − 1) × 100 × 40), e.g. EUR 0.88739 / 0.89469 − 1 = −0.8159% → −33.
 */
export const FX_EXPECTED_BPS_2026_10_07: Readonly<Record<string, number>> = {
	EUR: -33, // USD 0.88739 → 0.89469 EUR: the dollar gained, EUR / USD fell
	JPY: -4, // −0.0885%
	AUD: -18, // −0.4449%
	CAD: -1, // −0.0210%
	MXN: -33, // −0.8262%
	BRL: -30, // −0.7491%
	KRW: 0, // +0.0067% → 0.27
}

/** Shape of CoinGecko /simple/price?…&vs_currencies=usd&include_24hr_change=true. */
export const coingeckoBody = (changes: Record<string, number>) =>
	Object.fromEntries(Object.entries(changes).map(([id, usd_24h_change]) => [id, { usd: 1, usd_24h_change }]))
