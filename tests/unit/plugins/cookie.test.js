import { HTTP_STATUS } from '#enums/http-status.js';
import { buildTestApp } from '#root/tests/helper/app.js';
import { createDownEnv } from '#root/tests/helper/db.js';
import { REDIS_DOWN_ENV } from '#root/tests/helper/redis.js';
import { pick } from '#utils/object.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SIGNER_NAMES = ['signCookie', 'unsignCookie'];

async function buildApp(t) {
  const fastify = await buildTestApp({ env: { ...REDIS_DOWN_ENV, ...(await createDownEnv()) } });

  t.after(() => fastify.close());

  return fastify;
}

describe('cookie plugin', () => {
  test('is registered under the name "cookie" over the plugin of Fastify', async (t) => {
    const fastify = await buildApp(t);

    assert.deepEqual(['cookie', '@fastify/cookie'].map((name) => fastify.hasPlugin(name)), [true, true]);
  });

  test('gives a reply the ways to set a cookie and to clear it', async (t) => {
    const fastify = await buildApp(t);

    fastify.get('/probe', async (request, reply) => {
      reply.setCookie('first', 'a value', { path: '/' });
      reply.clearCookie('second', { path: '/api' });

      return reply.code(HTTP_STATUS.NO_CONTENT).send();
    });

    const { cookies } = await fastify.inject('/probe');

    assert.deepEqual(cookies.map((cookie) => pick(cookie, ['name', 'value', 'path', 'maxAge'])), [
      { name: 'first', value: 'a value', path: '/' },
      {
        name: 'second', value: '', path: '/api', maxAge: 0,
      },
    ]);
  });

  test('has no secret: nothing signs a cookie and nothing reads the signature of one', async (t) => {
    const fastify = await buildApp(t);

    SIGNER_NAMES.forEach((name) => {
      const isThere = [fastify.hasDecorator(name), fastify.hasRequestDecorator(name), fastify.hasReplyDecorator(name)];

      assert.deepEqual(isThere, [false, false, false], name);
    });
  });

  test('reads no cookie of a request whose answer sets none', async (t) => {
    const fastify = await buildApp(t);
    const seen = [];

    async function remember(request) {
      seen.push(request.cookies);
    }

    fastify.get('/probe', { onRequest: remember, onSend: remember }, () => ({}));

    await fastify.inject({ url: '/probe', cookies: { accessToken: 'access-token', hasAccess: '1' } });

    assert.deepEqual(seen, [null, null]);
  });
});
