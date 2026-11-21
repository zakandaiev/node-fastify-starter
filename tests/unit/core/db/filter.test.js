import { bindSql } from '#core/db/binding.js';
import {
  assertFilterDefinition,
  buildFilter,
  FILTER_LIST_SEPARATOR,
  readFilterColumns,
  readFilterOptions,
  readFilterParameters,
  readFilterPlaceholders,
} from '#core/db/filter.js';
import { createSchema } from '#core/schema/create-schema.js';
import { FILTER_OPERATOR, FILTER_TYPE } from '#enums/filter-type.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { USER_STATUS } from '#enums/user-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import {
  dateTimeUtc,
  enumOf,
  isoDate,
  nullable,
  text,
  uuid,
} from '#schemas/common/field.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import { toDate } from '#utils/date.js';
import { freezeDeep } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SIGNATURE = 'test(filter)';
const PUBLIC = Object.freeze({ auth: false });

const OWNER_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b';
const OTHER_ID = '019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2d';

const DATETIME_MIN = '1000-01-01T00:00:00.000Z';
const DATETIME_MAX = '9999-12-31T23:59:59.999Z';

// Every type of filter, each on a field of its own; the owners come from the database.
const ITEM_SCHEMA = freezeDeep({
  properties: {
    title: nullable(text('Title', { maxLength: 50 })),
    code: text('Code', { maxLength: 16 }),
    isPublic: { type: 'boolean', description: 'Shown to everyone' },
    rating: {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      description: 'Rating',
    },
    price: { type: 'number', minimum: 0, description: 'Price' },
    releasedOn: isoDate('Released on'),
    shownOn: isoDate('Shown on'),
    seenAt: dateTimeUtc('Seen at'),
    editedAt: dateTimeUtc('Edited at'),
    kind: nullable(enumOf(['book', 'film'], 'Kind')),
    level: { type: ['integer', 'null'], enum: [1, 2, 3, null], description: 'Level' },
    tag: text('Tag', { maxLength: 20 }),
    ownerId: uuid('Owner'),
  },
  filters: {
    title: { type: FILTER_TYPE.TEXT },
    code: { type: FILTER_TYPE.TEXT, isExact: true },
    isPublic: { type: FILTER_TYPE.BOOLEAN },
    rating: { type: FILTER_TYPE.NUMBER },
    price: { type: FILTER_TYPE.NUMBER, operator: FILTER_OPERATOR.RANGE },
    releasedOn: { type: FILTER_TYPE.DATE },
    shownOn: { type: FILTER_TYPE.DATE, operator: FILTER_OPERATOR.RANGE },
    seenAt: { type: FILTER_TYPE.DATETIME },
    editedAt: { type: FILTER_TYPE.DATETIME, operator: FILTER_OPERATOR.RANGE },
    kind: { type: FILTER_TYPE.OPTIONS },
    level: { type: FILTER_TYPE.OPTIONS, isMultiple: true },
    tag: {
      type: FILTER_TYPE.OPTIONS,
      isMultiple: true,
      options: [
        { value: 'new', label: 'New' },
        { value: 'sale', label: 'Sale' },
        { value: 'old', label: 'Old', isDisabled: true },
      ],
    },
    ownerId: { type: FILTER_TYPE.OPTIONS, column: 'i.owner_id' },
  },
});

const ITEM_PARAMETERS = Object.freeze([
  'title',
  'code',
  'isPublic',
  'rating',
  'priceFrom',
  'priceTo',
  'releasedOn',
  'shownOnFrom',
  'shownOnTo',
  'seenAt',
  'editedAtFrom',
  'editedAtTo',
  'kind',
  'level',
  'tag',
  'ownerId',
]);

const OWNERS = freezeDeep([{ value: OWNER_ID, label: 'Anna' }, { value: OTHER_ID, label: 'Olha' }]);

// A value for every parameter, of the type the query schema of the route gives it.
const EVERY_VALUE = Object.freeze({
  title: 'Dune',
  code: 'A-1',
  isPublic: false,
  rating: 7,
  priceFrom: 9.5,
  priceTo: 20,
  releasedOn: '2026-11-20',
  shownOnFrom: '2026-11-01',
  shownOnTo: '2026-11-30',
  seenAt: '2026-11-20T10:00:00Z',
  editedAtFrom: '2026-11-01T00:00:00Z',
  editedAtTo: '2026-11-20T10:00:00.000+00:00',
  kind: 'film',
  level: '3,1',
  tag: 'sale,new',
  ownerId: OWNER_ID,
});

const EVERY_EFFECT = Object.freeze([
  'Dune',
  'A-1',
  false,
  7,
  [9.5, 20],
  '2026-11-20',
  ['2026-11-01', '2026-11-30'],
  '2026-11-20T10:00:00Z',
  ['2026-11-01T00:00:00Z', '2026-11-20T10:00:00.000+00:00'],
  'film',
  [1, 3],
  ['new', 'sale'],
  OWNER_ID,
]);

const STATUS_OPTIONS = freezeDeep([{ value: USER_STATUS.ACTIVE, label: 'Active' }, { value: USER_STATUS.BLOCKED, label: 'Blocked' }]);

function filterItems(payload, { options = {}, disabled = [] } = {}) {
  return buildFilter(ITEM_SCHEMA, payload, { options: { ownerId: OWNERS, ...options }, disabled });
}

function readQuery({ condition, binding }) {
  return { condition, binding };
}

function readEntry(result, name) {
  return result.filters.find((entry) => entry.name === name);
}

function readValues(result) {
  return result.filters.map((entry) => entry.value);
}

function assertRefused(run, message, name) {
  assert.throws(run, { name: 'TypeError', message }, name);
}

