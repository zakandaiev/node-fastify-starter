import { HEADER } from '#enums/header.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The one name that tells what its header carries rather than how the header is spelled.
const RENAMED = Object.freeze({ REQUEST_ID: 'x-request-id' });

function toHeaderName(name) {
  return name.toLowerCase().replaceAll('_', '-');
}

describe('HEADER', () => {
  test('names a header in lower case, as node:http gives it in request.headers', () => {
    Object.values(HEADER).forEach((header) => assert.equal(header, header.toLowerCase()));
    assert.ok(Object.isFrozen(HEADER));
  });

  test('every name is its header in upper snake case, the id of a request aside', () => {
    Object.entries(HEADER).forEach(([name, header]) => assert.equal(header, RENAMED[name] ?? toHeaderName(name), name));
  });

  test('names the headers a stored file is answered with', () => {
    assert.deepEqual(pick(HEADER, ['CONTENT_DISPOSITION', 'CROSS_ORIGIN_RESOURCE_POLICY', 'X_CONTENT_TYPE_OPTIONS', 'X_ROBOTS_TAG']), {
      CONTENT_DISPOSITION: 'content-disposition',
      CROSS_ORIGIN_RESOURCE_POLICY: 'cross-origin-resource-policy',
      X_CONTENT_TYPE_OPTIONS: 'x-content-type-options',
      X_ROBOTS_TAG: 'x-robots-tag',
    });
  });
});
