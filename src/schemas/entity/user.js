import { FILTER_OPERATOR, FILTER_TYPE } from '#enums/filter-type.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  dateTimeUtc,
  email,
  enumOf,
  nullable,
  text,
  uuid,
} from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

export const properties = freezeDeep({
  id: uuid('User id'),
  email: nullable(email('Email, in lower case')),
  emailVerifiedAt: nullable(dateTimeUtc('When the email was confirmed')),
  firstName: nullable(text('First name', { maxLength: 100 })),
  lastName: nullable(text('Last name', { maxLength: 100 })),
  locale: nullable(text('Language as a BCP 47 tag; null until the user chooses one', { maxLength: 35 })),
  timezone: nullable(text('IANA time zone; null until the user chooses one', { maxLength: 64 })),
  status: enumOf(Object.values(USER_STATUS), 'Status'),
  createdAt: dateTimeUtc('Created at'),
  updatedAt: dateTimeUtc('Updated at'),
});

export const filters = freezeDeep({
  firstName: { type: FILTER_TYPE.TEXT, label: 'First name' },
  status: {
    type: FILTER_TYPE.OPTIONS,
    label: 'Status',
    isMultiple: true,
    options: [
      { value: USER_STATUS.ACTIVE, label: 'Active' },
      { value: USER_STATUS.BLOCKED, label: 'Blocked' },
    ],
  },
  createdAt: { type: FILTER_TYPE.DATETIME, label: 'Created', operator: FILTER_OPERATOR.RANGE },
});

export const sort = freezeDeep([
  {
    value: 'newest',
    label: 'Newest first',
    orderBy: 'created_at DESC, id DESC',
    isDefault: true,
  },
  { value: 'name', label: 'Name A-Z', orderBy: 'first_name ASC, id ASC' },
]);

// The index of the database -> the field of the API that a duplicate is reported on.
export const unique = freezeDeep({
  uq_users_email: 'email',
});

export const example = freezeDeep({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  email: 'anna@example.com',
  emailVerifiedAt: '2026-11-19T10:00:00.000Z',
  firstName: 'Anna',
  lastName: 'Kovalenko',
  locale: 'uk',
  timezone: 'Europe/Kyiv',
  status: USER_STATUS.ACTIVE,
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
});
