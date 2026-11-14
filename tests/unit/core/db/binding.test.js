import { bindSql } from '#core/db/binding.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SECRET = 'john@example.com';

describe('bindSql', () => {
  test('turns named placeholders into marks and returns the values in the order of the statement', () => {
    const bound = bindSql('SELECT * FROM users WHERE status = :status AND age > :age', { age: 18, status: 'active' });

    assert.deepEqual(bound, {
      sql: 'SELECT * FROM users WHERE status = ? AND age > ?',
      values: ['active', 18],
    });
  });

  test('repeats the value of a name that is used twice', () => {
    const bound = bindSql('SELECT * FROM t WHERE a = :id OR b = :id', { id: 7 });

    assert.deepEqual(bound, { sql: 'SELECT * FROM t WHERE a = ? OR b = ?', values: [7, 7] });
  });

  test('leaves a statement without placeholders as it is', () => {
    assert.deepEqual(bindSql('SELECT 1'), { sql: 'SELECT 1', values: [] });
    assert.deepEqual(bindSql('SELECT 1', {}), { sql: 'SELECT 1', values: [] });
  });

  test('drops the keys the statement does not use', () => {
    const bound = bindSql('SELECT COUNT(*) FROM users WHERE status = :status', { status: 'active', limit: 20, offset: 0 });

    assert.deepEqual(bound.values, ['active']);
  });

  test('keeps a numeric value a number: LIMIT takes no text', () => {
    const bound = bindSql('SELECT * FROM users LIMIT :limit OFFSET :offset', { limit: 20, offset: 40 });

    assert.deepEqual(bound, { sql: 'SELECT * FROM users LIMIT ? OFFSET ?', values: [20, 40] });
  });

  test('passes every allowed value through untouched', () => {
    const date = new Date('2026-01-02T03:04:05.678Z');
    const buffer = Buffer.from('ab');
    const binding = {
      text: 'Привіт 😀',
      empty: '',
      number: -1.5,
      zero: 0,
      big: 12345678901234567890n,
      yes: true,
      no: false,
      date,
      buffer,
      nothing: null,
    };
    const { values } = bindSql('SELECT :text, :empty, :number, :zero, :big, :yes, :no, :date, :buffer, :nothing', binding);

    assert.deepEqual(values, ['Привіт 😀', '', -1.5, 0, 12345678901234567890n, true, false, date, buffer, null]);
    assert.equal(values[7], date);
    assert.equal(values[8], buffer);
  });

  test('accepts an object without a prototype, such as request.query', () => {
    const binding = Object.assign(Object.create(null), { id: 5 });

    assert.deepEqual(bindSql('SELECT :id', binding).values, [5]);
  });

  test('requires binding to be a plain object', () => {
    assert.throws(() => bindSql('SELECT 1', null), /requires binding to be a plain object/);
    assert.throws(() => bindSql('SELECT :id', [1]), TypeError);
    assert.throws(() => bindSql('SELECT :id', 'id'), TypeError);
    assert.throws(() => bindSql('SELECT :id', new Map([['id', 1]])), TypeError);
  });

  test('requires a string statement', () => {
    assert.throws(() => bindSql(), TypeError);
    assert.throws(() => bindSql(null, {}), TypeError);
  });
});

