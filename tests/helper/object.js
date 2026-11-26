// A list with holes at the indexes items does not name: a literal with holes is refused by the linter.
export function createHoled(length, items = {}) {
  return Object.assign(new Array(length), items);
}

export function isDeepFrozen(value) {
  return Object.isFrozen(value)
    && Object.values(value).every((item) => typeof item !== 'object' || item === null || isDeepFrozen(item));
}
