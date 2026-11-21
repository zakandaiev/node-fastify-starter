import {
  assertSortEntries,
  buildSort,
  readSortEntries,
  SORT_PARAMETER,
} from '#core/db/sort.js';
import * as groupSchema from '#schemas/entity/group.js';
import * as userSchema from '#schemas/entity/user.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SIGNATURE = 'test(sort)';

const NEWEST = Object.freeze({
  value: 'newest',
  label: 'Newest first',
  orderBy: 'created_at DESC, id DESC',
  isDefault: true,
});
const OLDEST = Object.freeze({ value: 'oldest', label: 'Oldest first', orderBy: 'created_at ASC, id ASC' });
const TITLE = Object.freeze({ value: 'title', label: 'Title A-Z', orderBy: 'title ASC, id ASC' });

function createSchema(sort) {
  return { properties: {}, sort };
}

function readChecked(result) {
  return result.sort.filter((entry) => entry.isChecked).map((entry) => entry.value);
}

describe('buildSort: the entry that applies', () => {
  test('applies the default entry when the payload names none, an empty code included', () => {
    const schema = createSchema([OLDEST, NEWEST]);

    [{}, { sort: undefined }, { sort: '' }].forEach((payload, index) => {
      const result = buildSort(schema, payload);

      assert.equal(result.orderBy, NEWEST.orderBy, String(index));
      assert.deepEqual(readChecked(result), ['newest'], String(index));
    });
    assert.equal(buildSort(schema).orderBy, NEWEST.orderBy);
  });

  test('applies the entry the code names', () => {
    const result = buildSort(createSchema([NEWEST, OLDEST, TITLE]), { sort: 'title' });

    assert.equal(result.orderBy, TITLE.orderBy);
    assert.deepEqual(readChecked(result), ['title']);
  });

  test('applies the default for a code no entry has: a link saved with an old code still works', () => {
    const result = buildSort(createSchema([NEWEST, OLDEST]), { sort: 'popular' });

    assert.equal(result.orderBy, NEWEST.orderBy);
    assert.deepEqual(readChecked(result), ['newest']);
  });

  test('gives no orderBy and checks no entry when nothing applies: no default and no code, or an unknown one', () => {
    const schema = createSchema([OLDEST, TITLE]);

    [{}, { sort: '' }, { sort: 'newest' }].forEach((payload, index) => {
      const result = buildSort(schema, payload);

      assert.equal(result.orderBy, null, String(index));
      assert.deepEqual(readChecked(result), [], String(index));
    });
    assert.equal(buildSort(schema, { sort: 'title' }).orderBy, TITLE.orderBy);
  });

  test('matches a code exactly: case and blanks make another code', () => {
    const schema = createSchema([NEWEST, TITLE]);

    ['TITLE', ' title', 'title '].forEach((sort) => {
      assert.equal(buildSort(schema, { sort }).orderBy, NEWEST.orderBy, sort);
    });
  });

  test('reads the code only from "sort" of the payload, also of one without a prototype such as request.query', () => {
    const schema = createSchema([NEWEST, OLDEST]);
    const query = Object.assign(Object.create(null), { sort: 'oldest', orderBy: 'id', limit: 20 });

    assert.equal(SORT_PARAMETER, 'sort');
    assert.equal(buildSort(schema, query).orderBy, OLDEST.orderBy);
    assert.equal(buildSort(schema, { orderBy: 'id DESC', value: 'oldest' }).orderBy, NEWEST.orderBy);
  });

  test('refuses a code that is not a string, null among them: the query schema of the route gives a string', () => {
    const schema = createSchema([NEWEST, OLDEST]);

    [null, 1, true, ['newest'], { value: 'newest' }].forEach((sort, index) => {
      assert.throws(
        () => buildSort(schema, { sort }),
        { name: 'TypeError', message: /buildSort\(schema, payload\) requires "sort" of the payload to be the code of an entry: name it in \.query\(\) of the route/ },
        String(index),
      );
    });
  });
});

