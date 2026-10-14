export interface Settlement {
 matchId: number; winnerSeat: number; winner: string; players: string[];
 pot: string; rake: string; byTimeout: boolean; tx: string; block: number; at: number | null;
}
export function settlementBoard(matches: Settlement[]): {address: string; wins: number; losses: number; matches: number; crowns: number; netUsdc: number}[];
