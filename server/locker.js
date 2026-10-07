/**
 * The passkey locker store: opaque ciphertext under an opaque id.
 *
 * The client derives both the encryption key and the id from a passkey PRF
 * namespace the account never uses (see app/src/lib/locker.ts). So this route
 * receives a 256-bit id it cannot link to any wallet, and a blob it cannot
 * read. There is deliberately no auth: a signature would name the wallet and
 * undo the unlinkability that is the point. The id is the capability — knowing
 * it requires the passkey — and an AES-GCM tag bound to the id means a blob
 * written under someone else's id would not decrypt for them anyway.
 *
 * Bounded so it cannot become free storage: hex only, one small document per id.
 */
const ID = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const MAX_CT_HEX = 16_384; // 8 KB of ciphertext — decks and notes, not files

export function registerLockerRoutes(app, db, { gate } = {}) {
  const lockers = db.collection('lockers');
  const guard = gate ?? ((_req, _res, next) => next());

  app.get('/api/locker/:id', guard, async (req, res) => {
    const id = String(req.params.id);
    if (!ID.test(id)) return res.status(400).json({ error: 'bad locker id' });
    const doc = await lockers.findOne({ _id: id });
    if (!doc) return res.status(404).json({ error: 'no locker' });
    res.json({ v: doc.v, iv: doc.iv, ct: doc.ct, updatedAt: doc.updatedAt });
  });

  app.put('/api/locker/:id', guard, async (req, res) => {
    const id = String(req.params.id);
    const { v, iv, ct } = req.body ?? {};
    if (!ID.test(id)) return res.status(400).json({ error: 'bad locker id' });
    if (v !== 1) return res.status(400).json({ error: 'unsupported locker version' });
    if (typeof iv !== 'string' || iv.length !== 24 || !HEX.test(iv)) {
      return res.status(400).json({ error: 'iv must be 12 bytes of hex' });
    }
    if (typeof ct !== 'string' || ct.length < 34 || ct.length > MAX_CT_HEX || !HEX.test(ct)) {
      return res.status(400).json({ error: 'ciphertext missing or too large' });
    }
    const updatedAt = new Date();
    await lockers.updateOne({ _id: id }, { $set: { v, iv, ct, updatedAt } }, { upsert: true });
    res.json({ ok: true, updatedAt });
  });
}
