/** Chain-derived accounting shared by the browser and API. Values are USDC dollars. */
export function settlementBoard(matches) {
  const rows = new Map();
  for (const m of matches) {
    const stake = Number(m.pot) / 2e6;
    const paid = (Number(m.pot) - Number(m.rake)) / 1e6;
    for (let seat = 0; seat < 2; seat++) {
      const address = m.players[seat].toLowerCase();
      if (/^0x0{40}$/.test(address)) continue;
      const r = rows.get(address) ?? { address, wins: 0, losses: 0, matches: 0, crowns: 0, netUsdc: 0 };
      const decisive = m.winnerSeat < 2;
      r.matches++;
      r.wins += Number(decisive && seat === m.winnerSeat);
      r.losses += Number(decisive && seat !== m.winnerSeat);
      r.netUsdc += (decisive ? (seat === m.winnerSeat ? paid : 0) : paid / 2) - stake;
      rows.set(address, r);
    }
  }
  return [...rows.values()].sort((a, b) => b.netUsdc - a.netUsdc);
}
