export function isDeepFrozen(value) {
  return Object.isFrozen(value)
    && Object.values(value).every((item) => typeof item !== 'object' || item === null || isDeepFrozen(item));
}