describe('buildSort: the list of entries', () => {
  test('describes every entry in its order: label, value, isChecked and isDefault, false when absent', () => {
    assert.deepEqual(buildSort(createSchema([TITLE, NEWEST, OLDEST]), { sort: 'oldest' }), {
      orderBy: OLDEST.orderBy,
      sort: [
        {
          label: 'Title A-Z',
          value: 'title',
          isChecked: false,
          isDefault: false,
        },
        {
          label: 'Newest first',
          value: 'newest',
          isChecked: false,
          isDefault: true,
        },
        {
          label: 'Oldest first',
          value: 'oldest',
          isChecked: true,
          isDefault: false,
        },
      ],
    });
  });

  test('keeps orderBy out of the list: the client sees codes, never the columns', () => {
    const { sort } = buildSort(userSchema);

    sort.forEach((entry) => assert.deepEqual(Object.keys(entry).sort(), ['isChecked', 'isDefault', 'label', 'value'], entry.value));
  });

  test('labels an entry without a label by its code', () => {
    const { sort } = buildSort(createSchema([{ value: 'oldest', orderBy: OLDEST.orderBy }]));

    assert.equal(sort[0].label, 'oldest');
  });

  test('gives no orderBy and an empty list for a schema without sort', () => {
    [{ properties: {} }, { properties: {}, sort: null }, { properties: {}, sort: [] }].forEach((schema, index) => {
      assert.deepEqual(buildSort(schema, { sort: 'newest' }), { orderBy: null, sort: [] }, String(index));
    });
  });

  test('gives a new list on every call: changing one does not reach the next', () => {
    const schema = createSchema([NEWEST, OLDEST]);
    const first = buildSort(schema);

    first.sort[0].isChecked = false;
    first.sort.push({ value: 'injected' });

    assert.deepEqual(buildSort(schema).sort.map((entry) => [entry.value, entry.isChecked]), [['newest', true], ['oldest', false]]);
  });
});

describe('buildSort with the entity schemas', () => {
  test('orders the users newest first by default, and by name on request', () => {
    assert.deepEqual(buildSort(userSchema, {}), {
      orderBy: 'created_at DESC, id DESC',
      sort: [
        {
          label: 'Newest first',
          value: 'newest',
          isChecked: true,
          isDefault: true,
        },
        {
          label: 'Name A-Z',
          value: 'name',
          isChecked: false,
          isDefault: false,
        },
      ],
    });
    assert.equal(buildSort(userSchema, { sort: 'name' }).orderBy, 'first_name ASC, id ASC');
  });

  test('orders the groups by name by default, and newest first on request', () => {
    assert.equal(buildSort(groupSchema, {}).orderBy, 'name ASC, id ASC');
    assert.deepEqual(readChecked(buildSort(groupSchema, { sort: 'newest' })), ['newest']);
    assert.equal(buildSort(groupSchema, { sort: 'newest' }).orderBy, 'created_at DESC, id DESC');
  });
});

describe('buildSort: the schema and the payload', () => {
  test('requires a schema: an object, a module of src/schemas among them', () => {
    [undefined, null, 'users', [], [NEWEST]].forEach((schema, index) => {
      assert.throws(() => buildSort(schema), { name: 'TypeError', message: /buildSort\(schema, payload\) requires a schema/ }, String(index));
    });
  });

  test('requires a payload that is a plain object', () => {
    [null, 'sort=newest', ['newest'], new Map([['sort', 'newest']])].forEach((payload, index) => {
      assert.throws(() => buildSort(userSchema, payload), { name: 'TypeError', message: /requires payload to be a plain object/ }, String(index));
    });
  });

  test('checks the entries of a schema with the rules of assertSortEntries', () => {
    assert.throws(() => buildSort(createSchema('newest')), /buildSort\(schema, payload\) requires "sort" to be a list of entries/);
    assert.throws(() => buildSort(createSchema([NEWEST, { ...OLDEST, value: 'newest' }])), /requires every entry of "sort" to have a "value" of its own/);
    assert.throws(() => buildSort(createSchema([NEWEST, { ...OLDEST, isDefault: true }])), /"sort" has more than one entry with isDefault/);
    assert.throws(() => buildSort(createSchema([NEWEST, { value: 'oldest' }])), /requires every entry of "sort" to have an "orderBy" text, and "oldest" has none/);
  });

  test('checks the entries once per schema object, not on every request', () => {
    let reads = 0;
    const schema = {
      get sort() {
        reads += 1;

        return [NEWEST, OLDEST];
      },
    };

    buildSort(schema);
    buildSort(schema, { sort: 'oldest' });
    buildSort(schema, { sort: 'newest' });

    assert.equal(reads, 1);
    assert.equal(buildSort(schema, { sort: 'oldest' }).orderBy, OLDEST.orderBy);
  });

  test('checks a broken schema again on the next call: only what passed is kept', () => {
    const schema = createSchema([{ value: 'oldest' }]);

    assert.throws(() => buildSort(schema), TypeError);
    assert.throws(() => buildSort(schema), TypeError);
  });
});