describe('bindSql: what is not a placeholder', () => {
  test('does not bind a name inside a comment', () => {
    const bound = bindSql('SELECT * FROM users -- owner:me\nWHERE id = :id # :hash\n/* :block */', { id: 1 });

    assert.deepEqual(bound, {
      sql: 'SELECT * FROM users -- owner:me\nWHERE id = ? # :hash\n/* :block */',
      values: [1],
    });
  });

  test('does not bind a name inside a literal or a quoted identifier', () => {
    const bound = bindSql("SELECT ':a', \"x:b\", `:c`, '10:20:30' FROM t WHERE id = :id", { id: 1 });

    assert.deepEqual(bound, {
      sql: "SELECT ':a', \"x:b\", `:c`, '10:20:30' FROM t WHERE id = ?",
      values: [1],
    });
  });

  test('binds a placeholder that follows a literal ending with a backslash', () => {
    const bound = bindSql("SELECT * FROM t WHERE path = 'C:\\\\' AND id = :id", { id: 1 });

    assert.deepEqual(bound, { sql: "SELECT * FROM t WHERE path = 'C:\\\\' AND id = ?", values: [1] });
  });

  test('does not take the assignment operator for a placeholder', () => {
    assert.deepEqual(bindSql('SELECT @rank := @rank + 1').values, []);
  });

  test('leaves a question mark inside a literal or a comment alone', () => {
    const bound = bindSql("SELECT 'what?' AS v -- why?\nFROM t WHERE id = :id", { id: 1 });

    assert.deepEqual(bound, { sql: "SELECT 'what?' AS v -- why?\nFROM t WHERE id = ?", values: [1] });
  });

  test('refuses a placeholder glued to a name, a number or another placeholder before it: the value would join it', () => {
    const statements = ['SELECT id FROM users LIMIT:limit', 'SELECT 1:limit', 'SELECT @a:limit', 'SELECT :other:limit', 'SELECT é:limit'];

    statements.forEach((sql) => {
      assert.throws(
        () => bindSql(sql, { limit: 1, other: 2 }),
        /SQL has placeholder :limit glued to what stands next to it at position \d+/,
        sql,
      );
    });
  });

  test('refuses a placeholder glued to a quote or a dot on either side: the value would become a part of that literal or number', () => {
    const statements = [
      "SELECT name LIKE :value'%'",
      "SELECT 'a':value",
      'SELECT "a":value',
      'SELECT `a`:value',
      'SELECT :value"a"',
      'SELECT 1.:value',
      'SELECT :value.5',
      'SELECT :value.:other',
    ];

    statements.forEach((sql) => {
      assert.throws(() => bindSql(sql, { value: 7, other: 5 }), /SQL has placeholder :value glued to what stands next to it/, sql);
    });
    assert.equal(bindSql("SELECT name LIKE :value '%', :value || 'x', :user@:host", { value: 'a', user: 'u', host: 'h' }).sql, "SELECT name LIKE ? '%', ? || 'x', ?@?");
  });

  test('binds a placeholder that follows an operator, a parenthesis, a comma, a comment, or starts the statement', () => {
    assert.equal(bindSql('WHERE a=:id AND b IN(:id) OR c IN (1,:id)', { id: 1 }).sql, 'WHERE a=? AND b IN(?) OR c IN (1,?)');
    assert.equal(bindSql('SELECT @a:=:id, /* c */:id', { id: 1 }).sql, 'SELECT @a:=?, /* c */?');
    assert.equal(bindSql(':id', { id: 1 }).sql, '?');
  });

  test('refuses a positional placeholder', () => {
    assert.throws(() => bindSql('SELECT * FROM t WHERE id = ?', {}), /a "\?" placeholder at position 27: only named placeholders/);
    assert.throws(() => bindSql('SELECT * FROM t WHERE id = ? AND a = :a', { a: 1 }), SyntaxError);
  });

  test('refuses a statement the lexer cannot read', () => {
    assert.throws(() => bindSql("SELECT 'abc WHERE id = :id", { id: 1 }), SyntaxError);
    assert.throws(() => bindSql('SELECT (:id', { id: 1 }), SyntaxError);
  });
});

