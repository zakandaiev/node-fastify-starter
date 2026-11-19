import { USER_STATUS } from '#enums/user-status.js';
import { dateTimeUtc, email, uuid } from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

export const properties = freezeDeep({
  id: uuid('User id'),
  email: { ...email('Email, in lower case'), type: ['string', 'null'], maxLength: 254 },
  emailVerifiedAt: { ...dateTimeUtc('When the email was confirmed'), type: ['string', 'null'] },
  firstName: { type: ['string', 'null'], maxLength: 100, description: 'First name' },
  lastName: { type: ['string', 'null'], maxLength: 100, description: 'Last name' },
  locale: { type: ['string', 'null'], maxLength: 35, description: 'Language as a BCP 47 tag; null until the user chooses one' },
  timezone: { type: ['string', 'null'], maxLength: 64, description: 'IANA time zone; null until the user chooses one' },
  status: { type: 'string', enum: Object.values(USER_STATUS), description: 'Status' },
  createdAt: dateTimeUtc('Created at'),
  updatedAt: dateTimeUtc('Updated at'),
});
