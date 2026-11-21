import { loadUniqueFields } from '#core/schema/unique.js';
import { createWorkDir } from '#root/tests/helper/process.js';
import { unique as groupUnique } from '#schemas/entity/group.js';
import { unique as userUnique } from '#schemas/entity/user.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { describe, test } from 'node:test';

const PEOPLE_PROPERTIES = Object.freeze({ id: { type: 'string' }, email: { type: 'string' } });

// The modules of a directory outside the project are ES modules by this file, as those of src/schemas are.
const MODULE_PACKAGE = JSON.stringify({ type: 'module' });

function createSchemaText({ properties = PEOPLE_PROPERTIES, unique } = {}) {
  const lines = [`export const properties = ${JSON.stringify(properties)};`];

  if (unique !== undefined) {
    lines.push(`export const unique = ${JSON.stringify(unique)};`);
  }

  return lines.join('\n');
}

// "files" maps a path inside the directory to the text of the file.
async function createSchemaDir(t, files = {}) {
  const directory = await createWorkDir(t);
  const all = { 'package.json': MODULE_PACKAGE, ...files };

  await Promise.all(Object.entries(all).map(async ([name, text]) => {
    const path = nodePath.join(directory, name);

    await mkdir(nodePath.dirname(path), { recursive: true });
    await writeFile(path, text);
  }));

  return directory;
}

async function loadFrom(t, files) {
  return loadUniqueFields(await createSchemaDir(t, files));
}

describe('loadUniqueFields', () => {
  test('merges the unique maps of the entity schemas of the repository into one frozen map', async () => {
    const fields = await loadUniqueFields();

    assert.deepEqual(fields, { ...groupUnique, ...userUnique });
    assert.deepEqual(fields, { uq_groups_slug: 'slug', uq_users_email: 'email' });
    assert.equal(Object.isFrozen(fields), true);
  });

  test('takes every .js module of the directory, a schema without unique adds nothing', async (t) => {
    const fields = await loadFrom(t, {
      'people.js': createSchemaText({ unique: { uq_people_email: 'email' } }),
      'teams.js': createSchemaText({ properties: { slug: { type: 'string' } }, unique: { uq_teams_slug: 'slug', uq_teams_code: 'slug' } }),
      'notes.js': createSchemaText(),
    });

    assert.deepEqual(fields, { uq_people_email: 'email', uq_teams_slug: 'slug', uq_teams_code: 'slug' });
  });

  test('reads neither another kind of file nor a nested directory', async (t) => {
    const broken = createSchemaText({ unique: { uq_people_email: 'phone' } });
    const fields = await loadFrom(t, {
      'people.js': createSchemaText({ unique: { uq_people_email: 'email' } }),
      'people.mjs': broken,
      'people.js.bak': broken,
      'nested/people.js': broken,
    });

    assert.deepEqual(fields, { uq_people_email: 'email' });
  });

  test('gives an empty frozen map for a directory without schemas', async (t) => {
    const fields = await loadFrom(t);

    assert.deepEqual(fields, {});
    assert.equal(Object.isFrozen(fields), true);
  });

  test('refuses an index that two schemas name, and names both files', async (t) => {
    const unique = { uq_people_email: 'email' };

    await assert.rejects(
      loadFrom(t, { 'people.js': createSchemaText({ unique }), 'members.js': createSchemaText({ unique }) }),
      {
        name: 'TypeError',
        message: 'loadUniqueFields(directory): the index "uq_people_email" is in "unique" of both members.js and people.js',
      },
    );
  });

  test('refuses a field that is not a string or not an own field of the properties of its schema', async (t) => {
    const cases = [
      { unique: { uq_people_email: 1 } },
      { unique: { uq_people_email: null } },
      { unique: { uq_people_email: ['email'] } },
      { unique: { uq_people_email: 'phone' } },
      { unique: { uq_people_email: '' } },
      { unique: { uq_people_email: 'constructor' } },
      { unique: { uq_people_email: 'toString' } },
      { properties: null, unique: { uq_people_email: 'email' } },
    ];
    const results = await Promise.allSettled(cases.map((schema) => loadFrom(t, { 'people.js': createSchemaText(schema) })));

    results.forEach((result, index) => {
      assert.equal(result.status, 'rejected', String(index));
      assert.ok(result.reason instanceof TypeError, String(index));
      assert.equal(
        result.reason.message,
        'loadUniqueFields(directory): the index "uq_people_email" in "unique" of people.js must name a field of its "properties"',
        String(index),
      );
    });
  });

  test('refuses a unique that is not a map of an index to a field', async (t) => {
    const results = await Promise.allSettled([['email'], 'email', null].map((unique) => loadFrom(t, {
      'people.js': createSchemaText({ unique }),
    })));

    results.forEach((result, index) => {
      assert.equal(result.status, 'rejected', String(index));
      assert.ok(result.reason instanceof TypeError, String(index));
      assert.match(result.reason.message, /"unique" of people\.js must map the name of an index to a field of the API/, String(index));
    });
  });

  test('refuses a directory that is not given as a path, and passes on the error of one that is not there', async (t) => {
    const missing = nodePath.join(await createSchemaDir(t), 'missing');

    await Promise.all(['', 42, null].map((directory) => assert.rejects(loadUniqueFields(directory), {
      name: 'TypeError',
      message: 'loadUniqueFields(directory) requires the path of a directory',
    })));
    await assert.rejects(loadUniqueFields(missing), { code: 'ENOENT' });
  });
});
