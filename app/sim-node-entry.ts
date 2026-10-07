/**
 * The simulation, for a node client.
 *
 * Re-exports the browser's own engine so a second seat can compute a result
 * the first seat will agree with. Nothing is reimplemented here — a
 * reimplementation would be a different simulation wearing the same name, and
 * `settle_from_log` refuses to pay when the two seats disagree.
 */
export { createMatch, stepSim, hashState } from './src/sim/engine';
export { FORMATS } from './src/sim/types';