describe('bindSql: values', () => {
  test('refuses a placeholder without a value', () => {
    assert.throws(() => bindSql('SELECT :id', {}), /Placeholder :id has no value in the binding/);
    assert.throws(() => bindSql('SELECT :id', { id: undefined }), /Placeholder :id has no value in the binding/);
    assert.throws(() => bindSql('SELECT :id'), TypeError);
    assert.throws(() => bindSql('SELECT :a, :b', { a: 1 }), /Placeholder :b has no value/);
  });

  test('does not read a value from the prototype of the binding', () => {
    assert.throws(() => bindSql('SELECT :constructor', {}), /Placeholder :constructor has no value/);
    assert.throws(() => bindSql('SELECT :toString', {}), /Placeholder :toString has no value/);
    assert.throws(() => bindSql('SELECT :__proto__', {}), /Placeholder :__proto__ has no value/);
  });

  test('refuses an object before the statement runs', () => {
    assert.throws(() => bindSql('SELECT :value', { value: { id: 1 } }), /Placeholder :value cannot be bound to a value of type object/);
    assert.throws(() => bindSql('SELECT :value', { value: new Map() }), TypeError);
    assert.throws(() => bindSql('SELECT :value', { value: new Uint8Array(2) }), TypeError);
    assert.throws(() => bindSql('SELECT :value', { value: Object.create(null) }), TypeError);
  });

  test('refuses a number that is not finite', () => {
    assert.throws(() => bindSql('SELECT :value', { value: NaN }), /cannot be bound to NaN/);
    assert.throws(() => bindSql('SELECT :value', { value: Infinity }), /cannot be bound to Infinity/);
    assert.throws(() => bindSql('SELECT :value', { value: -Infinity }), /cannot be bound to -Infinity/);
  });

  test('refuses an invalid date, a function and a symbol', () => {
    assert.throws(() => bindSql('SELECT :value', { value: new Date('nope') }), /cannot be bound to an invalid Date/);
    assert.throws(() => bindSql('SELECT :value', { value() {} }), /a value of type function/);
    assert.throws(() => bindSql('SELECT :value', { value: Symbol('x') }), /a value of type symbol/);
  });

  test('refuses a date outside the years 1000-9999: the server could not read it as a date', () => {
    const refused = [
      new Date('0999-12-31T23:59:59.999Z'),
      new Date('0001-01-01T00:00:00.000Z'),
      new Date('+010000-01-01T00:00:00.000Z'),
      new Date(1.76e15),
      new Date(8.64e15),
      new Date(-8.64e15),
    ];
    const accepted = [new Date('1000-01-01T00:00:00.000Z'), new Date(0), new Date('9999-12-31T23:59:59.999Z')];

    refused.forEach((value) => {
      assert.throws(() => bindSql('SELECT :value', { value }), /cannot be bound to a Date outside the years 1000-9999/);
    });
    accepted.forEach((value) => assert.deepEqual(bindSql('SELECT :value', { value }).values, [value]));
  });

  test('names the allowed values and never repeats the refused one', () => {
    const refused = [{ email: SECRET }, [[SECRET]], new Date(`${SECRET}`)];

    refused.forEach((value) => {
      assert.throws(() => bindSql('SELECT * FROM t WHERE id IN (:value)', { value }), (error) => {
        assert.match(error.message, /a value is a string, a finite number, a bigint, a boolean, a Date, a Buffer or null/);
        assert.equal(error.message.includes(SECRET), false);

        return true;
      });
    });
  });
});

