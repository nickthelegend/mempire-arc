/**
 * An in-process stand-in for the slice of the MongoDB driver this relay uses.
 *
 * # Why this exists
 *
 * The relay used to refuse to start without `MONGODB_URI`. That was right for a
 * deployment and wrong for everything else: running the onboarding test against
 * a local chain needed an Atlas account or a Docker daemon, neither of which has
 * anything to do with whether a starter deck gets minted. With no URI the relay
 * now boots on this instead and says so loudly — nothing persists across a
 * restart, and that is the whole contract.
 *
 * # What it is not
 *
 * It is not a database and does not try to be one. It implements the queries
 * and update operators the route handlers actually issue — equality, the
 * comparison operators, `$or`, `$regex`, `$exists`, `$size`, the positional
 * `$` update, `$push` with `$each/$position/$slice`, `$pull`, `$inc` — and unique
 * indexes, because uniqueness is what several routes lean on for correctness
 * (one claim per address, one clan per name). Aggregation pipelines return an
 * empty result: the analytics dashboards are about a fleet's history, and a
 * process that forgets everything on restart has none to report.
 *
 * Every operation runs synchronously inside its promise, so each one is atomic
 * with respect to the others — the property the real routes depend on when they
 * use a filter as a guard (`members.49: {$exists: false}`).
 */
import { randomBytes } from 'node:crypto';

const clone = (v) => (v === undefined ? v : structuredClone(v));

function duplicateKey(ns, index) {
  const e = new Error(`E11000 duplicate key error collection: ${ns} index: ${index} dup key`);
  e.code = 11000;
  return e;
}

const isPlainObject = (v) => v !== null && typeof v === 'object'
  && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
const isOperatorObject = (v) => isPlainObject(v) && Object.keys(v).some((k) => k.startsWith('$'));

function same(a, b) {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a, b) {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return x < y ? -1 : 1;
}

/**
 * Every value at `path`, walking through arrays the way Mongo does: `members.address`
 * on a document with three members yields three addresses. A numeric segment
 * indexes into an array instead, which is how `members.49` asks "is there a 50th".
 */
function valuesAt(doc, path) {
  let current = [doc];
  for (const seg of path.split('.')) {
    const next = [];
    for (const v of current) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        if (/^\d+$/.test(seg)) {
          if (v[Number(seg)] !== undefined) next.push(v[Number(seg)]);
        } else {
          for (const el of v) if (isPlainObject(el) && el[seg] !== undefined) next.push(el[seg]);
        }
      } else if (typeof v === 'object' && v[seg] !== undefined) {
        next.push(v[seg]);
      }
    }
    current = next;
  }
  return current;
}

function typeMatches(v, t) {
  if (t === 'string') return typeof v === 'string';
  if (t === 'number' || t === 'double' || t === 'int') return typeof v === 'number';
  if (t === 'bool') return typeof v === 'boolean';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return isPlainObject(v);
  if (t === 'date') return v instanceof Date;
  return false;
}

/** Equality with Mongo's array rule: a field holding an array matches any element. */
const eqOrContains = (v, want) => same(v, want) || (Array.isArray(v) && v.some((e) => same(e, want)));

function matchCondition(values, cond) {
  if (cond instanceof RegExp) return values.some((v) => typeof v === 'string' && cond.test(v));
  if (!isOperatorObject(cond)) return values.some((v) => eqOrContains(v, cond));
  for (const [op, arg] of Object.entries(cond)) {
    let ok;
    switch (op) {
      case '$eq': ok = values.some((v) => eqOrContains(v, arg)); break;
      case '$ne': ok = !values.some((v) => eqOrContains(v, arg)); break;
      case '$in': ok = values.some((v) => arg.some((a) => eqOrContains(v, a))); break;
      case '$nin': ok = !values.some((v) => arg.some((a) => eqOrContains(v, a))); break;
      case '$gt': ok = values.some((v) => v !== undefined && v !== null && compare(v, arg) > 0); break;
      case '$gte': ok = values.some((v) => v !== undefined && v !== null && compare(v, arg) >= 0); break;
      case '$lt': ok = values.some((v) => v !== undefined && v !== null && compare(v, arg) < 0); break;
      case '$lte': ok = values.some((v) => v !== undefined && v !== null && compare(v, arg) <= 0); break;
      case '$exists': ok = arg ? values.length > 0 : values.length === 0; break;
      case '$size': ok = values.some((v) => Array.isArray(v) && v.length === arg); break;
      case '$type': ok = values.some((v) => typeMatches(v, arg)); break;
      case '$not': ok = !matchCondition(values, arg); break;
      case '$regex': {
        const re = arg instanceof RegExp ? arg : new RegExp(arg, cond.$options ?? '');
        ok = values.some((v) => typeof v === 'string' && re.test(v));
        break;
      }
      case '$options': ok = true; break;
      default: throw new Error(`memory store: query operator ${op} is not supported`);
    }
    if (!ok) return false;
  }
  return true;
}

