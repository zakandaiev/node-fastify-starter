import { SESSION_SQL } from '#core/db/driver/mariadb.js';
import { DbError } from '#core/db/error.js';
import { withTransaction } from '#core/db/transaction.js';
import { createTestDb } from '#root/tests/helper/db.js';
import { createLogSink } from '#root/tests/helper/log.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const CLOCK_TOLERANCE_MS = 5000;
const SECRET = 'john@example.com';

const testDb = await createTestDb();
const { db, run } = testDb;

function query(sql, binding, options) {
  return run(() => db.query(sql, binding, options));
}

async function readRows(sql, binding) {
  const { rows } = await query(sql, binding);

  return rows;
}

describe('db: time', { skip: testDb.skip }, () => {
  before(() => query('CREATE TABLE moments (id INT PRIMARY KEY, at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))'));

  test('SELECT NOW() answers in UTC', async () => {
    const [row] = await readRows('SELECT NOW(3) AS now, UTC_TIMESTAMP(3) AS utc, @@session.time_zone AS timeZone');

    assert.equal(row.timeZone, '+00:00');
    assert.ok(row.now instanceof Date);
    assert.equal(row.now.getTime(), row.utc.getTime());
    assert.ok(Math.abs(row.now.getTime() - Date.now()) < CLOCK_TOLERANCE_MS);
  });

  test('a column that defaults to CURRENT_TIMESTAMP is written in UTC', async () => {
    await query('INSERT INTO moments (id) VALUES (1)');

    const [row] = await readRows('SELECT at FROM moments WHERE id = 1');

    assert.ok(Math.abs(row.at.getTime() - Date.now()) < CLOCK_TOLERANCE_MS);
  });

  test('a Date goes in and comes back as the same moment, to the millisecond', async () => {
    const at = new Date('2026-01-02T03:04:05.678Z');

    await query('INSERT INTO moments (id, at) VALUES (2, :at)', { at });

    const [row] = await readRows('SELECT at, CAST(at AS CHAR) AS text FROM moments WHERE id = 2');

    assert.equal(row.at.toISOString(), '2026-01-02T03:04:05.678Z');
    assert.equal(row.text, '2026-01-02 03:04:05.678');
  });

  test('every connection of the pool gets the settings of the session', async () => {
    const sessions = await Promise.all(Array.from({ length: 4 }, () => readRows(`
      SELECT
        CONNECTION_ID() AS id,
        @@session.time_zone AS timeZone,
        @@session.character_set_client AS charset,
        @@session.sql_mode AS sqlMode,
        @@session.autocommit AS autocommit,
        @@session.lc_messages AS language,
        @@session.group_concat_max_len = @@session.max_allowed_packet AS isAggregateWhole,
        SLEEP(0.05) AS waited
    `)));
    const ids = sessions.map(([row]) => row.id);

    assert.ok(new Set(ids).size > 1);
    sessions.forEach(([session]) => {
      assert.deepEqual(pick(session, ['timeZone', 'charset', 'autocommit', 'language', 'isAggregateWhole']), {
        timeZone: '+00:00',
        charset: 'utf8mb4',
        autocommit: 1,
        language: 'en_US',
        isAggregateWhole: 1,
      });
      assert.equal(session.sqlMode.includes('NO_BACKSLASH_ESCAPES'), false);
    });
  });
});