describe('buildFilter: conditions', () => {
  test('takes no condition and an empty binding from an empty payload, and lists every filter unused', () => {
    const result = filterItems({});

    assert.equal(result.condition, null);
    assert.deepEqual(result.binding, {});
    assert.equal(result.hasText, false);
    assert.deepEqual(result.filters.map((entry) => [entry.name, entry.value]), Object.keys(ITEM_SCHEMA.filters).map((key) => [key, null]));
    assert.deepEqual(readQuery(filterItems()), { condition: null, binding: {} });
  });

  test('searches a text filter by a fragment with LIKE, and an exact one with =', () => {
    assert.deepEqual(readQuery(filterItems({ title: 'Dune' })), { condition: 'title LIKE :filter_title', binding: { filter_title: '%Dune%' } });
    assert.deepEqual(readQuery(filterItems({ code: 'A-1' })), { condition: 'code = :filter_code', binding: { filter_code: 'A-1' } });
  });

  test('escapes the backslash, the percent sign and the underscore of a fragment, and reports the value as it was given', () => {
    const fragment = '50%_off\\';
    const result = filterItems({ title: fragment, code: fragment });

    assert.deepEqual(result.binding, { filter_title: '%50\\%\\_off\\\\%', filter_code: fragment });
    assert.deepEqual(readValues(result).slice(0, 2), [fragment, fragment]);
  });

  test('compares a boolean and a number with =, false and 0 among them, and binds them as they are', () => {
    assert.deepEqual(readQuery(filterItems({ isPublic: false, rating: 0 })), {
      condition: 'is_public = :filter_isPublic AND rating = :filter_rating',
      binding: { filter_isPublic: false, filter_rating: 0 },
    });
  });

  test('bounds a number range by >= and <=, each half optional, and reads only the halves', () => {
    assert.deepEqual(readQuery(filterItems({ priceFrom: 9.5, priceTo: 20 })), {
      condition: 'price >= :filter_priceFrom AND price <= :filter_priceTo',
      binding: { filter_priceFrom: 9.5, filter_priceTo: 20 },
    });
    assert.deepEqual(readQuery(filterItems({ priceFrom: 9.5 })), { condition: 'price >= :filter_priceFrom', binding: { filter_priceFrom: 9.5 } });
    assert.deepEqual(readQuery(filterItems({ priceTo: 0 })), { condition: 'price <= :filter_priceTo', binding: { filter_priceTo: 0 } });
    assert.deepEqual(readQuery(filterItems({ price: 10 })), { condition: null, binding: {} });
  });

  test('gives a day a half-open range: from its midnight up to the next one', () => {
    assert.deepEqual(readQuery(filterItems({ releasedOn: '2026-02-28' })), {
      condition: 'released_on >= :filter_releasedOnFrom AND released_on < :filter_releasedOnTo',
      binding: {
        filter_releasedOnFrom: toDate('2026-02-28T00:00:00.000Z'),
        filter_releasedOnTo: toDate('2026-03-01T00:00:00.000Z'),
      },
    });
    assert.deepEqual(filterItems({ releasedOn: '2028-02-28' }).binding.filter_releasedOnTo, toDate('2028-02-29T00:00:00.000Z'));
  });

  test('bounds a range of days by the midnight of the first and the midnight after the last, each half optional', () => {
    assert.deepEqual(readQuery(filterItems({ shownOnFrom: '2026-11-01', shownOnTo: '2026-11-30' })), {
      condition: 'shown_on >= :filter_shownOnFrom AND shown_on < :filter_shownOnTo',
      binding: {
        filter_shownOnFrom: toDate('2026-11-01T00:00:00.000Z'),
        filter_shownOnTo: toDate('2026-12-01T00:00:00.000Z'),
      },
    });
    assert.deepEqual(readQuery(filterItems({ shownOnTo: '2026-12-31' })), {
      condition: 'shown_on < :filter_shownOnTo',
      binding: { filter_shownOnTo: toDate('2027-01-01T00:00:00.000Z') },
    });
    assert.deepEqual(readQuery(filterItems({ shownOnFrom: '2026-11-30', shownOnTo: '2026-11-30' })).binding, {
      filter_shownOnFrom: toDate('2026-11-30T00:00:00.000Z'),
      filter_shownOnTo: toDate('2026-12-01T00:00:00.000Z'),
    });
  });

  test('compares a moment with =, and bounds a range of moments inclusive at both ends, each as a Date', () => {
    assert.deepEqual(readQuery(filterItems({ seenAt: '2026-11-20T10:00:00.5+00:00' })), {
      condition: 'seen_at = :filter_seenAt',
      binding: { filter_seenAt: toDate('2026-11-20T10:00:00.500Z') },
    });
    assert.deepEqual(readQuery(filterItems({ editedAtFrom: '2026-11-01T00:00:00Z', editedAtTo: '2026-11-20T23:59:59.999Z' })), {
      condition: 'edited_at >= :filter_editedAtFrom AND edited_at <= :filter_editedAtTo',
      binding: {
        filter_editedAtFrom: toDate('2026-11-01T00:00:00.000Z'),
        filter_editedAtTo: toDate('2026-11-20T23:59:59.999Z'),
      },
    });
  });

  test('names the column by the key in snake case, or takes the column of the filter as it is', () => {
    const schema = {
      filters: {
        createdAt: { type: FILTER_TYPE.DATETIME },
        ownerName: { type: FILTER_TYPE.TEXT, column: "CONCAT(u.first_name, ' ', u.last_name)" },
        userStatus: { type: FILTER_TYPE.OPTIONS, column: 'u.status', options: STATUS_OPTIONS },
      },
    };
    const result = buildFilter(schema, { createdAt: '2026-11-20T10:00:00Z', ownerName: 'Anna K', userStatus: 'active' });

    assert.equal(
      result.condition,
      "created_at = :filter_createdAt AND CONCAT(u.first_name, ' ', u.last_name) LIKE :filter_ownerName AND u.status = :filter_userStatus",
    );
    assert.equal(filterItems({ ownerId: OWNER_ID }).condition, 'i.owner_id = :filter_ownerId');
  });

  test('joins the conditions with AND in the order of the filters of the schema, not of the payload', () => {
    const result = filterItems({ rating: 5, title: 'Dune', isPublic: true });

    assert.equal(result.condition, 'title LIKE :filter_title AND is_public = :filter_isPublic AND rating = :filter_rating');
  });

  test('gives a condition and a binding that bind together: every placeholder has a value, and a list goes as IN (:p)', () => {
    const result = filterItems(EVERY_VALUE);
    const { sql, values } = bindSql(`SELECT i.id FROM items i WHERE ${result.condition}`, result.binding);

    assert.match(sql, /level IN \(\?, \?\) AND tag IN \(\?, \?\)/);
    assert.equal(sql.split('?').length - 1, values.length);
    assert.deepEqual(values, [
      '%Dune%',
      'A-1',
      false,
      7,
      9.5,
      20,
      toDate('2026-11-20T00:00:00.000Z'),
      toDate('2026-11-21T00:00:00.000Z'),
      toDate('2026-11-01T00:00:00.000Z'),
      toDate('2026-12-01T00:00:00.000Z'),
      toDate('2026-11-20T10:00:00.000Z'),
      toDate('2026-11-01T00:00:00.000Z'),
      toDate('2026-11-20T10:00:00.000Z'),
      'film',
      1,
      3,
      'new',
      'sale',
      OWNER_ID,
    ]);
    assert.deepEqual(readValues(result), EVERY_EFFECT);
  });
});

