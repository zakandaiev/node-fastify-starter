// Static: the field factories read it when the schema modules load, before any config exists.
export const SCHEMA_LIMITS = Object.freeze({
  // A text field that names no length of its own; a field of a column passes the length of the column.
  textMaxLength: 255,

  // A filter of several values that comes as a list separated by commas, such as ?groupId=<id>,<id>.
  listMaxValues: 20,

  // POST /log/error: the body of a report, and the raw length of each text of it that is cut afterwards.
  reportMaxLength: 64 * 1024,
});
