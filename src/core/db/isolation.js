import { ISOLATION_LEVEL } from '#enums/isolation-level.js';

const ISOLATION_LEVELS = Object.freeze(Object.values(ISOLATION_LEVEL));

// "signature" names the function its caller has called: the level is checked where it is given, before
// a connection is taken, and once more where it is written into a statement.
export function assertIsolation(isolation, signature) {
  if (isolation !== undefined && !ISOLATION_LEVELS.includes(isolation)) {
    throw new TypeError(`${signature} requires one of: ${ISOLATION_LEVELS.join(', ')}`);
  }
}