export function matches(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') { if (!cond.some((f) => matches(doc, f))) return false; continue; }
    if (key === '$and') { if (!cond.every((f) => matches(doc, f))) return false; continue; }
    if (key === '$nor') { if (cond.some((f) => matches(doc, f))) return false; continue; }
    if (key.startsWith('$')) throw new Error(`memory store: top-level ${key} is not supported`);
    if (!matchCondition(valuesAt(doc, key), cond)) return false;
  }
  return true;
}

// ── updates ──────────────────────────────────────────────────────────────────

/**
 * Rewrites `members.$.role` to `members.3.role`, where 3 is the first element the
 * filter matched — Mongo's positional operator. The filter must name a field
 * under the same array, exactly as Mongo requires.
 */
function resolvePositional(doc, path, filter) {
  const at = path.indexOf('.$');
  if (at === -1) return path;
  const arrayPath = path.slice(0, at);
  const arr = valuesAt(doc, arrayPath)[0];
  if (!Array.isArray(arr)) throw new Error(`memory store: ${arrayPath} is not an array`);
  const conds = Object.entries(filter).filter(([k]) => k.startsWith(`${arrayPath}.`));
  if (!conds.length) throw new Error(`memory store: positional update on ${arrayPath} needs a filter on it`);
  const idx = arr.findIndex((el) => conds.every(([k, c]) => (
    matchCondition(valuesAt(el, k.slice(arrayPath.length + 1)), c)
  )));
  if (idx === -1) throw new Error(`memory store: no element of ${arrayPath} matched`);
  return `${arrayPath}.${idx}${path.slice(at + 2)}`;
}

function parentOf(doc, path, create) {
  const segs = path.split('.');
  let cur = doc;
  for (const seg of segs.slice(0, -1)) {
    const key = Array.isArray(cur) ? Number(seg) : seg;
    if (cur[key] === undefined || cur[key] === null) {
      if (!create) return [null, null];
      cur[key] = {};
    }
    cur = cur[key];
  }
  const last = segs[segs.length - 1];
  return [cur, Array.isArray(cur) ? Number(last) : last];
}

function applyUpdate(doc, update, filter, inserting) {
  if (Array.isArray(update)) {
    throw new Error('memory store: aggregation-pipeline updates are not supported');
  }
  for (const [op, fields] of Object.entries(update)) {
    for (const [rawPath, arg] of Object.entries(fields ?? {})) {
      const path = resolvePositional(doc, rawPath, filter);
      switch (op) {
        case '$set': { const [p, k] = parentOf(doc, path, true); p[k] = clone(arg); break; }
        case '$setOnInsert': {
          if (inserting) { const [p, k] = parentOf(doc, path, true); p[k] = clone(arg); }
          break;
        }
        case '$unset': { const [p, k] = parentOf(doc, path, false); if (p) delete p[k]; break; }
        case '$inc': { const [p, k] = parentOf(doc, path, true); p[k] = (Number(p[k]) || 0) + Number(arg); break; }
        case '$min': { const [p, k] = parentOf(doc, path, true); if (p[k] === undefined || compare(arg, p[k]) < 0) p[k] = clone(arg); break; }
        case '$max': { const [p, k] = parentOf(doc, path, true); if (p[k] === undefined || compare(arg, p[k]) > 0) p[k] = clone(arg); break; }
        case '$push':
        case '$addToSet': {
          const [p, k] = parentOf(doc, path, true);
          if (p[k] === undefined) p[k] = [];
          if (!Array.isArray(p[k])) throw new Error(`memory store: ${path} is not an array`);
          const each = isPlainObject(arg) && '$each' in arg ? arg.$each : [arg];
          let items = each.map(clone);
          if (op === '$addToSet') items = items.filter((it) => !p[k].some((e) => same(e, it)));
          const pos = isPlainObject(arg) && Number.isInteger(arg.$position) ? arg.$position : p[k].length;
          p[k].splice(pos, 0, ...items);
          if (isPlainObject(arg) && Number.isInteger(arg.$slice)) {
            p[k] = arg.$slice >= 0 ? p[k].slice(0, arg.$slice) : p[k].slice(arg.$slice);
          }
          break;
        }
        case '$pull': {
          const [p, k] = parentOf(doc, path, false);
          if (!p || !Array.isArray(p[k])) break;
          p[k] = p[k].filter((el) => (isPlainObject(arg) && !isOperatorObject(arg) && isPlainObject(el)
            ? !matches(el, arg)
            : !matchCondition([el], arg)));
          break;
        }
        default: throw new Error(`memory store: update operator ${op} is not supported`);
      }
    }
  }
}