describe('db: values', { skip: testDb.skip }, () => {
  before(async () => {
    await query(`
      CREATE TABLE samples (
        id INT PRIMARY KEY,
        is_active TINYINT(1) NULL,
        rating TINYINT NULL,
        level TINYINT(3) UNSIGNED NULL,
        amount DECIMAL(10,2) NULL,
        profile JSON NULL,
        views BIGINT NULL,
        ref UUID NULL,
        payload VARBINARY(16) NULL
      )
    `);
    await query(`
      INSERT INTO samples (id, is_active, rating, level, amount, profile, views, ref, payload) VALUES
        (1, 1, 1, 200, 12.50, '{"first_name": "Anna", "tags": ["a", "b"], "nested": {"is_new": true}}', 42, '019A0000-0000-7000-8000-000000000001', 'ab'),
        (2, 0, 0, 1, 0.10, '[1, "two", null]', 9007199254740993, NULL, NULL),
        (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
    `);
  });

  test('TINYINT(1) comes back as a boolean, and NULL stays null', async () => {
    const rows = await readRows('SELECT is_active FROM samples ORDER BY id');

    assert.deepEqual(rows.map((row) => row.is_active), [true, false, null]);
  });

  test('a TINYINT of another width stays a number, whatever it holds', async () => {
    const rows = await readRows('SELECT rating, level FROM samples ORDER BY id');

    assert.deepEqual(rows, [{ rating: 1, level: 200 }, { rating: 0, level: 1 }, { rating: null, level: null }]);
  });

  test('a boolean stays one through a derived table, a CTE and a join', async () => {
    const [row] = await readRows(`
      WITH picked AS (SELECT id, is_active FROM samples WHERE id = 1)
      SELECT q.is_active AS derived, picked.is_active AS cte
      FROM (SELECT id, is_active FROM samples) q
      JOIN picked ON picked.id = q.id
    `);

    assert.deepEqual(row, { derived: true, cte: true });
  });

  test('a boolean is a number after UNION, an aggregate, CASE, IF and COALESCE: the server reports another column', async () => {
    const united = await readRows('SELECT is_active FROM samples WHERE id = 1 UNION ALL SELECT is_active FROM samples WHERE id = 2');
    const [aggregated] = await readRows('SELECT MAX(is_active) AS top, MIN(is_active) AS bottom FROM samples');
    const [computed] = await readRows(`
      SELECT CASE WHEN id = 1 THEN is_active END AS chosen, IF(id = 1, is_active, 0) AS picked, COALESCE(is_active, 0) AS filled
      FROM samples WHERE id = 1
    `);

    assert.deepEqual(united, [{ is_active: 1 }, { is_active: 0 }]);
    assert.deepEqual(aggregated, { top: 1, bottom: 0 });
    assert.deepEqual(computed, { chosen: 1, picked: 1, filled: 1 });
  });

  test('DECIMAL comes back as a number', async () => {
    const rows = await readRows('SELECT amount, amount * 2 AS doubled FROM samples ORDER BY id');

    assert.deepEqual(rows.map((row) => row.amount), [12.5, 0.1, null]);
    assert.equal(rows[0].doubled, 25);
  });

  test('a JSON column comes back parsed, with its keys as they were written', async () => {
    const rows = await readRows('SELECT profile FROM samples ORDER BY id');

    assert.deepEqual(rows.map((row) => row.profile), [
      { first_name: 'Anna', tags: ['a', 'b'], nested: { is_new: true } },
      [1, 'two', null],
      null,
    ]);
  });

  test('a JSON column comes back parsed through a derived table as well', async () => {
    const rows = await readRows('SELECT q.profile FROM (SELECT profile FROM samples WHERE id = 1) q');

    assert.deepEqual(rows[0].profile.tags, ['a', 'b']);
  });

  test('JSON mixed with a text literal comes back as text, with a JSON value it stays parsed', async () => {
    const [row] = await readRows("SELECT COALESCE(profile, '{}') AS mixed, IFNULL(profile, JSON_OBJECT()) AS filled FROM samples WHERE id = 2");

    assert.equal(row.mixed, '[1, "two", null]');
    assert.deepEqual(row.filled, [1, 'two', null]);
  });

  test('an aggregate longer than a megabyte comes back whole', async () => {
    const [row] = await readRows("SELECT JSON_ARRAYAGG(REPEAT('x', 600)) AS list, LENGTH(GROUP_CONCAT(REPEAT('y', 600))) AS size FROM seq_1_to_3000");

    assert.equal(row.list.length, 3000);
    assert.equal(row.list.at(-1).length, 600);
    assert.equal(row.size, 3000 * 600 + 2999);
  });

  test('a whole number comes back as a number while it is safe, and as text beyond that', async () => {
    const rows = await readRows('SELECT views, (SELECT COUNT(*) FROM samples) AS total FROM samples ORDER BY id');

    assert.deepEqual(rows.map((row) => row.views), [42, '9007199254740993', null]);
    assert.equal(rows[0].total, 3);
  });

  test('a UUID comes back as lower-case text with dashes, and binary data as a Buffer', async () => {
    const [row] = await readRows('SELECT ref, payload FROM samples WHERE id = 1');

    assert.equal(row.ref, '019a0000-0000-7000-8000-000000000001');
    assert.deepEqual(row.payload, Buffer.from('ab'));
  });
});

