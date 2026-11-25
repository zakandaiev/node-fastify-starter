import { readLru, writeLru } from '#utils/lru.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const NOW = 1000;
const LATER = 2000;
const ROOM = 10;

function write(entries, key, options = {}) {
  return writeLru(entries, key, `value of ${key}`, { until: LATER, maxEntries: ROOM, ...options });
}

function readKeys(entries) {
  return [...entries.keys()];
}

describe('readLru', () => {
  test('gives the value of an entry until the moment it ends, and undefined from that moment on', () => {
    const entries = new Map();

    write(entries, 'a');

    assert.equal(readLru(entries, 'a', NOW), 'value of a');
    assert.equal(readLru(entries, 'a', LATER - 1), 'value of a');
    assert.equal(readLru(entries, 'a', LATER), undefined);
  });

  test('drops an entry that has ended, and a key that was never there leaves nothing behind', () => {
    const entries = new Map();

    write(entries, 'a');
    readLru(entries, 'a', LATER);
    readLru(entries, 'b', NOW);

    assert.equal(entries.size, 0);
  });

  test('gives back a value that is false, null or zero as it was written', () => {
    const entries = new Map();

    [false, null, 0].forEach((value) => {
      writeLru(entries, 'a', value, { until: LATER, maxEntries: ROOM });

      assert.equal(readLru(entries, 'a', NOW), value);
    });
  });

  test('requires a map and the time now', () => {
    assert.throws(() => readLru({}, 'a', NOW), /readLru\(entries, key, now\) requires a Map of entries/);
    assert.throws(() => readLru(new Map(), 'a'), /readLru\(entries, key, now\) requires the time now/);
    assert.throws(() => readLru(new Map(), 'a', Number.NaN), /requires the time now/);
  });
});

describe('writeLru', () => {
  test('once the map is full, gives up the entry read longest ago', () => {
    const entries = new Map();

    ['a', 'b', 'c'].forEach((key) => write(entries, key, { maxEntries: 3 }));
    readLru(entries, 'a', NOW);
    write(entries, 'd', { maxEntries: 3 });

    assert.deepEqual(readKeys(entries), ['c', 'a', 'd']);
  });

  test('a key that is there takes its new value and its new end, and drops no other', () => {
    const entries = new Map();

    ['a', 'b'].forEach((key) => write(entries, key, { maxEntries: 2 }));
    writeLru(entries, 'a', 'new', { until: LATER + 1, maxEntries: 2 });

    assert.deepEqual(readKeys(entries), ['b', 'a']);
    assert.equal(readLru(entries, 'a', LATER), 'new');
  });

  test('a key written again is the last to be given up, and a full map drops no other for it, also where it is the newest one already', () => {
    const full = new Map();
    const roomy = new Map();

    ['a', 'b', 'b'].forEach((key) => write(full, key, { maxEntries: 2 }));
    ['a', 'b', 'a'].forEach((key) => write(roomy, key));

    assert.deepEqual(readKeys(full), ['a', 'b']);
    assert.deepEqual(readKeys(roomy), ['b', 'a']);
  });

  test('requires a map, the time the entry ends at and a ceiling above zero', () => {
    const refusal = /writeLru\(entries, key, value, \{ until, maxEntries \}\) requires the time the entry ends at and a ceiling of entries above zero/;

    assert.throws(() => write({}, 'a'), /requires a Map of entries/);
    assert.throws(() => write(new Map(), 'a', { until: undefined }), refusal);
    assert.throws(() => write(new Map(), 'a', { until: Infinity }), refusal);
    assert.throws(() => write(new Map(), 'a', { maxEntries: 0 }), refusal);
    assert.throws(() => writeLru(new Map(), 'a', 'value'), refusal);
  });
});
