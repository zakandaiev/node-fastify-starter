import { FILTER_TYPE } from '#enums/filter-type.js';
import { SCOPE, SCOPE_CODES } from '#enums/scope.js';
import { UNIQUE_INDEX } from '#enums/unique-index.js';
import {
  dateTimeUtc,
  enumOf,
  nullable,
  text,
  uuid,
} from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

export const properties = freezeDeep({
  id: uuid('Group id'),
  slug: { ...text('Code of the group: words of lower-case Latin letters and digits joined by hyphens', { maxLength: 64 }), pattern: SLUG_PATTERN },
  name: text('Name', { maxLength: 100 }),
  description: nullable(text('Description', { maxLength: 255 })),
  isSuperadmin: { type: 'boolean', description: 'Grants every scope' },
  isSystem: { type: 'boolean', description: 'Made by the system: keeps its slug and its full access, and cannot be deleted' },
  createdAt: dateTimeUtc('Created at'),
  updatedAt: dateTimeUtc('Updated at'),
  scopes: {
    type: 'array',
    items: enumOf(SCOPE_CODES, 'Code of a scope'),
    uniqueItems: true,
    maxItems: SCOPE_CODES.length,
    description: 'Scopes the group grants, codes of the catalog; a group with full access grants every scope whatever it lists',
  },
});

export const filters = freezeDeep({
  name: { type: FILTER_TYPE.TEXT, label: 'Name' },
});

export const sort = freezeDeep([
  {
    value: 'name',
    label: 'Name A-Z',
    orderBy: 'name ASC, id ASC',
    isDefault: true,
  },
  { value: 'newest', label: 'Newest first', orderBy: 'created_at DESC, id DESC' },
]);

// The index of the database -> the field of the API that a duplicate is reported on.
export const unique = freezeDeep({
  [UNIQUE_INDEX.GROUPS_SLUG]: 'slug',
});

export const example = freezeDeep({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2c',
  slug: 'support',
  name: 'Support',
  description: 'Sees the users and the groups',
  isSuperadmin: false,
  isSystem: false,
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
  scopes: [SCOPE.GROUPS_READ, SCOPE.USERS_READ],
});
