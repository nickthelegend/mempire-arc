/**
 * The in-memory store, against the query shapes the routes actually issue.
 *
 * `memstore.js` stands in for Mongo when no URI is set, and the routes lean on
 * Mongo semantics for correctness — a unique `_id` as a claim, a filter as a
 * capacity guard, the positional `$` to edit one roster entry. Each check
 * below is one of those, lifted from the route that depends on it.
 *
 *   node test-memstore.mjs
 */
import { createMemoryDb } from './memstore.js';
import { tally } from './test-util.mjs';

const { check, done } = tally();
const db = createMemoryDb('t');

console.log('1. claims');
const claims = db.collection('claims');
await claims.insertOne({ _id: 'a', at: new Date() });
let dup = null;
try { await claims.insertOne({ _id: 'a' }); } catch (e) { dup = e; }
check('a second insert of one _id is E11000', dup?.code === 11000);

console.log('\n2. clans');
const clans = db.collection('clans');
await clans.createIndex({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
await clans.createIndex({ charterTx: 1 }, { unique: true, partialFilterExpression: { charterTx: { $type: 'string' } } });
await clans.insertOne({ _id: 'AAAAAA', name: 'Diamond Hands', members: [{ address: '0xa', role: 'leader', lent: 0 }], feed: [] });
let nameDup = null;
try { await clans.insertOne({ _id: 'BBBBBB', name: 'diamond hands', members: [] }); } catch (e) { nameDup = e; }
check('a name differing only in case is a duplicate, and says "name"', nameDup?.code === 11000 && /name/.test(nameDup.message));
await clans.insertOne({ _id: 'CCCCCC', name: 'Paper', members: [] });
await clans.insertOne({ _id: 'DDDDDD', name: 'Rock', members: [] });
check('clans without a charter do not collide on the partial index', (await clans.countDocuments({})) === 3);

const joined = await clans.findOneAndUpdate(
  { _id: 'AAAAAA', 'members.49': { $exists: false }, 'members.address': { $ne: '0xb' } },
  { $push: { members: { address: '0xb', role: 'member', lent: 0 }, feed: { $each: [{ kind: 'joined' }], $position: 0, $slice: 60 } } },
  { returnDocument: 'after' },
);
check('the join guard admits a new member', joined?.members.length === 2);
const again = await clans.findOneAndUpdate(
  { _id: 'AAAAAA', 'members.address': { $ne: '0xb' } },
  { $push: { members: { address: '0xb' } } },
  { returnDocument: 'after' },
);
check('and refuses the same member twice', again === null);

await clans.updateOne({ _id: 'AAAAAA', 'members.address': '0xb' }, { $set: { 'members.$.role': 'elder' }, $inc: { 'members.$.lent': 2 } });
const c = await clans.findOne({ _id: 'AAAAAA' });
check('the positional $ edits the matched member only',
  c.members[1].role === 'elder' && c.members[1].lent === 2 && c.members[0].role === 'leader');
await clans.updateOne({ _id: 'AAAAAA' }, { $pull: { members: { address: '0xb' } } });
check('$pull removes by sub-document match', (await clans.findOne({ _id: 'AAAAAA' })).members.length === 1);
const listed = await clans.find({ members: { $exists: true, $not: { $size: 0 } } }).sort({ _id: 1 }).toArray();
check('$not/$size hides empty clans', listed.length === 1 && listed[0]._id === 'AAAAAA');
const found = await clans.find({ $or: [{ _id: 'ZZZ' }, { name: { $regex: 'diam', $options: 'i' } }] }).toArray();
check('$or with a case-insensitive $regex', found.length === 1);

console.log('\n3. ladder');
const ladder = db.collection('ladder');
await ladder.updateOne({ _id: '0xa' }, { $set: { trophies: 30 }, $inc: { wins: 1 }, $setOnInsert: { createdAt: 1 } }, { upsert: true });
await ladder.updateOne({ _id: '0xa' }, { $set: { trophies: 60 }, $inc: { wins: 1 }, $setOnInsert: { createdAt: 2 } }, { upsert: true });
await ladder.updateOne({ _id: '0xb' }, { $set: { trophies: 90 } }, { upsert: true });
const a = await ladder.findOne({ _id: '0xa' });
check('upsert inserts once, then updates; $setOnInsert only on insert', a.wins === 2 && a.createdAt === 1 && a.trophies === 60);
check('rank by $gt count', (await ladder.countDocuments({ trophies: { $gt: 60 } })) === 1);
const top = await ladder.find({}, { projection: { trophies: 1 } }).sort({ trophies: -1 }).limit(1).toArray();
check('sort, limit and inclusion projection', top.length === 1 && top[0]._id === '0xb' && !('wins' in top[0]));

console.log('\n4. analytics');
check('aggregations answer empty rather than throw', (await db.collection('events').aggregate([{ $match: {} }]).toArray()).length === 0);

process.exit(done() ? 1 : 0);
