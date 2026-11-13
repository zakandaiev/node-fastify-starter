export const LIMIT = 10;

export class Sample {}

export async function load({ id, isActive = true } = {}, ...rest) {
  return [id, isActive, rest];
}

export function* walk(items) {
  yield* items;
}

export async function* stream(source) {
  yield* source;
}

export function format(
  value,
  {
    prefix = '(',
    suffix = ')',
  } = {},
) {
  return `${prefix}${value}${suffix}`;
}
