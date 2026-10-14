import test from 'node:test';
import assert from 'node:assert/strict';
import {settlementBoard} from './shared/settlements.mjs';
const a='0x1111111111111111111111111111111111111111', b='0x2222222222222222222222222222222222222222';
const match={players:[a,b],winnerSeat:0,pot:'2000000',rake:'200000'};
test('winner and loser reflect the paid pot, not client reports',()=>{
 const rows=settlementBoard([match]);assert.equal(rows[0].netUsdc,0.8);assert.equal(rows[1].netUsdc,-1);
 assert.equal(rows[0].wins,1);assert.equal(rows[1].losses,1);
});
test('draw splits pot after tie rake; void refunds without a win',()=>{
 for(const winnerSeat of [2,3]) {
  const rows=settlementBoard([{...match,winnerSeat,rake:winnerSeat===2?'100000':'0'}]);
  for(const r of rows){assert(Math.abs(r.netUsdc-(winnerSeat===2?-0.05:0))<1e-9);assert.equal(r.wins+r.losses,0);}
 }
});
test('both seats aggregate repeated matches without inventing crowns',()=>{
 const rows=settlementBoard([match,{...match,players:[b,a],winnerSeat:1}]);
 assert.equal(rows[0].netUsdc,1.6);assert.equal(rows[0].matches,2);assert.equal(rows[1].netUsdc,-2);
 assert.equal(rows[0].crowns,0);assert.deepEqual(settlementBoard([]),[]);
});
