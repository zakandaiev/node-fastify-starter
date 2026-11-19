import { dateTimeUtc, uuid } from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';

export const properties = freezeDeep({
  id: uuid('Group id'),
  slug: { type: 'string', maxLength: 64, description: 'Code of the group' },
  name: { type: 'string', maxLength: 100, description: 'Name' },
  description: { type: ['string', 'null'], maxLength: 255, description: 'Description' },
  isSuperadmin: { type: 'boolean', description: 'Grants every scope' },
  isSystem: { type: 'boolean', description: 'Made by the system: cannot be deleted' },
  createdAt: dateTimeUtc('Created at'),
  updatedAt: dateTimeUtc('Updated at'),
});