describe('db: result', { skip: testDb.skip }, () => {
  before(() => query('CREATE TABLE notes (id INT PRIMARY KEY, title VARCHAR(100) NOT NULL)'));

  test('is rows, the number of affected rows and the names of the columns, for a statement that reads', async () => {
    const result = await query('SELECT 1 AS one, 2 AS two UNION ALL SELECT 3, 4');

    assert.deepEqual(result, {
      rows: [{ one: 1, two: 2 }, { one: 3, two: 4 }],
      affectedRows: 2,
      fields: [{ name: 'one' }, { name: 'two' }],
    });
  });

  test('has no rows for a statement that writes', async () => {
    const result = await query("INSERT INTO notes (id, title) VALUES (1, 'first'), (2, 'second')");

    assert.deepEqual(result, { rows: [], affectedRows: 2, fields: [] });
  });

  test('has the written rows for a statement with RETURNING', async () => {
    const result = await query("INSERT INTO notes (id, title) VALUES (3, 'third') RETURNING id, title");

    assert.deepEqual(result, {
      rows: [{ id: 3, title: 'third' }],
      affectedRows: 1,
      fields: [{ name: 'id' }, { name: 'title' }],
    });
  });

  test('counts a row an UPDATE has found, also when it changed nothing', async () => {
    await query("INSERT INTO notes (id, title) VALUES (4, 'fourth')");

    const changed = await query("UPDATE notes SET title = 'renamed' WHERE id = 4");
    const unchanged = await query("UPDATE notes SET title = 'renamed' WHERE id = 4");
    const missing = await query("UPDATE notes SET title = 'renamed' WHERE id = 99");

    assert.deepEqual([changed.affectedRows, unchanged.affectedRows, missing.affectedRows], [1, 1, 0]);
  });

  test('refuses two statements in one call', async () => {
    await assert.rejects(query('SELECT 1; SELECT 2'), DbError);
  });
});

describe('db: result of a procedure', { skip: testDb.skip }, () => {
  before(async () => {
    await query('CREATE TABLE calls (id INT PRIMARY KEY, title VARCHAR(100) NOT NULL)');
    await query("INSERT INTO calls (id, title) VALUES (1, 'first'), (2, 'second'), (3, 'third')");
    await query('CREATE PROCEDURE read_calls(IN low INT) BEGIN SELECT id, title FROM calls WHERE id >= low ORDER BY id; END');
    await query("CREATE PROCEDURE rename_call(IN target INT) BEGIN UPDATE calls SET title = 'called' WHERE id = target; END");
    await query("CREATE PROCEDURE read_twice() BEGIN UPDATE calls SET title = 'twice' WHERE id = 3; SELECT 1 AS one; SELECT 2 AS two; END");
  });

  test('is the rows of the one result set the procedure selects', async () => {
    const expected = {
      rows: [{ id: 2, title: 'second' }, { id: 3, title: 'third' }],
      affectedRows: 2,
      fields: [{ name: 'id' }, { name: 'title' }],
    };

    assert.deepEqual(await query('CALL read_calls(:low)', { low: 2 }), expected);
    assert.deepEqual(await query('CALL read_calls(:low)', { low: 2 }, { isTimeLimited: true }), expected);
    assert.deepEqual(await query('CALL read_calls(:low)', { low: 99 }), { rows: [], affectedRows: 0, fields: expected.fields });
  });

  test('has no rows for a procedure that selects nothing', async () => {
    assert.deepEqual(await query('CALL rename_call(:target)', { target: 1 }), { rows: [], affectedRows: 1, fields: [] });
  });

  test('is refused for a procedure that selects twice, after the procedure has run', async () => {
    const sink = createLogSink();
    const single = testDb.open({ db: { connectionLimit: 1 }, logger: { level: 'info', stream: sink.stream } });

    await assert.rejects(
      single.run(() => single.db.query('CALL read_twice()')),
      (error) => error instanceof DbError && error.code === 'MULTIPLE_RESULT_SETS' && /several result sets/.test(error.message),
    );

    const { rows } = await single.run(() => single.db.query('SELECT title FROM calls WHERE id = 3'));

    assert.deepEqual(rows, [{ title: 'twice' }]);
    assert.deepEqual(sink.lines.map((line) => [line.msg, line.code]), [
      ['Database query failed', 'MULTIPLE_RESULT_SETS'],
      ['Database query', undefined],
    ]);
  });
});

