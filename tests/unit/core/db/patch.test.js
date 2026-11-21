import { buildPatch } from '#core/db/patch.js';
import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ALLOWED = Object.freeze(['firstName', 'lastName', 'locale']);
const ALLOWED_REFUSAL = /buildPatch\(body, \{ allowed \}\) requires "allowed" to be a non-empty array of distinct field names/;

function isNoChanges(error) {
  return error instanceof AppError && error.code === ERROR_CODE.NO_CHANGES && error.statusCode === 409;
}

describe('buildPatch', () => {
  test('takes the allowed fields the body has, in the order of "allowed", and leaves the others out', () => {
    const patch = buildPatch({ lastName: 'Shevchenko', isAdmin: true, firstName: 'Taras' }, { allowed: ALLOWED });

    assert.deepEqual(patch, { firstName: 'Taras', lastName: 'Shevchenko' });
    assert.deepEqual(Object.keys(patch), ['firstName', 'lastName']);
  });

  test('keeps a field that is null, for SET column = NULL, and drops one that is undefined: its column stays as it is', () => {
    assert.deepEqual(buildPatch({ locale: null, firstName: undefined, lastName: 'Ukrainka' }, { allowed: ALLOWED }), {
      lastName: 'Ukrainka',
      locale: null,
    });
  });

  test('keeps every other value as it is, falsy ones included', () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const patch = buildPatch({
      count: 0,
      isActive: false,
      note: '',
      at,
    }, { allowed: ['count', 'isActive', 'note', 'at'] });

    assert.deepEqual(patch, {
      count: 0,
      isActive: false,
      note: '',
      at,
    });
    assert.equal(patch.at, at);
  });

  test('returns a new object and leaves the body as it was', () => {
    const body = { firstName: 'Lesya', isAdmin: true };
    const patch = buildPatch(body, { allowed: ALLOWED });

    patch.firstName = 'changed';

    assert.notEqual(patch, body);
    assert.deepEqual(body, { firstName: 'Lesya', isAdmin: true });
  });

  test('reads own keys only: an inherited one is not a field of the body', () => {
    const inherited = Object.assign(Object.create(null), { firstName: 'inherited' });
    const body = Object.assign(Object.create(inherited), { lastName: 'own' });

    assert.deepEqual(buildPatch(body, { allowed: ALLOWED }), { lastName: 'own' });
    assert.throws(() => buildPatch(Object.create(inherited), { allowed: ALLOWED }), isNoChanges);
  });

  test('keeps a parsed "__proto__" key out of the prototype of the patch', () => {
    const patch = buildPatch(JSON.parse('{"__proto__": {"isAdmin": true}, "firstName": "Ivan"}'), { allowed: ALLOWED });

    assert.deepEqual(patch, { firstName: 'Ivan' });
    assert.equal(Object.getPrototypeOf(patch), Object.prototype);
    assert.equal(patch.isAdmin, undefined);
  });

  test('throws NO_CHANGES (409) when the body has no allowed field with a value', () => {
    [{}, { isAdmin: true }, { firstName: undefined }].forEach((body) => {
      assert.throws(() => buildPatch(body, { allowed: ALLOWED }), isNoChanges);
    });
  });

  test('requires the body to be a plain object', () => {
    [null, undefined, [], 'firstName=Taras', new Date(), new Map([['firstName', 'Taras']])].forEach((body) => {
      assert.throws(() => buildPatch(body, { allowed: ALLOWED }), /buildPatch\(body, \{ allowed \}\) requires body to be a plain object/);
    });
  });

  test('requires "allowed" to be a non-empty list of distinct field names', () => {
    const body = { firstName: 'Taras' };

    [undefined, [], 'firstName', ['firstName', 'firstName'], ['firstName', ''], ['firstName', 1], [null]].forEach((allowed) => {
      assert.throws(() => buildPatch(body, { allowed }), ALLOWED_REFUSAL);
    });
    assert.throws(() => buildPatch(body), ALLOWED_REFUSAL);
  });
});
