// Static: the query schemas of lists read it when their modules load, before any config exists.
export const PAGINATION = Object.freeze({
  defaultLimit: 20,
  maxLimit: 100,

  // MariaDB reads and throws away every row an OFFSET skips: a client must not choose how deep that goes.
  maxOffset: 10_000,
});
