import { UUID_REGEXP } from '#utils/id.js';

function describe(schema, description) {
  return description === undefined
    ? schema
    : { ...schema, description };
}

// A pattern, not format "uuid": the format also takes upper case and "urn:uuid:", and MariaDB finds a row by any
// of those spellings, so one object would have several addresses.
export function uuid(description) {
  return describe({ type: 'string', pattern: UUID_REGEXP.source }, description);
}

export function email(description) {
  return describe({ type: 'string', format: 'email' }, description);
}

export function dateTimeUtc(description) {
  return describe({ type: 'string', format: 'date-time' }, description);
}