describe('bindSql: lists', () => {
  test('expands an array inside IN (:name) into one mark for each item', () => {
    const bound = bindSql('SELECT * FROM users WHERE id IN (:ids) AND status = :status', { ids: [3, 1, 2], status: 'active' });

    assert.deepEqual(bound, {
      sql: 'SELECT * FROM users WHERE id IN (?, ?, ?) AND status = ?',
      values: [3, 1, 2, 'active'],
    });
  });

  test('accepts the list in any spelling of IN: lower case, without a space, negated, around a comment', () => {
    const binding = { ids: ['a', 'b'] };

    assert.equal(bindSql('WHERE id in (:ids)', binding).sql, 'WHERE id in (?, ?)');
    assert.equal(bindSql('WHERE id IN(:ids)', binding).sql, 'WHERE id IN(?, ?)');
    assert.equal(bindSql('WHERE id NOT IN ( :ids )', binding).sql, 'WHERE id NOT IN ( ?, ? )');
    assert.equal(bindSql('WHERE id IN (/* list */ :ids -- tail\n)', binding).sql, 'WHERE id IN (/* list */ ?, ? -- tail\n)');
  });

  test('keeps a list of one item a list', () => {
    assert.deepEqual(bindSql('WHERE id IN (:ids)', { ids: [5] }), { sql: 'WHERE id IN (?)', values: [5] });
  });

  test('accepts a single value inside IN as well', () => {
    assert.deepEqual(bindSql('WHERE id IN (:id)', { id: 5 }), { sql: 'WHERE id IN (?)', values: [5] });
  });

  test('turns an empty array into a subquery without rows: IN matches nothing, NOT IN everything', () => {
    assert.deepEqual(bindSql('WHERE id IN (:ids)', { ids: [] }), {
      sql: 'WHERE id IN (SELECT NULL FROM (SELECT NULL) empty_list WHERE FALSE)',
      values: [],
    });
    assert.equal(
      bindSql('WHERE id NOT IN (:ids)', { ids: [] }).sql,
      'WHERE id NOT IN (SELECT NULL FROM (SELECT NULL) empty_list WHERE FALSE)',
    );
  });

  test('refuses an array anywhere else', () => {
    const binding = { ids: [1, 2], other: 3 };
    const statements = [
      'WHERE id = :ids',
      'WHERE id IN (:ids, :other)',
      'WHERE id IN (:other, :ids)',
      'WHERE id IN ((:ids))',
      'INSERT INTO t (a) VALUES (:ids)',
      'ORDER BY FIELD(id, :ids)',
      'WHERE id = ANY (:ids)',
      'WHERE pin (:ids)',
      'LIMIT :ids',
    ];

    statements.forEach((sql) => {
      assert.throws(() => bindSql(sql, binding), /Placeholder :ids is bound to an array, which is allowed only as "IN \(:ids\)"/, sql);
    });
  });

  test('refuses an array next to an operator, a number or a variable inside the parentheses', () => {
    const statements = [
      'WHERE id IN (:ids + 1)',
      'WHERE id IN (1 + :ids)',
      'WHERE id IN (-:ids)',
      'WHERE id IN (--:ids)',
      'WHERE id IN (:ids = 1)',
      'WHERE id IN (@x := :ids)',
      'WHERE id IN (5.0 :ids)',
      'WHERE id IN (/* a */ - /* b */ :ids)',
      'WHERE id NOT IN (:ids + 1)',
      'WHERE id IN 5 (:ids)',
    ];

    statements.forEach((sql) => {
      assert.throws(() => bindSql(sql, { ids: [1, 2] }), /which is allowed only as "IN \(:ids\)"/, sql);
      assert.throws(() => bindSql(sql, { ids: [] }), /which is allowed only as "IN \(:ids\)"/, sql);
    });
    assert.deepEqual(bindSql('WHERE id IN (:id + 1)', { id: 5 }), { sql: 'WHERE id IN (? + 1)', values: [5] });
  });

  test('takes a name that only spells IN for a name: after a dot, with a dollar sign, outside ASCII', () => {
    ['WHERE o.in (:ids)', 'WHERE $in (:ids)', 'WHERE ın (:ids)', 'WHERE in.x (:ids)'].forEach((sql) => {
      assert.throws(() => bindSql(sql, { ids: [1, 2] }), /which is allowed only as "IN \(:ids\)"/, sql);
    });
    assert.equal(bindSql('WHERE o.id IN (:ids)', { ids: [1, 2] }).sql, 'WHERE o.id IN (?, ?)');
    assert.equal(bindSql('WHERE o.in IN (:ids)', { ids: [1, 2] }).sql, 'WHERE o.in IN (?, ?)');
  });

  test('sees IN right after a number with a decimal point, as the server does', () => {
    assert.equal(bindSql('WHERE id+0.0IN (:ids)', { ids: [1, 2] }).sql, 'WHERE id+0.0IN (?, ?)');
  });

  test('refuses an array with a hole in it', () => {
    const sparse = [1, 2, 3];

    delete sparse[1];

    assert.throws(() => bindSql('WHERE id IN (:ids)', { ids: sparse }), /cannot be bound to a value of type undefined/);
    assert.throws(() => bindSql('WHERE id IN (:ids)', { ids: new Array(2) }), /cannot be bound to a value of type undefined/);
  });

  test('refuses an array with null in it', () => {
    assert.throws(
      () => bindSql('WHERE id NOT IN (:ids)', { ids: [1, null] }),
      /Placeholder :ids is bound to an array with null in it/,
    );
  });

  test('refuses an array with a value that cannot be bound', () => {
    assert.throws(() => bindSql('WHERE id IN (:ids)', { ids: [1, [2]] }), /cannot be bound to a nested array/);
    assert.throws(() => bindSql('WHERE id IN (:ids)', { ids: [{ id: 1 }] }), /a value of type object/);
    assert.throws(() => bindSql('WHERE id IN (:ids)', { ids: [1, undefined] }), /a value of type undefined/);
    assert.throws(() => bindSql('WHERE id IN (:ids)', { ids: [NaN] }), /cannot be bound to NaN/);
  });

  test('does not change the array it is given', () => {
    const ids = Object.freeze([1, 2]);
    const { values } = bindSql('WHERE id IN (:ids)', { ids });

    assert.deepEqual(values, [1, 2]);
    assert.notEqual(values, ids);
  });
});

