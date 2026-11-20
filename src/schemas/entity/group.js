import { FILTER_TYPE } from '#enums/filter-type.js';
import {
  dateTimeUtc,
  nullable,
  text,
  uuid,
} from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

export const properties = freezeDeep({
  id: uuid('Group id'),
  slug: text('Code of the group', { maxLength: 64 }),
  name: text('Name', { maxLength: 100 }),
  description: nullable(text('Description', { maxLength: 255 })),
  isSuperadmin: { type: 'boolean', description: 'Grants every scope' },
  isSystem: { type: 'boolean', description: 'Made by the system: cannot be deleted' },
  createdAt: dateTimeUtc('Created at'),
  updatedAt: dateTimeUtc('Updated at'),
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
  uq_groups_slug: 'slug',
});

export const example = freezeDeep({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2c',
  slug: 'admin',
  name: 'Administrators',
  description: 'Full access to everything',
  isSuperadmin: true,
  isSystem: true,
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
});