describe('buildFilter: options', () => {
  test('reads the options of a filter without a list from the enum of its field, without null, and binds the typed value', () => {
    assert.deepEqual(readQuery(filterItems({ kind: 'film' })), { condition: 'kind = :filter_kind', binding: { filter_kind: 'film' } });
    assert.deepEqual(readQuery(filterItems({ level: '2' })), { condition: 'level = :filter_level', binding: { filter_level: 2 } });
    assert.deepEqual(readEntry(filterItems({}), 'level').options, [
      {
        label: '1',
        value: 1,
        isChecked: false,
        isDisabled: false,
      },
      {
        label: '2',
        value: 2,
        isChecked: false,
        isDisabled: false,
      },
      {
        label: '3',
        value: 3,
        isChecked: false,
        isDisabled: false,
      },
    ]);
  });

  test('matches a value by its text and binds the typed value of its option, a number, a boolean or a string', () => {
    const schema = {
      filters: {
        item: {
          type: FILTER_TYPE.OPTIONS,
          options: [{ value: 1, label: 'One' }, { value: true, label: 'Yes' }, { value: 'a,b' }],
        },
      },
    };

    [['1', 1], [1, 1], ['true', true], [true, true], ['a,b', 'a,b']].forEach(([given, bound]) => {
      assert.deepEqual(buildFilter(schema, { item: given }).binding, { filter_item: bound }, String(given));
    });
    ['1.0', '01', 'TRUE', 'a', 'b'].forEach((given) => {
      assert.equal(buildFilter(schema, { item: given }).condition, null, given);
    });
    assert.deepEqual(readEntry(buildFilter(schema, {}), 'item').options.map((option) => option.label), ['One', 'Yes', 'a,b']);
  });

  test('takes several values as a list separated by commas or as an array: IN in the order of the options, = when one is left', () => {
    assert.equal(FILTER_LIST_SEPARATOR, ',');
    assert.deepEqual(readQuery(filterItems({ level: '3,1' })), { condition: 'level IN (:filter_level)', binding: { filter_level: [1, 3] } });
    assert.deepEqual(readQuery(filterItems({ level: [3, '1', 2] })), { condition: 'level IN (:filter_level)', binding: { filter_level: [1, 2, 3] } });
    assert.deepEqual(readQuery(filterItems({ level: '9,3' })), { condition: 'level = :filter_level', binding: { filter_level: 3 } });
    assert.deepEqual(readEntry(filterItems({ level: '9,3' }), 'level').value, [3]);
  });

  test('drops repeats and values outside the list silently: a saved link must not break', () => {
    assert.deepEqual(readQuery(filterItems({ level: '1,1,7,1' })), { condition: 'level = :filter_level', binding: { filter_level: 1 } });
    assert.deepEqual(readQuery(filterItems({ tag: ['sale', 'sale', 'new', 'gone'] })), {
      condition: 'tag IN (:filter_tag)',
      binding: { filter_tag: ['new', 'sale'] },
    });

    const result = filterItems({ kind: 'music', level: '7,,8', tag: 'gone' });

    assert.deepEqual(readQuery(result), { condition: null, binding: {} });
    ['kind', 'level', 'tag'].forEach((name) => {
      const entry = readEntry(result, name);

      assert.equal(entry.value, null, name);
      assert.ok(entry.options.every((option) => !option.isChecked), name);
    });
  });

  test('replaces the list of the schema or of the enum with the list given at runtime', () => {
    const kinds = [{ value: 'music', label: 'Music' }, { value: 'book', label: 'Book' }];
    const tags = [{ value: 'sale', label: 'On sale' }];
    const result = filterItems({ kind: 'music', tag: 'sale,new' }, { options: { kind: kinds, tag: tags } });

    assert.deepEqual(readQuery(result), {
      condition: 'kind = :filter_kind AND tag = :filter_tag',
      binding: { filter_kind: 'music', filter_tag: 'sale' },
    });
    assert.deepEqual(readEntry(result, 'kind').options.map((option) => [option.value, option.label, option.isChecked]), [['music', 'Music', true], ['book', 'Book', false]]);
    assert.deepEqual(readEntry(result, 'tag').options, [{
      label: 'On sale',
      value: 'sale',
      isChecked: true,
      isDisabled: false,
    }]);
    assert.equal(filterItems({ kind: 'film' }, { options: { kind: kinds } }).condition, null);
  });

  test('drops the value of a disabled option, of the schema or of the runtime list, and reports the option with isDisabled: true', () => {
    const result = filterItems({ tag: 'old,new' });

    assert.deepEqual(readQuery(result), { condition: 'tag = :filter_tag', binding: { filter_tag: 'new' } });
    assert.deepEqual(readEntry(result, 'tag'), {
      type: FILTER_TYPE.OPTIONS,
      name: 'tag',
      label: 'Tag',
      isMultiple: true,
      isDisabled: false,
      value: ['new'],
      options: [
        {
          label: 'New',
          value: 'new',
          isChecked: true,
          isDisabled: false,
        },
        {
          label: 'Sale',
          value: 'sale',
          isChecked: false,
          isDisabled: false,
        },
        {
          label: 'Old',
          value: 'old',
          isChecked: false,
          isDisabled: true,
        },
      ],
    });

    const owners = [{ value: OWNER_ID, label: 'Anna' }, { value: OTHER_ID, label: 'Olha', isDisabled: true }];
    const runtime = filterItems({ ownerId: OTHER_ID }, { options: { ownerId: owners } });

    assert.deepEqual(readQuery(runtime), { condition: null, binding: {} });
    assert.deepEqual(readEntry(runtime, 'ownerId').options.map((option) => option.isDisabled), [false, true]);
  });

  test('takes an empty list at runtime, a table without rows: every value is dropped and the filter lists no options', () => {
    const result = filterItems({ ownerId: OWNER_ID }, { options: { ownerId: [] } });

    assert.equal(result.condition, null);
    assert.deepEqual(readEntry(result, 'ownerId'), {
      type: FILTER_TYPE.OPTIONS,
      name: 'ownerId',
      label: 'Owner',
      isMultiple: false,
      isDisabled: false,
      value: null,
      options: [],
    });
  });

  test('requires the list of an options filter that has none in the schema, also while its value is unused', () => {
    assertRefused(() => buildFilter(ITEM_SCHEMA, {}), /: the options filter "ownerId" has no list in the schema: give it the list from the database in \{ options \}/);
  });

  test('refuses options at runtime for a key that is not an options filter of the schema', () => {
    ['title', 'nothing'].forEach((key) => {
      assertRefused(() => filterItems({}, { options: { [key]: [{ value: 'a' }] } }), new RegExp(`: options are given for "${key}", which is not an options filter of the schema`), key);
    });
    [null, [], 'ownerId'].forEach((options, index) => {
      assertRefused(() => buildFilter(ITEM_SCHEMA, {}, { options }), /requires options to map the keys of options filters to their lists/, String(index));
    });
  });

  test('refuses a runtime list of a wrong shape and one that repeats a value, also as text', () => {
    const invalid = [null, 'a', {}, [null], [{ label: 'Anna' }], [{ value: null }], [{ value: {} }], [{ value: 'a', label: null }], [{ value: 'a', isDisabled: 'no' }]];

    invalid.forEach((list, index) => {
      assertRefused(() => filterItems({}, { options: { ownerId: list } }), /: the options of the filter "ownerId" must be a list of \{ value, label \}/, String(index));
    });
    assertRefused(() => filterItems({}, { options: { ownerId: [{ value: 1 }, { value: '1' }] } }), /: the options of the filter "ownerId" must be distinct values, also as text/);
  });
});

describe('buildFilter: disabled filters', () => {
  test('drops the value of a filter disabled in the schema, and reports it with isDisabled: true and no value', () => {
    const schema = freezeDeep({
      filters: {
        status: {
          type: FILTER_TYPE.OPTIONS,
          label: 'Status',
          isDisabled: true,
          options: STATUS_OPTIONS,
        },
        title: { type: FILTER_TYPE.TEXT, label: 'Title' },
      },
    });
    const result = buildFilter(schema, { status: USER_STATUS.ACTIVE, title: 'Dune' });

    assert.deepEqual(readQuery(result), { condition: 'title LIKE :filter_title', binding: { filter_title: '%Dune%' } });
    assert.deepEqual(readEntry(result, 'status'), {
      type: FILTER_TYPE.OPTIONS,
      name: 'status',
      label: 'Status',
      isMultiple: false,
      isDisabled: true,
      value: null,
      options: [
        {
          label: 'Active',
          value: 'active',
          isChecked: false,
          isDisabled: false,
        },
        {
          label: 'Blocked',
          value: 'blocked',
          isChecked: false,
          isDisabled: false,
        },
      ],
    });
  });

  test('drops the value of a filter disabled at runtime the same way, whatever its type', () => {
    const disabled = ['title', 'price', 'releasedOn', 'kind', 'ownerId'];
    const result = filterItems(EVERY_VALUE, { disabled });

    assert.equal(
      result.condition,
      [
        'code = :filter_code',
        'is_public = :filter_isPublic',
        'rating = :filter_rating',
        'shown_on >= :filter_shownOnFrom',
        'shown_on < :filter_shownOnTo',
        'seen_at = :filter_seenAt',
        'edited_at >= :filter_editedAtFrom',
        'edited_at <= :filter_editedAtTo',
        'level IN (:filter_level)',
        'tag IN (:filter_tag)',
      ].join(' AND '),
    );
    disabled.forEach((name) => {
      assert.deepEqual([readEntry(result, name).isDisabled, readEntry(result, name).value], [true, null], name);
    });
    assert.ok(Object.keys(result.binding).every((key) => !disabled.some((name) => key.startsWith(`filter_${name}`))));
  });

  test('still checks the type of a value of a disabled filter: a wrong type is a bug of the route', () => {
    assert.throws(() => filterItems({ rating: '5' }, { disabled: ['rating'] }), TypeError);
  });

  test('refuses disabled that is not a list of the keys of the filters of the schema', () => {
    ['title', [1], [null], {}, null].forEach((disabled, index) => {
      assertRefused(() => filterItems({}, { disabled }), /requires disabled to be a list of the keys of filters/, String(index));
    });
    assertRefused(() => filterItems({}, { disabled: ['title', 'titleFrom'] }), /: disabled names "titleFrom", which is not a filter of the schema/);
  });
});

