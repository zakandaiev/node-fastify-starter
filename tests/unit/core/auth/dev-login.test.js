import { signInForDev } from '#core/auth/dev-login.js';
import { buildDownApp, runInApp, TEST_CLIENT } from '#root/tests/helper/session.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const DEV_ENV = Object.freeze({ APP_MODE: 'dev' });
const EMAIL = 'anna@example.com';

const DEV_ONLY_MESSAGE = 'signInForDev({ email, client, request }) signs in by an email alone: it runs in dev mode only, APP_MODE=dev';

// The database of these apps is down: a call that reached a statement would fail with its error instead.
describe('signInForDev: a call it refuses before any statement', () => {
  test('is any call outside dev mode', async (t) => {
    const fastify = await buildDownApp(t);
    const calls = [{ email: EMAIL, client: TEST_CLIENT }, {}, undefined];

    await Promise.all(calls.map((options) => assert.rejects(
      runInApp(fastify, () => signInForDev(options)),
      (error) => error.constructor === Error && error.message === DEV_ONLY_MESSAGE,
    )));
  });

  test('is one without an email or without the client of its request, in dev mode', async (t) => {
    const fastify = await buildDownApp(t, { env: DEV_ENV });
    const cases = [
      [{ client: TEST_CLIENT }, /requires an email/],
      [{ email: 'not-an-email', client: TEST_CLIENT }, /requires an email/],
      [{ email: ` ${EMAIL}@`, client: TEST_CLIENT }, /requires an email/],
      [{ email: EMAIL }, /requires the client of the request: readClient\(request\)/],
      [{ email: EMAIL, client: 'client' }, /requires the client of the request: readClient\(request\)/],
    ];

    await Promise.all(cases.map(([options, refusal]) => assert.rejects(
      runInApp(fastify, () => signInForDev(options)),
      (error) => error instanceof TypeError && refusal.test(error.message),
    )));
  });
});