describe('db: binding', { skip: testDb.skip }, () => {
  before(async () => {
    await query(`
      CREATE TABLE people (
        id INT PRIMARY KEY,
        code VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
        name VARCHAR(100) COLLATE utf8mb4_uca1400_ai_ci NOT NULL
      ) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin
    `);
    await query(`
      INSERT INTO people (id, code, name) VALUES
        (1, 'alpha', 'Anna'), (2, 'beta', 'Борис'), (3, 'gamma', '😀 Smile'), (4, 'delta', 'Dmytro'), (5, 'Привіт', 'Привіт')
    `);
  });

  test('a numeric LIMIT and OFFSET work', async () => {
    const rows = await readRows('SELECT id FROM people ORDER BY id LIMIT :limit OFFSET :offset', { limit: 2, offset: 1 });

    assert.deepEqual(rows.map((row) => row.id), [2, 3]);
  });

  test('IN (:ids) takes an array', async () => {
    const rows = await readRows('SELECT id FROM people WHERE id IN (:ids) ORDER BY id', { ids: [4, 1, 99] });

    assert.deepEqual(rows.map((row) => row.id), [1, 4]);
  });

  test('IN (:ids) with an empty array finds nothing, NOT IN (:ids) with it finds everything', async () => {
    const found = await readRows('SELECT id FROM people WHERE id IN (:ids)', { ids: [] });
    const others = await readRows('SELECT id FROM people WHERE id NOT IN (:ids) ORDER BY id', { ids: [] });

    assert.deepEqual(found, []);
    assert.deepEqual(others.map((row) => row.id), [1, 2, 3, 4, 5]);
  });

  test('IN (:ids) with an empty array locks no row: the server sees at once that nothing can match', async () => {
    const other = testDb.open({ db: { connectionLimit: 1 } });

    await other.run(() => other.db.query('SET SESSION innodb_lock_wait_timeout = 1'));

    function writeBeside(sql) {
      return run(() => withTransaction(async () => {
        await db.query(sql, { ids: [] });

        const { affectedRows } = await other.run(() => other.db.query('UPDATE people SET code = code WHERE id = 2'));

        return affectedRows;
      }));
    }

    assert.equal(await writeBeside('DELETE FROM people WHERE id IN (:ids)'), 1);
    assert.equal(await writeBeside('UPDATE people SET code = code WHERE id IN (:ids)'), 1);
    assert.equal(await writeBeside('SELECT id FROM people WHERE id IN (:ids) FOR UPDATE'), 1);
  });

  test('a name inside a comment is not a parameter', async () => {
    const rows = await readRows('SELECT id FROM people -- owner:me\nWHERE id = :id /* :block */ # :hash', { id: 2 });

    assert.deepEqual(rows, [{ id: 2 }]);
  });

  test('a question mark inside a literal or a comment stays where it is', async () => {
    const rows = await readRows("SELECT 'what?' AS text, '??' AS pair -- why?\n, :id AS id", { id: 7 });

    assert.deepEqual(rows, [{ text: 'what?', pair: '??', id: 7 }]);
  });

  test('an object in the binding is refused before any statement is sent', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'debug', stream: sink.stream } });

    await assert.rejects(
      logged.run(() => logged.db.query('SELECT id FROM people WHERE id = :id', { id: { toSqlString: () => '1 OR 1=1' } })),
      /Placeholder :id cannot be bound to a value of type object/,
    );
    await assert.rejects(
      logged.run(() => logged.db.query('SELECT id FROM people WHERE id IN (:ids)', { ids: [[1, 2]] })),
      TypeError,
    );

    assert.deepEqual(sink.lines, []);
    assert.equal(logged.db.getStats().activeCount, 0);
  });

  test('a placeholder without a value is refused, a key the statement does not use is dropped', async () => {
    await assert.rejects(query('SELECT :missing AS value'), /Placeholder :missing has no value/);

    const rows = await readRows('SELECT :used AS value', { used: 1, unused: { any: 'thing' } });

    assert.deepEqual(rows, [{ value: 1 }]);
  });

  test('Cyrillic and emoji parameters work against both kinds of text column', async () => {
    const byCode = await readRows('SELECT id FROM people WHERE code = :value', { value: 'Привіт' });
    const byName = await readRows('SELECT id FROM people WHERE name = :value', { value: 'борис' });
    const byEmoji = await readRows('SELECT id FROM people WHERE name LIKE :value', { value: '%😀%' });
    const byList = await readRows('SELECT id FROM people WHERE code IN (:values) OR name IN (:values) ORDER BY id', { values: ['😀', 'Привіт', 'Anna'] });
    const byMachineEmoji = await readRows('SELECT id FROM people WHERE code LIKE :value OR code = :value', { value: '😀' });

    assert.deepEqual(byCode, [{ id: 5 }]);
    assert.deepEqual(byName, [{ id: 2 }]);
    assert.deepEqual(byEmoji, [{ id: 3 }]);
    assert.deepEqual(byList, [{ id: 1 }, { id: 5 }]);
    assert.deepEqual(byMachineEmoji, []);
  });

  test('a value comes back exactly as it went in, whatever it holds', async () => {
    const values = [
      "a' OR 1=1 -- ",
      'a\\',
      'a\\\' OR 1=1 #',
      '"double" `back` \'single\'',
      'line\nbreak\r\ttab',
      'nul\u0000byte',
      '\u001a',
      '%_\\%',
      '',
      'Привіт 😀',
    ];
    const rows = await Promise.all(values.map((value) => readRows('SELECT :value AS value', { value })));

    assert.deepEqual(rows.map(([row]) => row.value), values);
  });

  test('every allowed type of a value reaches the server as that type', async () => {
    const [row] = await readRows(
      'SELECT :text AS text, :number AS number, :big AS big, :yes AS yes, :no AS no, :nothing AS nothing, HEX(:bytes) AS bytes, CAST(:at AS DATETIME(3)) AS at',
      {
        text: 'x',
        number: -1.5,
        big: 12345678901234567890n,
        yes: true,
        no: false,
        nothing: null,
        bytes: Buffer.from([0, 255, 39]),
        at: new Date('2026-01-02T03:04:05.678Z'),
      },
    );

    assert.deepEqual({ ...row, at: row.at.toISOString() }, {
      text: 'x',
      number: -1.5,
      big: '12345678901234567890',
      yes: 1,
      no: 0,
      nothing: null,
      bytes: '00FF27',
      at: '2026-01-02T03:04:05.678Z',
    });
  });
});