describe('buildFilter: unused and wrong values', () => {
  test('takes undefined, null and an empty string for a filter left unused, whatever its type', () => {
    [undefined, null, ''].forEach((value) => {
      const payload = Object.fromEntries(ITEM_PARAMETERS.map((name) => [name, value]));
      const result = filterItems(payload);

      assert.deepEqual(readQuery(result), { condition: null, binding: {} }, String(value));
      assert.ok(result.filters.every((entry) => entry.value === null), String(value));
    });
  });

  test('takes a range with one half unused for the other half alone', () => {
    assert.deepEqual(readEntry(filterItems({ priceFrom: '', priceTo: 5 }), 'price').value, [null, 5]);
    assert.deepEqual(readEntry(filterItems({ shownOnFrom: '2026-11-01', shownOnTo: null }), 'shownOn').value, ['2026-11-01', null]);
  });

  test('refuses a value of a wrong type, naming the parameter, the filter and .query() of the route', () => {
    const cases = [
      ['title', 5, '"title" of the filter "title" must be a string'],
      ['code', ['A-1'], '"code" of the filter "code" must be a string'],
      ['isPublic', 'true', '"isPublic" of the filter "isPublic" must be a boolean'],
      ['rating', '5', '"rating" of the filter "rating" must be a finite number'],
      ['rating', Infinity, '"rating" of the filter "rating" must be a finite number'],
      ['rating', Number.NaN, '"rating" of the filter "rating" must be a finite number'],
      ['priceTo', '10', '"priceTo" of the filter "price" must be a finite number'],
      ['releasedOn', '2026-11-20T10:00:00Z', '"releasedOn" of the filter "releasedOn" must be a date written as YYYY-MM-DD'],
      ['releasedOn', '2026-02-30', '"releasedOn" of the filter "releasedOn" must be a date written as YYYY-MM-DD'],
      ['releasedOn', toDate('2026-11-20T00:00:00.000Z'), '"releasedOn" of the filter "releasedOn" must be a date written as YYYY-MM-DD'],
      ['shownOnFrom', '20261120', '"shownOnFrom" of the filter "shownOn" must be a date written as YYYY-MM-DD'],
      ['seenAt', '2026-11-20T10:00:00', '"seenAt" of the filter "seenAt" must be a date-time in UTC written in ISO 8601'],
      ['seenAt', '2026-11-20T12:00:00+02:00', '"seenAt" of the filter "seenAt" must be a date-time in UTC written in ISO 8601'],
      ['editedAtTo', '2026-11-20', '"editedAtTo" of the filter "editedAt" must be a date-time in UTC written in ISO 8601'],
      ['kind', ['book'], '"kind" of the filter "kind" must be a string, a number or a boolean'],
      ['kind', {}, '"kind" of the filter "kind" must be a string, a number or a boolean'],
      ['level', 3, '"level" of the filter "level" must be a list separated by commas or an array of strings, numbers and booleans'],
      ['level', [['1']], '"level" of the filter "level" must be a list separated by commas or an array'],
      ['level', [1, null], '"level" of the filter "level" must be a list separated by commas or an array'],
    ];

    cases.forEach(([name, value, reason]) => {
      assertRefused(
        () => filterItems({ [name]: value }),
        new RegExp(`^buildFilter\\(schema, payload, \\{ options, disabled \\}\\): ${reason}.*: name the filter in \\.query\\(\\) of the route, whose schema gives it that type$`),
        `${name}: ${String(value)}`,
      );
    });
  });
});

describe('buildFilter: the years of a DATETIME', () => {
  test('moves a lower bound before the year 1000 to the first moment a DATETIME holds', () => {
    assert.deepEqual(readQuery(filterItems({ editedAtFrom: '0999-12-31T23:59:59.999Z' })), {
      condition: 'edited_at >= :filter_editedAtFrom',
      binding: { filter_editedAtFrom: toDate(DATETIME_MIN) },
    });
    assert.deepEqual(readQuery(filterItems({ shownOnFrom: '0001-01-01' })), {
      condition: 'shown_on >= :filter_shownOnFrom',
      binding: { filter_shownOnFrom: toDate(DATETIME_MIN) },
    });
  });

  test('ends the day 9999-12-31 at its last moment, inclusive: the next midnight is past what a DATETIME holds', () => {
    assert.deepEqual(readQuery(filterItems({ releasedOn: '9999-12-31' })), {
      condition: 'released_on >= :filter_releasedOnFrom AND released_on <= :filter_releasedOnTo',
      binding: {
        filter_releasedOnFrom: toDate('9999-12-31T00:00:00.000Z'),
        filter_releasedOnTo: toDate(DATETIME_MAX),
      },
    });
    assert.deepEqual(readQuery(filterItems({ shownOnTo: '9999-12-31' })), {
      condition: 'shown_on <= :filter_shownOnTo',
      binding: { filter_shownOnTo: toDate(DATETIME_MAX) },
    });
    assert.deepEqual(filterItems({ shownOnTo: '9999-12-30' }).binding, { filter_shownOnTo: toDate('9999-12-31T00:00:00.000Z') });
  });

  test('turns an upper bound before the year 1000 into FALSE without a binding: nothing stored can match', () => {
    assert.deepEqual(readQuery(filterItems({ editedAtTo: '0999-12-31T23:59:59.999Z' })), { condition: 'FALSE', binding: {} });
    assert.deepEqual(readQuery(filterItems({ editedAtFrom: '0500-01-01T00:00:00Z', editedAtTo: '0998-01-01T00:00:00Z' })), { condition: 'FALSE', binding: {} });
    assert.deepEqual(readQuery(filterItems({ releasedOn: '0998-05-05' })), { condition: 'FALSE', binding: {} });
    assert.deepEqual(readQuery(filterItems({ title: 'Dune', shownOnTo: '0998-05-05', rating: 1 })), {
      condition: 'title LIKE :filter_title AND rating = :filter_rating AND FALSE',
      binding: { filter_title: '%Dune%', filter_rating: 1 },
    });
  });

  test('turns a moment outside the years into FALSE, and binds the first and the last moment as they are', () => {
    assert.deepEqual(readQuery(filterItems({ seenAt: '0999-12-31T23:59:59.999Z' })), { condition: 'FALSE', binding: {} });
    assert.deepEqual(filterItems({ seenAt: DATETIME_MIN }).binding, { filter_seenAt: toDate(DATETIME_MIN) });
    assert.deepEqual(filterItems({ seenAt: DATETIME_MAX }).binding, { filter_seenAt: toDate(DATETIME_MAX) });
    assert.deepEqual(readQuery(filterItems({ editedAtFrom: DATETIME_MIN, editedAtTo: DATETIME_MAX })), {
      condition: 'edited_at >= :filter_editedAtFrom AND edited_at <= :filter_editedAtTo',
      binding: { filter_editedAtFrom: toDate(DATETIME_MIN), filter_editedAtTo: toDate(DATETIME_MAX) },
    });
  });

  test('binds only Dates the binder takes, and reports every bound as it was given', () => {
    const payload = {
      releasedOn: '9999-12-31',
      shownOnFrom: '0001-01-01',
      editedAtFrom: '0001-01-01T00:00:00Z',
      editedAtTo: '9999-12-31T23:59:59.999999+00:00',
    };
    const result = filterItems(payload);

    assert.doesNotThrow(() => bindSql(`SELECT 1 FROM t WHERE ${result.condition}`, result.binding));
    assert.deepEqual(readValues(result).filter((value) => value !== null), [
      '9999-12-31',
      ['0001-01-01', null],
      ['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999+00:00'],
    ]);
  });
});