/** The equality fields of a filter, which an upsert seeds its new document with. */
function seedFromFilter(filter) {
  const doc = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$') || k.includes('.') || isOperatorObject(v) || v instanceof RegExp) continue;
    doc[k] = clone(v);
  }
  return doc;
}

function project(doc, projection) {
  if (!doc || !projection || !Object.keys(projection).length) return clone(doc);
  const include = Object.entries(projection).filter(([k, v]) => v && k !== '_id');
  if (include.length) {
    const out = {};
    if (projection._id !== 0 && projection._id !== false) out._id = clone(doc._id);
    for (const [k] of include) if (doc[k] !== undefined) out[k] = clone(doc[k]);
    return out;
  }
  const out = clone(doc);
  for (const [k, v] of Object.entries(projection)) if (!v) delete out[k];
  return out;
}

function sorter(spec) {
  const keys = Object.entries(spec ?? {});
  return (a, b) => {
    for (const [k, dir] of keys) {
      const c = compare(valuesAt(a, k)[0], valuesAt(b, k)[0]);
      if (c) return dir < 0 ? -c : c;
    }
    return 0;
  };
}

class MemoryCursor {
  constructor(docs, projection) { this.docs = docs; this.projection = projection; this.n = 0; }
  sort(spec) { this.docs.sort(sorter(spec)); return this; }
  limit(n) { this.n = n; return this; }
  project(p) { this.projection = p; return this; }
  async toArray() {
    const rows = this.n ? this.docs.slice(0, this.n) : this.docs;
    return rows.map((d) => project(d, this.projection));
  }
}

class MemoryCollection {
  constructor(ns) {
    this.ns = ns;
    /** `_id` (stringified for lookup) → document. Insertion-ordered, like a scan. */
    this.docs = new Map();
    this.uniques = [];
    this.ttls = [];
    this.writes = 0;
  }

  key(id) { return typeof id === 'string' ? `s:${id}` : `j:${JSON.stringify(id)}`; }

  async createIndex(spec, opts = {}) {
    const fields = Object.keys(spec);
    const name = opts.name ?? fields.map((f) => `${f}_${spec[f]}`).join('_');
    if (opts.unique && fields.length === 1 && fields[0] !== '_id') {
      this.uniques.push({
        name,
        field: fields[0],
        fold: opts.collation?.strength <= 2,
        partial: opts.partialFilterExpression ?? null,
      });
    }
    if (Number.isFinite(opts.expireAfterSeconds) && fields.length === 1) {
      this.ttls.push({ field: fields[0], ms: opts.expireAfterSeconds * 1000 });
    }
    return name;
  }

  async dropIndex() { return null; }

  /**
   * TTL indexes, enforced lazily. A memory-mode relay that runs for a week still
   * should not hold every auth signature it ever saw, so expired rows are swept
   * every so often on write rather than by a background timer.
   */
  sweep() {
    this.writes += 1;
    if (!this.ttls.length || this.writes % 64) return;
    const now = Date.now();
    for (const [k, d] of this.docs) {
      if (this.ttls.some((t) => d[t.field] instanceof Date && now - d[t.field].getTime() > t.ms)) {
        this.docs.delete(k);
      }
    }
  }