describe('db: logs', { skip: testDb.skip }, () => {
  test('writes the form of a statement at "info" and never its values', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'info', stream: sink.stream } });

    await logged.run(() => logged.db.query('SELECT :email AS email, :limit AS size', { email: SECRET, limit: 5 }));

    assert.equal(sink.lines.length, 1);
    assert.equal(sink.lines[0].msg, 'Database query');
    assert.equal(sink.lines[0].level, 30);
    assert.equal(sink.lines[0].sql, 'SELECT :email AS email, :limit AS size');
    assert.equal(sink.lines[0].rowsCount, 1);
    assert.equal(Number.isInteger(sink.lines[0].durationMs), true);
    assert.equal(JSON.stringify(sink.lines).includes(SECRET), false);
  });

  test('writes the statement with its values at "debug" only', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'debug', stream: sink.stream } });

    await logged.run(() => logged.db.query('SELECT :email AS email', { email: SECRET }));

    const [form, values] = sink.lines;

    assert.equal(sink.lines.length, 2);
    assert.equal(form.sql, 'SELECT :email AS email');
    assert.equal(values.level, 20);
    assert.equal(values.msg, 'Database query with its values');
    assert.equal(values.sql, `SELECT '${SECRET}' AS email`);
  });

  test('counts the rows a statement has written', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ logger: { level: 'info', stream: sink.stream } });

    await logged.run(async () => {
      await logged.db.query('CREATE TABLE log_rows (id INT PRIMARY KEY)');
      await logged.db.query('INSERT INTO log_rows (id) VALUES (1), (2), (3)');
    });

    assert.deepEqual(sink.lines.map((line) => line.rowsCount), [0, 3]);
  });

  test('warns about a statement that runs longer than the threshold', async () => {
    const sink = createLogSink();
    const logged = testDb.open({ db: { slowQueryThreshold: '0.5s' }, logger: { level: 'info', stream: sink.stream } });

    await logged.run(async () => {
      await logged.db.query('SELECT SLEEP(0.6) AS waited, :email AS email', { email: SECRET });
      await logged.db.query('SELECT 1 AS quick');
    });

    const [slow, quick] = sink.lines;

    assert.equal(slow.msg, 'Slow database query');
    assert.equal(slow.level, 40);
    assert.equal(slow.sql, 'SELECT SLEEP(0.6) AS waited, :email AS email');
    assert.ok(slow.durationMs >= 500);
    assert.equal(quick.msg, 'Database query');
    assert.equal(JSON.stringify(sink.lines).includes(SECRET), false);
  });

  test('does not count the wait for a connection as the time of a statement', async () => {
    const sink = createLogSink();
    const logged = testDb.open({
      db: { connectionLimit: 1, slowQueryThreshold: '0.5s' },
      logger: { level: 'info', stream: sink.stream },
    });

    await logged.run(() => Promise.all([
      logged.db.query('SELECT SLEEP(0.6) AS waited'),
      logged.db.query('SELECT 1 AS quick'),
    ]));

    assert.deepEqual(sink.lines.map((line) => line.msg), ['Slow database query', 'Database query']);
  });
});