describe('buildFilter: filters[]', () => {
  test('gives the value that took effect: a range as [from, to] with null for a missing half, an option as its typed value', () => {
    const result = filterItems({
      isPublic: false,
      priceTo: 5,
      shownOnFrom: '2026-01-01',
      kind: 'book',
      level: '2,1',
    });

    assert.deepEqual(readValues(result), [null, null, false, null, [null, 5], null, ['2026-01-01', null], null, null, 'book', [1, 2], null, null]);
  });

  test('gives a range the operator, and an options filter isMultiple and its options; no other filter has them', () => {
    filterItems(EVERY_VALUE).filters.forEach((entry) => {
      const keys = ['type', 'name', 'label', 'isDisabled', 'value'];
      const filter = ITEM_SCHEMA.filters[entry.name];
      const expected = [
        ...keys,
        ...(filter.operator === FILTER_OPERATOR.RANGE ? ['operator'] : []),
        ...(filter.type === FILTER_TYPE.OPTIONS ? ['isMultiple', 'options'] : []),
      ];

      assert.deepEqual(Object.keys(entry).sort(), expected.sort(), entry.name);
    });
    assert.equal(readEntry(filterItems({}), 'price').operator, FILTER_OPERATOR.RANGE);
    assert.equal(readEntry(filterItems({}), 'kind').isMultiple, false);
  });

  test('labels a filter by its label, then by the description of its field, then by its key', () => {
    const schema = {
      properties: { a: text('Field A'), b: text('Field B') },
      filters: {
        a: { type: FILTER_TYPE.TEXT, label: 'Label A' },
        b: { type: FILTER_TYPE.TEXT },
        c: { type: FILTER_TYPE.TEXT },
      },
    };

    assert.deepEqual(buildFilter(schema, {}).filters.map((entry) => entry.label), ['Label A', 'Field B', 'c']);
    assert.deepEqual(readEntry(filterItems({}), 'isPublic').label, 'Shown to everyone');
  });

  test('reads own keys only, of the payload and of the properties: "constructor" is a filter like any other', () => {
    const schema = { properties: {}, filters: { constructor: { type: FILTER_TYPE.TEXT, column: 'ctor' } } };

    assert.deepEqual(buildFilter(schema, {}).filters, [{
      type: FILTER_TYPE.TEXT,
      name: 'constructor',
      label: 'constructor',
      isDisabled: false,
      value: null,
    }]);
    assert.equal(buildFilter(schema, { constructor: 'x' }).condition, 'ctor LIKE :filter_constructor');
  });

  test('gives a new result on every call: changing one does not reach the next', () => {
    const first = filterItems({ tag: 'new' });

    readEntry(first, 'tag').options[0].label = 'Changed';
    readEntry(first, 'tag').options.push({ value: 'injected' });
    readEntry(first, 'tag').value.push('injected');

    const second = filterItems({ tag: 'new' });

    assert.deepEqual(readEntry(second, 'tag').options.map((option) => option.label), ['New', 'Sale', 'Old']);
    assert.deepEqual(readEntry(second, 'tag').value, ['new']);
    assert.deepEqual(second.binding, { filter_tag: 'new' });
  });
});

describe('buildFilter: hasText', () => {
  test('tells that a text filter took effect, an exact one too, and not one left unused or disabled', () => {
    assert.equal(filterItems({ title: 'Dune' }).hasText, true);
    assert.equal(filterItems({ code: 'A-1' }).hasText, true);
    assert.equal(filterItems({ title: '', rating: 1 }).hasText, false);
    assert.equal(filterItems({ title: 'Dune' }, { disabled: ['title'] }).hasText, false);
    assert.equal(filterItems({ ...EVERY_VALUE, title: null, code: undefined }).hasText, false);
  });
});