  checkUnique(doc, selfKey) {
    for (const u of this.uniques) {
      let v = doc[u.field];
      if (v === undefined) continue;
      if (u.partial && !matches(doc, u.partial)) continue;
      if (u.fold && typeof v === 'string') v = v.toLowerCase();
      for (const [k, other] of this.docs) {
        if (k === selfKey) continue;
        if (u.partial && !matches(other, u.partial)) continue;
        let w = other[u.field];
        if (u.fold && typeof w === 'string') w = w.toLowerCase();
        if (same(v, w)) throw duplicateKey(this.ns, u.name);
      }
    }
  }

  async insertOne(input) {
    const doc = clone(input);
    if (doc._id === undefined) doc._id = randomBytes(12).toString('hex');
    const k = this.key(doc._id);
    if (this.docs.has(k)) throw duplicateKey(this.ns, '_id_');
    this.checkUnique(doc, k);
    this.docs.set(k, doc);
    this.sweep();
    return { acknowledged: true, insertedId: doc._id };
  }

  scan(filter = {}) {
    if (filter._id !== undefined && !isOperatorObject(filter._id) && !(filter._id instanceof RegExp)) {
      const d = this.docs.get(this.key(filter._id));
      return d && matches(d, filter) ? [d] : [];
    }
    return [...this.docs.values()].filter((d) => matches(d, filter));
  }

  async findOne(filter, opts = {}) {
    const [d] = this.scan(filter);
    return d ? project(d, opts.projection) : null;
  }

  find(filter, opts = {}) { return new MemoryCursor([...this.scan(filter)], opts.projection); }

  async countDocuments(filter) { return this.scan(filter).length; }

  /** Shared by updateOne and findOneAndUpdate. Returns [before, after, result]. */
  modify(filter, update, opts) {
    const [found] = this.scan(filter);
    if (!found) {
      if (!opts.upsert) return [null, null, { acknowledged: true, matchedCount: 0, modifiedCount: 0 }];
      const doc = seedFromFilter(filter);
      applyUpdate(doc, update, filter, true);
      if (doc._id === undefined) doc._id = randomBytes(12).toString('hex');
      const k = this.key(doc._id);
      if (this.docs.has(k)) throw duplicateKey(this.ns, '_id_');
      this.checkUnique(doc, k);
      this.docs.set(k, doc);
      this.sweep();
      return [null, doc, { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: doc._id, upsertedCount: 1 }];
    }
    const before = clone(found);
    const next = clone(found);
    applyUpdate(next, update, filter, false);
    const k = this.key(found._id);
    this.checkUnique(next, k);
    this.docs.set(k, next);
    this.sweep();
    return [before, next, {
      acknowledged: true, matchedCount: 1, modifiedCount: same(before, next) ? 0 : 1,
    }];
  }

  async updateOne(filter, update, opts = {}) { return this.modify(filter, update, opts)[2]; }

  async updateMany(filter, update) {
    let n = 0;
    for (const d of this.scan(filter)) {
      await this.updateOne({ _id: d._id }, update);
      n += 1;
    }
    return { acknowledged: true, matchedCount: n, modifiedCount: n };
  }

  async findOneAndUpdate(filter, update, opts = {}) {
    const [before, after] = this.modify(filter, update, opts);
    const out = opts.returnDocument === 'after' ? after : before;
    return out ? project(out, opts.projection) : null;
  }

  async deleteOne(filter) {
    const [d] = this.scan(filter);
    if (!d) return { acknowledged: true, deletedCount: 0 };
    this.docs.delete(this.key(d._id));
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter) {
    const hit = this.scan(filter);
    for (const d of hit) this.docs.delete(this.key(d._id));
    return { acknowledged: true, deletedCount: hit.length };
  }

  /** See the header: history-shaped questions have no answer in a process with no history. */
  aggregate() { return { toArray: async () => [] }; }
}

export function createMemoryDb(name = 'memory') {
  const collections = new Map();
  return {
    inMemory: true,
    databaseName: name,
    collection(c) {
      if (!collections.has(c)) collections.set(c, new MemoryCollection(`${name}.${c}`));
      return collections.get(c);
    },
    async createCollection(c) { return this.collection(c); },
    async command() { return { ok: 1 }; },
  };
}