describe('bindSql: render', () => {
  test('lets a driver write a value in its own way, given the value and its position', () => {
    const calls = [];

    function render(value, index) {
      calls.push([value, index]);

      return `$${index + 1}`;
    }

    const bound = bindSql('WHERE a = :a AND id IN (:ids) AND b = :b', { a: 'x', ids: [7, 8], b: null }, { render });

    assert.deepEqual(bound, {
      sql: 'WHERE a = $1 AND id IN ($2, $3) AND b = $4',
      values: ['x', 7, 8, null],
    });
    assert.deepEqual(calls, [['x', 0], [7, 1], [8, 2], [null, 3]]);
  });

  test('puts the text of a value in the place of its name only', () => {
    const bound = bindSql("SELECT ':a', :a -- :a", { a: 1 }, { render: (value) => `<${value}>` });

    assert.equal(bound.sql, "SELECT ':a', <1> -- :a");
  });

  test('does not ask for a value of an empty list', () => {
    const bound = bindSql('WHERE id IN (:ids)', { ids: [] }, { render: () => assert.fail('must not be called') });

    assert.equal(bound.sql, 'WHERE id IN (SELECT NULL FROM (SELECT NULL) empty_list WHERE FALSE)');
  });

  test('requires render to be a function', () => {
    assert.throws(() => bindSql('SELECT 1', {}, { render: '?' }), /requires render to be a function/);
  });
});

describe('bindSql: cost', () => {
  test('binds a long list and a long statement instantly', () => {
    const startedAt = performance.now();
    const ids = Array.from({ length: 200000 }, (unused, index) => index);
    const names = Array.from({ length: 20000 }, (unused, index) => `p${index}`);
    const binding = Object.fromEntries(names.map((name, index) => [name, index]));

    assert.equal(bindSql('WHERE id IN (:ids)', { ids }).values.length, ids.length);
    assert.equal(bindSql(`SELECT ${names.map((name) => `:${name}`).join(', ')}`, binding).values.length, names.length);
    assert.ok(performance.now() - startedAt < 2000);
  });
});