describe('buildFilter: the schema and the payload', () => {
  test('requires a schema with a map of filters, and its properties, when it has them, as a map', () => {
    const invalid = [undefined, null, 'users', [], {}, { filters: [] }, { filters: null }, { filters: {}, properties: [] }, { filters: {}, properties: null }];

    invalid.forEach((schema, index) => {
      assertRefused(() => buildFilter(schema), /^buildFilter\(schema, payload, \{ options, disabled \}\) requires a schema/, String(index));
    });
  });

  test('gives nothing for a schema without filters', () => {
    assert.deepEqual(buildFilter({ properties: {}, filters: {} }, { title: 'Dune' }), {
      condition: null,
      binding: {},
      filters: [],
      hasText: false,
    });
  });

  test('checks every definition of the schema with assertFilterDefinition, also one the payload does not use', () => {
    assertRefused(() => buildFilter({ filters: { title: { type: FILTER_TYPE.TEXT }, kind: { type: 'fuzzy' } } }, { title: 'Dune' }), /^buildFilter\(schema, payload, \{ options, disabled \}\): the filter "kind" has the type "fuzzy"/);
    assertRefused(() => buildFilter({ filters: { title: { type: FILTER_TYPE.TEXT, isExact: 'yes' } } }), /: the filter "title" takes isExact only as a text filter, and as a boolean/);
  });

  test('refuses a key that cannot name a placeholder, also with a column of its own', () => {
    ['first-name', '1st', 'a.b', 'імя', 'a b', ''].forEach((key) => {
      assertRefused(
        () => buildFilter({ filters: { [key]: { type: FILTER_TYPE.TEXT, column: 'name' } } }),
        /: the key of the filter ".*" names its placeholders: it takes letters, digits and underscores, and does not start with a digit$/,
        key,
      );
    });
    assert.equal(buildFilter({ filters: { _a1: { type: FILTER_TYPE.TEXT }, A: { type: FILTER_TYPE.TEXT } } }, { _a1: 'x', A: 'y' }).condition, '_a1 LIKE :filter__a1 AND _a LIKE :filter_A');
  });

  test('refuses two filters that take one query parameter, and two that bind one placeholder', () => {
    const clashes = [
      [{ created: { type: FILTER_TYPE.DATE, operator: FILTER_OPERATOR.RANGE }, createdFrom: { type: FILTER_TYPE.DATE } }, 'created', 'createdFrom', 'createdFrom'],
      [{ priceTo: { type: FILTER_TYPE.NUMBER }, price: { type: FILTER_TYPE.NUMBER, operator: FILTER_OPERATOR.RANGE } }, 'priceTo', 'price', 'priceTo'],
    ];

    clashes.forEach(([filters, first, second, name]) => {
      assertRefused(() => buildFilter({ filters }), new RegExp(`: the filters "${first}" and "${second}" both take the query parameter "${name}"$`), name);
    });
    assertRefused(
      () => buildFilter({ filters: { day: { type: FILTER_TYPE.DATE }, dayTo: { type: FILTER_TYPE.TEXT } } }),
      /: the filters "day" and "dayTo" both bind the placeholder :filter_dayTo$/,
    );
    assert.doesNotThrow(() => buildFilter({ filters: { price: { type: FILTER_TYPE.NUMBER }, priceFrom: { type: FILTER_TYPE.NUMBER } } }));
  });

  test('takes a name that is a parameter of one filter and a placeholder of another: the query and the binding never meet', () => {
    const schema = { properties: {}, filters: { created: { type: FILTER_TYPE.DATE }, createdFrom: { type: FILTER_TYPE.DATE } } };
    const query = createSchema(schema).query(['created', 'createdFrom']).response(HTTP_STATUS.NO_CONTENT).build().querystring;

    assert.deepEqual(Object.keys(query.properties), ['created', 'createdFrom']);
    assert.deepEqual(readQuery(buildFilter(schema, { created: '2026-11-20', createdFrom: '2026-11-01' })), {
      condition: [
        'created >= :filter_createdFrom',
        'created < :filter_createdTo',
        'created_from >= :filter_createdFromFrom',
        'created_from < :filter_createdFromTo',
      ].join(' AND '),
      binding: {
        filter_createdFrom: toDate('2026-11-20T00:00:00.000Z'),
        filter_createdTo: toDate('2026-11-21T00:00:00.000Z'),
        filter_createdFromFrom: toDate('2026-11-01T00:00:00.000Z'),
        filter_createdFromTo: toDate('2026-11-02T00:00:00.000Z'),
      },
    });
  });

  test('checks the definitions once per schema object, not on every request', () => {
    let reads = 0;
    const schema = {
      get filters() {
        reads += 1;

        return { title: { type: FILTER_TYPE.TEXT } };
      },
    };

    buildFilter(schema, {});
    buildFilter(schema, { title: 'Dune' });

    assert.equal(buildFilter(schema, { title: 'Dune' }).condition, 'title LIKE :filter_title');
    assert.equal(reads, 1);
  });

  test('checks a schema that failed again on the next call: only what passed is kept', () => {
    const schema = { filters: { title: { type: 'fuzzy' } } };

    assert.throws(() => buildFilter(schema), TypeError);
    assert.throws(() => buildFilter(schema), TypeError);
  });

  test('requires a payload that is a plain object, and takes request.query, an object without a prototype', () => {
    [null, 'title=Dune', ['Dune'], new Map([['title', 'Dune']])].forEach((payload, index) => {
      assertRefused(() => filterItems(payload), /requires payload to be a plain object, such as request\.query/, String(index));
    });

    const query = Object.assign(Object.create(null), { title: 'Dune', limit: 20, sort: 'newest' });

    assert.equal(filterItems(query).condition, 'title LIKE :filter_title');
  });
});

describe('buildFilter with the entity schemas', () => {
  test('filters the users by a fragment of the first name, several statuses and the start of a range of moments', () => {
    const payload = { firstName: 'An', status: 'blocked,active', createdAtFrom: '2026-11-01T00:00:00Z' };

    assert.deepEqual(buildFilter(userSchema, payload), {
      condition: 'first_name LIKE :filter_firstName AND status IN (:filter_status) AND created_at >= :filter_createdAtFrom',
      binding: {
        filter_firstName: '%An%',
        filter_status: [USER_STATUS.ACTIVE, USER_STATUS.BLOCKED],
        filter_createdAtFrom: toDate('2026-11-01T00:00:00.000Z'),
      },
      filters: [
        {
          type: FILTER_TYPE.TEXT,
          name: 'firstName',
          label: 'First name',
          isDisabled: false,
          value: 'An',
        },
        {
          type: FILTER_TYPE.OPTIONS,
          name: 'status',
          label: 'Status',
          isMultiple: true,
          isDisabled: false,
          value: [USER_STATUS.ACTIVE, USER_STATUS.BLOCKED],
          options: [
            {
              label: 'Active',
              value: USER_STATUS.ACTIVE,
              isChecked: true,
              isDisabled: false,
            },
            {
              label: 'Blocked',
              value: USER_STATUS.BLOCKED,
              isChecked: true,
              isDisabled: false,
            },
          ],
        },
        {
          type: FILTER_TYPE.DATETIME,
          name: 'createdAt',
          label: 'Created',
          operator: FILTER_OPERATOR.RANGE,
          isDisabled: false,
          value: ['2026-11-01T00:00:00Z', null],
        },
      ],
      hasText: true,
    });
  });

  test('drops the status of the users when it is disabled at runtime or its option is, and keeps the range of moments', () => {
    const payload = { status: USER_STATUS.BLOCKED, createdAtFrom: '2026-11-01T00:00:00Z', createdAtTo: '2026-11-30T23:59:59.999Z' };
    const disabled = buildFilter(userSchema, payload, { disabled: ['status'] });
    const statuses = [STATUS_OPTIONS[0], { ...STATUS_OPTIONS[1], isDisabled: true }];
    const blocked = buildFilter(userSchema, { status: 'active,blocked' }, { options: { status: statuses } });

    assert.equal(disabled.condition, 'created_at >= :filter_createdAtFrom AND created_at <= :filter_createdAtTo');
    assert.deepEqual(readEntry(disabled, 'status').isDisabled, true);
    assert.deepEqual(readQuery(blocked), { condition: 'status = :filter_status', binding: { filter_status: USER_STATUS.ACTIVE } });
    assert.equal(buildFilter(userSchema, {}).filters.every((entry) => !entry.isDisabled), true);
  });

  test('searches the groups by a fragment of the name, its underscore matched as itself', () => {
    assert.deepEqual(buildFilter(groupSchema, { name: 'adm_n' }), {
      condition: 'name LIKE :filter_name',
      binding: { filter_name: '%adm\\_n%' },
      filters: [{
        type: FILTER_TYPE.TEXT,
        name: 'name',
        label: 'Name',
        isDisabled: false,
        value: 'adm_n',
      }],
      hasText: true,
    });
  });
});

describe('buildFilter in a route: request.query as the query schema of createSchema() gives it', () => {
  async function createRoute(t) {
    const fastify = await buildTestApp();
    const results = [];
    const schema = createSchema(ITEM_SCHEMA)
      .query(Object.keys(ITEM_SCHEMA.filters))
      .response(HTTP_STATUS.NO_CONTENT)
      .build();

    t.after(() => fastify.close());
    fastify.get('/api/v1/items', { schema, security: PUBLIC }, (request, reply) => {
      results.push(buildFilter(ITEM_SCHEMA, request.query, { options: { ownerId: OWNERS } }));

      return reply.noContent();
    });

    return { fastify, results };
  }

  test('takes request.query as it is: each filter gets the type it reads', async (t) => {
    const { fastify, results } = await createRoute(t);
    const query = Object.fromEntries(Object.entries(EVERY_VALUE).map(([name, value]) => [name, String(value)]));
    const response = await fastify.inject({ url: '/api/v1/items', query });

    assert.equal(response.statusCode, HTTP_STATUS.NO_CONTENT, response.body);
    assert.deepEqual(readValues(results[0]), EVERY_EFFECT);
    assert.deepEqual(results[0].binding, filterItems(EVERY_VALUE).binding);
  });

  test('lets the value of a disabled option through the query schema, and drops it before SQL', async (t) => {
    const { fastify, results } = await createRoute(t);
    const response = await fastify.inject({ url: '/api/v1/items', query: { tag: 'old', title: 'Dune' } });

    assert.equal(response.statusCode, HTTP_STATUS.NO_CONTENT, response.body);
    assert.deepEqual(readQuery(results[0]), { condition: 'title LIKE :filter_title', binding: { filter_title: '%Dune%' } });
    assert.equal(readEntry(results[0], 'tag').value, null);
  });
});

