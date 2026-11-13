import { getServiceAddress, getServiceSkip, readGreeting } from '#root/tests/helper/service.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const skip = await getServiceSkip(['mariadb', 'redis']);

describe('local services', { skip }, () => {
  test('MariaDB greets a new connection', async () => {
    assert.match(await readGreeting(getServiceAddress('mariadb')), /MariaDB/);
  });

  test('Redis answers a command', async () => {
    assert.match(await readGreeting(getServiceAddress('redis'), 'PING\r\n'), /^(\+PONG|-NOAUTH)/);
  });
});
