/** Live chain reads + real Mongo materialization. No signer or broadcasts. */
import assert from 'node:assert/strict';
import {MongoClient} from 'mongodb';
import {recentMatches,setHistoryDb,settlementBoard} from './recent.js';
const mongo=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000});
try {
 await mongo.connect();const db=mongo.db('mempire_arc');setHistoryDb(()=>db);
 const rows=await recentMatches();assert(rows.length>0,'a real settled match exists');
 const saved=await db.collection('match_history').findOne({matchId:rows[0].matchId});
 assert.equal(saved.tx,rows[0].tx);
 const board=settlementBoard(rows);
 for(const r of board){const stored=await db.collection('chain_leaderboard').findOne({_id:r.address});assert.equal(stored.netUsdc,r.netUsdc);}
 console.log(`PASS: ${rows.length} live settlement(s) and ${board.length} chain standings persisted in mempire_arc.`);
 setHistoryDb(()=>null);assert.equal((await recentMatches())[0].tx,saved.tx);
 console.log('PASS: cached chain history remains readable with Mongo disconnected.');
} catch(e) {console.error(`FAIL: ${e.name}: history persistence check failed`);process.exitCode=1;}
finally {await mongo.close();}