describe('assertFilterDefinition', () => {
  test('accepts every type with each field it documents', () => {
    const definitions = [
      {
        type: FILTER_TYPE.TEXT,
        label: '',
        column: 'i.title',
        isExact: false,
        isDisabled: false,
      },
      { type: FILTER_TYPE.BOOLEAN, isDisabled: true },
      { type: FILTER_TYPE.NUMBER, operator: FILTER_OPERATOR.RANGE },
      { type: FILTER_TYPE.DATE, operator: FILTER_OPERATOR.RANGE },
      { type: FILTER_TYPE.DATETIME },
      {
        type: FILTER_TYPE.OPTIONS,
        isMultiple: true,
        options: [{ value: 'a', label: 'A', isDisabled: true }, { value: 1 }, { value: false, label: 'No' }],
      },
      { type: FILTER_TYPE.OPTIONS, isMultiple: false },
    ];

    definitions.forEach((filter, index) => {
      assert.doesNotThrow(() => assertFilterDefinition('item', filter, SIGNATURE), String(index));
    });
    Object.entries(userSchema.filters).forEach(([key, filter]) => assert.doesNotThrow(() => assertFilterDefinition(key, filter, SIGNATURE), key));
  });

  test('refuses a definition that is not an object, or of a type outside FILTER_TYPE', () => {
    [undefined, null, 'text', [], [{ type: FILTER_TYPE.TEXT }], new Map()].forEach((filter, index) => {
      assertRefused(() => assertFilterDefinition('item', filter, SIGNATURE), /^test\(filter\): the filter "item" must be an object$/, String(index));
    });
    assertRefused(
      () => assertFilterDefinition('item', { type: 'fuzzy' }, SIGNATURE),
      /^test\(filter\): the filter "item" has the type "fuzzy", which is not one of text, boolean, number, date, datetime, options$/,
    );
    assertRefused(() => assertFilterDefinition('item', {}, SIGNATURE), /^test\(filter\): the filter "item" has the type "undefined"/);
  });

  test('takes the operator "range" only on a number, a date or a datetime filter', () => {
    [FILTER_TYPE.TEXT, FILTER_TYPE.BOOLEAN, FILTER_TYPE.OPTIONS].forEach((type) => {
      assertRefused(
        () => assertFilterDefinition('item', { type, operator: FILTER_OPERATOR.RANGE }, SIGNATURE),
        /^test\(filter\): the filter "item" may take the operator "range" only as a number, date, datetime filter$/,
        type,
      );
    });
    [{ type: FILTER_TYPE.NUMBER, operator: 'between' }, { type: FILTER_TYPE.DATE, operator: null }].forEach((filter, index) => {
      assertRefused(() => assertFilterDefinition('item', filter, SIGNATURE), /may take the operator "range" only/, String(index));
    });
  });

  test('takes isMultiple only on an options filter, isExact only on a text filter, and both and isDisabled only as booleans', () => {
    const cases = [
      [{ type: FILTER_TYPE.TEXT, isMultiple: true }, /^test\(filter\): the filter "item" takes isMultiple only as an options filter, and as a boolean$/],
      [{ type: FILTER_TYPE.OPTIONS, isMultiple: 'yes' }, /takes isMultiple only as an options filter/],
      [{ type: FILTER_TYPE.OPTIONS, isExact: true }, /^test\(filter\): the filter "item" takes isExact only as a text filter, and as a boolean$/],
      [{ type: FILTER_TYPE.TEXT, isExact: 1 }, /takes isExact only as a text filter/],
      [{ type: FILTER_TYPE.TEXT, isDisabled: 'true' }, /^test\(filter\): the filter "item" takes isDisabled only as a boolean$/],
      [{ type: FILTER_TYPE.OPTIONS, isDisabled: null }, /takes isDisabled only as a boolean/],
    ];

    cases.forEach(([filter, message], index) => assertRefused(() => assertFilterDefinition('item', filter, SIGNATURE), message, String(index)));
  });

  test('takes a column only as a non-empty string, and a label only as a string', () => {
    ['', 5, null, ['i.title']].forEach((column, index) => {
      assertRefused(
        () => assertFilterDefinition('item', { type: FILTER_TYPE.TEXT, column }, SIGNATURE),
        /^test\(filter\): the filter "item" takes a column only as a non-empty string$/,
        String(index),
      );
    });
    [5, null, { en: 'Title' }].forEach((label, index) => {
      assertRefused(() => assertFilterDefinition('item', { type: FILTER_TYPE.TEXT, label }, SIGNATURE), /^test\(filter\): the filter "item" takes a label only as a string$/, String(index));
    });
  });

  test('takes options only on an options filter, as a non-empty list of { value, label, isDisabled }', () => {
    assertRefused(
      () => assertFilterDefinition('item', { type: FILTER_TYPE.TEXT, options: [{ value: 'a' }] }, SIGNATURE),
      /^test\(filter\): the filter "item" takes options only as an options filter$/,
    );

    const invalid = [[], 'a', {}, [null], [{ label: 'A' }], [{ value: null }], [{ value: {} }], [{ value: ['a'] }], [{ value: Infinity }], [{ value: 'a', label: 1 }], [{ value: 'a', isDisabled: 'yes' }]];

    invalid.forEach((options, index) => {
      assertRefused(
        () => assertFilterDefinition('item', { type: FILTER_TYPE.OPTIONS, options }, SIGNATURE),
        /^test\(filter\): the options of the filter "item" must be a list of \{ value, label \} with a string, number or boolean value; a label is a string, isDisabled a boolean$/,
        String(index),
      );
    });
  });

  test('refuses options that repeat a value, also as text: a query parameter is text', () => {
    [[{ value: 'a' }, { value: 'a' }], [{ value: 1 }, { value: '1' }], [{ value: true }, { value: 'true' }]].forEach((options, index) => {
      assertRefused(
        () => assertFilterDefinition('item', { type: FILTER_TYPE.OPTIONS, options }, SIGNATURE),
        /^test\(filter\): the options of the filter "item" must be distinct values, also as text$/,
        String(index),
      );
    });
  });
});