describe('db: service', { skip: testDb.skip }, () => {
  test('verify() resolves with the version of a server that fits', async () => {
    assert.match(await db.verify(), /^\d+\.\d+\.\d+-MariaDB/);
  });

  test('verify() rejects when the session is not in UTC', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });

    await single.run(() => single.db.query("SET time_zone = '+03:00'"));

    await assert.rejects(single.db.verify(), /The database session must run in UTC, its time_zone is "\+03:00"/);
  });

  test('verify() rejects a session with a sql_mode the client cannot work under', async () => {
    await Promise.all(['NO_BACKSLASH_ESCAPES', 'EMPTY_STRING_IS_NULL', 'ANSI_QUOTES'].map(async (mode) => {
      const single = testDb.open({ db: { connectionLimit: 1 } });

      await single.run(() => single.db.query(`SET SESSION sql_mode = CONCAT(@@sql_mode, ',${mode}')`));

      await assert.rejects(single.db.verify(), new RegExp(`The sql_mode ${mode} is not supported`));
    }));
  });

  test('the session statement puts right a session that came in another state: a value cannot end its literal', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });
    const payload = "\\' OR 1=1 -- ";

    function findByToken() {
      return single.run(() => single.db.query('SELECT id FROM tokens WHERE token = :token', { token: payload }));
    }

    async function readSession() {
      const { rows } = await single.run(() => single.db.query(`
        SELECT
          @@session.sql_mode AS sqlMode,
          @@session.autocommit AS autocommit,
          @@session.lc_messages AS language,
          @@session.group_concat_max_len = @@session.max_allowed_packet AS isAggregateWhole,
          CONCAT_WS(',', @@session.character_set_client, @@session.character_set_connection, @@session.character_set_results) AS charsets,
          :empty IS NULL AS isEmptyNull
      `, { empty: '' }));

      return rows[0];
    }

    await single.run(async () => {
      await single.db.query('CREATE TABLE tokens (id INT PRIMARY KEY, token VARCHAR(100) NOT NULL)');
      await single.db.query("INSERT INTO tokens (id, token) VALUES (1, 'token-of-anna'), (2, 'token-of-borys')");
    });

    const clean = await readSession();

    await single.run(async () => {
      await single.db.query(`
        SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES,EMPTY_STRING_IS_NULL'), time_zone = '+03:00',
          autocommit = 0, lc_messages = 'uk_UA', group_concat_max_len = 1024
      `);
      await single.db.query('SET NAMES latin1');
    });

    const spoiled = await findByToken();
    const spoiledSession = await readSession();

    await single.run(() => single.db.query(SESSION_SQL));

    const pinned = await findByToken();

    assert.equal(spoiled.rows.length, 2);
    assert.equal(spoiledSession.isEmptyNull, 1);
    assert.equal(spoiledSession.charsets, 'latin1,latin1,latin1');
    assert.deepEqual(pinned.rows, []);
    assert.match(await single.db.verify(), /MariaDB/);
    assert.deepEqual(await readSession(), clean);
    assert.deepEqual({ ...clean, sqlMode: null }, {
      sqlMode: null,
      autocommit: 1,
      language: 'en_US',
      isAggregateWhole: 1,
      charsets: 'utf8mb4,utf8mb4,utf8mb4',
      isEmptyNull: 0,
    });
  });

  test('closes a connection after an error of the class 08, and keeps it after any other', async () => {
    const single = testDb.open({ db: { connectionLimit: 1 } });

    async function readConnectionId() {
      const { rows } = await single.run(() => single.db.query('SELECT CONNECTION_ID() AS id'));

      return rows[0].id;
    }

    function signal(sqlState, errno) {
      return single.run(() => single.db.query(`SIGNAL SQLSTATE '${sqlState}' SET MYSQL_ERRNO = ${errno}, MESSAGE_TEXT = 'signalled by the test'`));
    }

    const first = await readConnectionId();

    await assert.rejects(signal('45000', 1644), (error) => error instanceof DbError && !Object.hasOwn(error, 'isFatal'));

    const kept = await readConnectionId();

    await assert.rejects(signal('08S01', 1153), (error) => error instanceof DbError && error.errno === 1153 && error.isFatal === true);

    assert.equal(kept, first);
    assert.equal(single.db.getStats().activeCount, 0);
    assert.notEqual(await readConnectionId(), first);
  });

  test('ping() resolves when the server answers, without a context', async () => {
    assert.equal(await db.ping(), true);
  });

  test('getStats() tells the size of the pool and what is taken of it', async () => {
    const single = testDb.open({ db: { connectionLimit: 2, queueLimit: 3 } });
    const idle = single.db.getStats();
    const busyQuery = single.run(() => single.db.query('SELECT SLEEP(0.1) AS waited'));
    const busy = single.db.getStats();

    await busyQuery;

    assert.deepEqual(idle, {
      connectionLimit: 2,
      queueLimit: 3,
      activeCount: 0,
      queueLength: 0,
      rejectedCount: 0,
      timeoutCount: 0,
    });
    assert.deepEqual(busy, { ...idle, activeCount: 1 });
    assert.deepEqual(single.db.getStats(), idle);
  });

  test('close() ends the pool once, and a statement after it is refused', async () => {
    const closing = testDb.open();

    await closing.run(() => closing.db.query('SELECT 1'));

    assert.equal(await closing.db.close(), true);
    assert.equal(await closing.db.close(), false);
    await assert.rejects(closing.run(() => closing.db.query('SELECT 1')), DbError);
    await assert.rejects(closing.db.ping(), /Pool is closed/);
  });
});
