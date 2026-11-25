import { SCHEMA_LIMITS } from '#config/schema.js';
import {
  dateTimeUtc,
  nullable,
  text,
  uuid,
} from '#schemas/common/field.js';
import { freezeDeep } from '#utils/object.js';
import { IP_MAX_LENGTH } from '#utils/validate.js';

// What the API says of a session: the hash of its refresh token is no field of it.
export const properties = freezeDeep({
  id: uuid('Session id'),
  userAgent: nullable(text('User agent of the sign-in or of the last refresh', { maxLength: SCHEMA_LIMITS.userAgentMaxLength })),
  ip: nullable(text('Address of the sign-in or of the last refresh', { maxLength: IP_MAX_LENGTH })),
  isDev: { type: 'boolean', description: 'Made by the sign-in of dev mode' },
  startedAt: dateTimeUtc('When the user signed in'),
  rotatedAt: dateTimeUtc('Last activity: the sign-in or the last refresh'),
  expiresAt: dateTimeUtc('When it ends unless it is refreshed'),
  isCurrent: { type: 'boolean', description: 'The session this request was made in' },
});

export const example = freezeDeep({
  id: '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
  ip: '203.0.113.7',
  isDev: false,
  startedAt: '2026-11-19T10:00:00.000Z',
  rotatedAt: '2026-11-25T08:30:00.000Z',
  expiresAt: '2026-12-25T08:30:00.000Z',
  isCurrent: true,
});