describe('readFilterOptions', () => {
  test('gives the options of the filter as they are, before the enum of its field', () => {
    const options = [{ value: 'a', label: 'A' }];

    assert.equal(readFilterOptions('item', { type: FILTER_TYPE.OPTIONS, options }), options);
    assert.equal(readFilterOptions('item', { type: FILTER_TYPE.OPTIONS, options }, enumOf(['a', 'b'])), options);
  });

  test('gives the enum of the field without null, each option labelled by its value as text', () => {
    assert.deepEqual(readFilterOptions('item', { type: FILTER_TYPE.OPTIONS }, { enum: [1, 'two', true, null] }), [
      { value: 1, label: '1' },
      { value: 'two', label: 'two' },
      { value: true, label: 'true' },
    ]);
    assert.deepEqual(readFilterOptions('status', userSchema.filters.status, userSchema.properties.status), userSchema.filters.status.options);
  });

  test('gives null when the filter has no options and its field no enum: its options come from the database', () => {
    [undefined, null, text('Item'), uuid('Owner'), { enum: 'a' }].forEach((property, index) => {
      assert.equal(readFilterOptions('item', { type: FILTER_TYPE.OPTIONS }, property), null, String(index));
    });
  });

  test('requires the definition of an options filter, and checks its options', () => {
    [null, { type: FILTER_TYPE.TEXT }, { options: [{ value: 'a' }] }].forEach((filter, index) => {
      assertRefused(() => readFilterOptions('item', filter), /^readFilterOptions\(key, filter, property\) requires the definition of an options filter, and "item" is not one$/, String(index));
    });
    assertRefused(() => readFilterOptions('item', { type: FILTER_TYPE.OPTIONS, options: [] }), /^readFilterOptions\(key, filter, property\): the options of the filter "item" must be a list/);
  });
});

describe('readFilterParameters', () => {
  test('names the parameter of a filter by its key, and the two of a range by the key with From and To', () => {
    assert.deepEqual(readFilterParameters('createdAt', { type: FILTER_TYPE.DATETIME, operator: FILTER_OPERATOR.RANGE }), ['createdAtFrom', 'createdAtTo']);
    assert.deepEqual(readFilterParameters('releasedOn', { type: FILTER_TYPE.DATE }), ['releasedOn']);
    assert.deepEqual(readFilterParameters('status', userSchema.filters.status), ['status']);
  });

  test('requires a key and a definition', () => {
    [[1, {}], ['item', null], ['item', FILTER_OPERATOR.RANGE]].forEach(([key, filter], index) => {
      assertRefused(() => readFilterParameters(key, filter), /^readFilterParameters\(key, filter\) requires the key and the definition of a filter$/, String(index));
    });
  });
});

describe('readFilterPlaceholders', () => {
  test('names every placeholder the filters of the schema can bind, in their order: a range and a day bind two', () => {
    assert.deepEqual(readFilterPlaceholders(ITEM_SCHEMA), [
      'filter_title',
      'filter_code',
      'filter_isPublic',
      'filter_rating',
      'filter_priceFrom',
      'filter_priceTo',
      'filter_releasedOnFrom',
      'filter_releasedOnTo',
      'filter_shownOnFrom',
      'filter_shownOnTo',
      'filter_seenAt',
      'filter_editedAtFrom',
      'filter_editedAtTo',
      'filter_kind',
      'filter_level',
      'filter_tag',
      'filter_ownerId',
    ]);
    assert.deepEqual(readFilterPlaceholders(userSchema), ['filter_firstName', 'filter_status', 'filter_createdAtFrom', 'filter_createdAtTo']);
    assert.deepEqual(readFilterPlaceholders({ filters: {} }), []);
  });

  test('holds every key of the binding buildFilter gives, whatever the payload', () => {
    const placeholders = readFilterPlaceholders(ITEM_SCHEMA);
    const payloads = [EVERY_VALUE, { releasedOn: '9999-12-31' }, { shownOnFrom: '0001-01-01', editedAtTo: '9999-12-31T23:59:59Z' }, { level: '2', tag: 'new' }];

    payloads.forEach((payload, index) => {
      const keys = Object.keys(filterItems(payload).binding);

      assert.ok(keys.length > 0, String(index));
      keys.forEach((key) => assert.ok(placeholders.includes(key), `${index}: ${key}`));
    });
  });

  test('needs no payload and no list from the database, and names the placeholders of a disabled filter too', () => {
    const schema = { filters: { ownerId: { type: FILTER_TYPE.OPTIONS }, title: { type: FILTER_TYPE.TEXT, isDisabled: true } } };

    assert.throws(() => buildFilter(schema, {}), TypeError);
    assert.deepEqual(readFilterPlaceholders(schema), ['filter_ownerId', 'filter_title']);
  });

  test('gives a new list on every call: changing one does not reach the next', () => {
    const first = readFilterPlaceholders(userSchema);

    first.push('filter_injected');
    first[0] = 'filter_changed';

    assert.deepEqual(readFilterPlaceholders(userSchema), ['filter_firstName', 'filter_status', 'filter_createdAtFrom', 'filter_createdAtTo']);
  });
});

describe('readFilterColumns', () => {
  test('names the column of every filter in their order: the column of the schema as it is, else the key in snake case', () => {
    assert.deepEqual(readFilterColumns(ITEM_SCHEMA), [
      'title',
      'code',
      'is_public',
      'rating',
      'price',
      'released_on',
      'shown_on',
      'seen_at',
      'edited_at',
      'kind',
      'level',
      'tag',
      'i.owner_id',
    ]);
    assert.deepEqual(readFilterColumns(userSchema), ['first_name', 'status', 'created_at']);
    assert.deepEqual(readFilterColumns({ filters: {} }), []);
  });

  test('gives the column each condition of buildFilter starts with, a disabled filter included', () => {
    const schema = {
      filters: {
        ownerName: { type: FILTER_TYPE.TEXT, column: "CONCAT(u.first_name, ' ', u.last_name)" },
        userStatus: { type: FILTER_TYPE.OPTIONS, column: 'u.status', options: STATUS_OPTIONS },
        isArchived: { type: FILTER_TYPE.BOOLEAN, isDisabled: true },
      },
    };
    const [ownerName, userStatus, isArchived] = readFilterColumns(schema);

    assert.equal(buildFilter(schema, { ownerName: 'Anna', userStatus: 'active' }).condition, `${ownerName} LIKE :filter_ownerName AND ${userStatus} = :filter_userStatus`);
    assert.equal(isArchived, 'is_archived');
  });

  test('gives a new list on every call', () => {
    readFilterColumns(userSchema).push('injected');

    assert.deepEqual(readFilterColumns(userSchema), ['first_name', 'status', 'created_at']);
  });
});

describe('buildFilter, readFilterPlaceholders and readFilterColumns', () => {
  test('refuse a schema and its definitions alike: the three read one check of the schema', () => {
    const cases = [
      [null, /^buildFilter\(schema, payload, \{ options, disabled \}\) requires a schema: an object with a map of "filters"$/],
      [{ filters: [] }, /^buildFilter\(schema, payload, \{ options, disabled \}\) requires a schema with a map of "filters"/],
      [{ filters: { kind: { type: 'fuzzy' } } }, /^buildFilter\(schema, payload, \{ options, disabled \}\): the filter "kind" has the type "fuzzy"/],
      [{ filters: { 'first-name': { type: FILTER_TYPE.TEXT } } }, /: the key of the filter "first-name" names its placeholders/],
      [{ filters: { day: { type: FILTER_TYPE.DATE }, dayTo: { type: FILTER_TYPE.TEXT } } }, /: the filters "day" and "dayTo" both bind the placeholder :filter_dayTo$/],
    ];

    cases.forEach(([schema, message], index) => {
      [buildFilter, readFilterPlaceholders, readFilterColumns].forEach((read) => assertRefused(() => read(schema), message, `${index}: ${read.name}`));
    });
  });

  test('check a schema once, whichever of them reads it first', () => {
    let reads = 0;
    const schema = {
      get filters() {
        reads += 1;

        return { title: { type: FILTER_TYPE.TEXT } };
      },
    };

    readFilterPlaceholders(schema);
    readFilterColumns(schema);
    buildFilter(schema, { title: 'Dune' });

    assert.equal(reads, 1);
  });
});