describe('readSortEntries', () => {
  test('gives the entries buildSort() applies, read once for each schema object: a sort put in later reaches neither', () => {
    const schema = createSchema([NEWEST, OLDEST]);
    const entries = readSortEntries(schema);

    schema.sort = [TITLE];

    assert.deepEqual(entries, [NEWEST, OLDEST]);
    assert.equal(readSortEntries(schema), entries);
    assert.equal(buildSort(schema, { sort: 'title' }).orderBy, NEWEST.orderBy);
    assert.equal(readSortEntries(userSchema), userSchema.sort);
  });

  test('shares its check with buildSort(): the sort of a schema is read once whichever of the two comes first', () => {
    let reads = 0;
    const schema = {
      get sort() {
        reads += 1;

        return [NEWEST, OLDEST];
      },
    };

    buildSort(schema);
    readSortEntries(schema);
    buildSort(schema, { sort: 'oldest' });

    assert.equal(reads, 1);
  });

  test('gives an empty list for a schema without sort', () => {
    [{ properties: {} }, { properties: {}, sort: null }, { properties: {}, sort: [] }].forEach((schema, index) => {
      assert.deepEqual(readSortEntries(schema), [], String(index));
    });
  });

  test('refuses what buildSort() refuses, under its own name, and keeps nothing it refused', () => {
    [undefined, null, 'users', [], [NEWEST]].forEach((schema, index) => {
      assert.throws(() => readSortEntries(schema), { name: 'TypeError', message: 'readSortEntries(schema) requires a schema: an object that may export "sort"' }, String(index));
    });

    const broken = createSchema([NEWEST, { ...OLDEST, isDefault: true }]);

    assert.throws(() => readSortEntries(createSchema('newest')), { name: 'TypeError', message: 'readSortEntries(schema) requires "sort" to be a list of entries' });
    assert.throws(() => readSortEntries(createSchema([NEWEST, { value: 'oldest' }])), /^TypeError: readSortEntries\(schema\) requires every entry of "sort" to have an "orderBy" text/);
    assert.throws(() => readSortEntries(broken), /^TypeError: readSortEntries\(schema\): "sort" has more than one entry with isDefault$/);
    assert.throws(() => buildSort(broken), /^TypeError: buildSort\(schema, payload\): "sort" has more than one entry with isDefault$/);
  });
});

describe('assertSortEntries', () => {
  test('accepts the sort of the entity schemas, an empty list and entries without a label or a default', () => {
    [userSchema.sort, groupSchema.sort, [], [{ value: 'oldest', orderBy: OLDEST.orderBy }]].forEach((sort, index) => {
      assert.doesNotThrow(() => assertSortEntries(sort, SIGNATURE), String(index));
    });
  });

  test('requires a list of entries', () => {
    [undefined, null, 'newest', NEWEST].forEach((sort, index) => {
      assert.throws(() => assertSortEntries(sort, SIGNATURE), { name: 'TypeError', message: /^test\(sort\) requires "sort" to be a list of entries/ }, String(index));
    });
  });

  test('requires every entry to have a value of its own: a non-empty string no other entry has', () => {
    const invalid = [
      [{ label: 'Newest first', orderBy: NEWEST.orderBy }],
      [{ value: '', orderBy: NEWEST.orderBy }],
      [{ value: 1, orderBy: NEWEST.orderBy }],
      ['newest'],
      [null],
      [NEWEST, { ...OLDEST, value: 'newest' }],
    ];

    invalid.forEach((sort, index) => {
      assert.throws(
        () => assertSortEntries(sort, SIGNATURE),
        { name: 'TypeError', message: /^test\(sort\) requires every entry of "sort" to have a "value" of its own$/ },
        String(index),
      );
    });
  });

  test('refuses more than one entry with isDefault', () => {
    assert.throws(
      () => assertSortEntries([NEWEST, { ...OLDEST, isDefault: true }], SIGNATURE),
      { name: 'TypeError', message: /^test\(sort\): "sort" has more than one entry with isDefault$/ },
    );
    assert.doesNotThrow(() => assertSortEntries([NEWEST, { ...OLDEST, isDefault: false }], SIGNATURE));
  });

  test('requires every entry to have the text of its ORDER BY', () => {
    [{ value: 'oldest' }, { value: 'oldest', orderBy: '' }, { value: 'oldest', orderBy: ['created_at'] }].forEach((entry, index) => {
      assert.throws(
        () => assertSortEntries([NEWEST, entry], SIGNATURE),
        { name: 'TypeError', message: /^test\(sort\) requires every entry of "sort" to have an "orderBy" text, and "oldest" has none$/ },
        String(index),
      );
    });
  });

  test('reports two defaults before a missing orderBy, as createSchema() always has', () => {
    const twoDefaults = [{ value: 'name', isDefault: true }, { value: 'newest', isDefault: true }];

    assert.throws(() => assertSortEntries(twoDefaults, SIGNATURE), /"sort" has more than one entry with isDefault/);
  });
});
