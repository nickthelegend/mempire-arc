/** Chain ids are EIP-155 positive integers; do not boot against a malformed env value. */
export function chainIdFromEnv(raw, defaultId = 5042002) {
  if (raw === undefined) return defaultId;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error('CHAIN_ID must be a positive integer');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('CHAIN_ID must be a positive safe integer');
  return id;
}
