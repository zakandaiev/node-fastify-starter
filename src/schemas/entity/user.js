import { FILTER_OPERATOR, FILTER_TYPE } from '#enums/filter-type.js';
import { UNIQUE_INDEX } from '#enums/unique-index.js';
import { USER_STATUS } from '#enums/user-status.js';
import {
  dateTimeUtc,
  email,
  enumOf,
  nullable,
  personName,
  text,
  url,
  uuid,
} from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';
import { PERSON_NAME_MAX_LENGTH } from '#utils/person.js';

const NAME_RULE = `one word of letters of any script, a hyphen or an apostrophe inside it, up to ${PERSON_NAME_MAX_LENGTH} characters`;

export const properties = freezeDeep({
  id: uuid('User id'),
  email: nullable(email('Email, in lower case')),
  emailVerifiedAt: nullable(dateTimeUtc('When the email was confirmed')),
  firstName: nullable(personName(`First name: ${NAME_RULE}`, { maxLength: 100 })),
  lastName: nullable(personName(`Last name: ${NAME_RULE}`, { maxLength: 100 })),
  locale: nullable(text('Language as a BCP 47 tag; null until the user chooses one', { maxLength: 35 })),
  timezone: nullable(text('IANA time zone; null until the user chooses one', { maxLength: 64 })),
  avatarUrl: nullable(url('Address of the avatar, which never changes its content: a new avatar comes at a new address; null without one')),
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
  [UNIQUE_INDEX.USERS_EMAIL]: 'email',
});

export const example = freezeDeep({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b',
  email: 'anna@example.com',
  emailVerifiedAt: '2026-11-19T10:00:00.000Z',
  firstName: 'Anna',
  lastName: 'Kovalenko',
  locale: 'uk',
  timezone: 'Europe/Kyiv',
  avatarUrl: 'https://api.example.com/upload/019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d.webp',
  status: USER_STATUS.ACTIVE,
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:00:00.000Z',
});
