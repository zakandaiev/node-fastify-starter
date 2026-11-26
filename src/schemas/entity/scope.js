import { SCOPE, SCOPE_CATALOG, SCOPE_CODES } from '#enums/scope.js';
import { enumOf, text } from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

// An entry of the catalog of scopes, which lives in the code: there is no table of scopes.
export const properties = freezeDeep({
  code: enumOf(SCOPE_CODES, 'Code of the scope: the key of its translation; <resource>:* grants every action of its resource'),
  name: text('Name, an English fallback'),
  description: text('What it lets one do, an English fallback'),
});

export const example = freezeDeep({ ...SCOPE_CATALOG.find((entry) => entry.code === SCOPE.GROUPS_READ) });
