import { handleError } from '#core/error/handler.js';
import { AppError } from '#core/error/index.js';
import { loadUniqueFields } from '#core/schema/unique.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp, errorBody, readRequestId } from '#root/tests/helper/app.js';
import { createLogSink, LOG_LEVEL } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as nextLoop } from 'node:timers/promises';

const TEAPOT_STATUS = 418;
const OVERRIDE_WARNING_CODE = 'FSTWRN004';

const REQUEST_FAILED = 'Request failed';
const HANDLER_FAILED = 'Error handler failed';

const ROUTE_TEXT = 'inner text of a route';
const HOOK_TEXT = 'inner text of a hook';

// An error that is never answered leaves inject() pending, and node:test waits for it forever.
const SUITE_OPTIONS = Object.freeze({ timeout: 15_000 });

async function startApp(t) {
  const sink = createLogSink();
  const reported = [];
  const fastify = await buildTestApp({ logger: { level: 'warn', stream: sink.stream } });

  t.after(() => fastify.close());
  fastify.addHook('onError', (request, reply, error, done) => {
    reported.push({ requestId: request.id, error });
    done();
  });

  return { fastify, sink, reported };
}

function injectAll(fastify, urls) {
  return Promise.all(urls.map((url) => fastify.inject(url)));
}

function failWith(error) {
  return async () => {
    throw error;
  };
}

function nameError(error) {
  return error.code ?? error.message;
}

function readLog(sink, response) {
  const requestId = readRequestId(response);

  return sink.lines
    .filter((line) => line.requestId === requestId)
    .map(({ level, msg, err }) => [level, msg, nameError(err)]);
}

function readReported(reported, response) {
  const requestId = readRequestId(response);

  return reported.filter((entry) => entry.requestId === requestId).map(({ error }) => nameError(error));
}

function pourTea(error, request, reply) {
  reply.code(TEAPOT_STATUS).send({ teapot: nameError(error) });
}

function assertTeapot(response, teapot) {
  assert.equal(response.statusCode, TEAPOT_STATUS);
  assert.deepEqual(response.json(), { teapot });
}

// The ways a handler hands an error on to the next one, by the URL of a route that takes each.
const DELEGATES = Object.freeze({
  '/sent': (error, request, reply) => {
    reply.send(error);
  },
  '/thrown': (error) => {
    throw error;
  },
  '/rejected': async (error) => {
    throw error;
  },
  '/returned': (error) => error,
});

// A scope of its own for each of the handlers, with a route that fails.
function declareScopes(fastify, handlers, error) {
  Object.entries(handlers).forEach(([url, handler]) => fastify.register(async (scope) => {
    scope.setErrorHandler(handler);
    scope.get(url, failWith(error));
  }));

  return Object.keys(handlers);
}

function declareRoutes(fastify, handlers, error) {
  Object.entries(handlers).forEach(([url, errorHandler]) => fastify.get(url, { errorHandler }, failWith(error)));

  return Object.keys(handlers);
}

describe('error-handler plugin', () => {
  test('is registered under the name "error-handler" and decorates the app with the unique fields of the entity schemas', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    assert.equal(fastify.hasPlugin('error-handler'), true);
    assert.deepEqual(fastify.uniqueFields, await loadUniqueFields());
    assert.equal(fastify.uniqueFields.uq_users_email, 'email');
    assert.equal(Object.isFrozen(fastify.uniqueFields), true);
  });

  test('gives the routes of an encapsulated plugin the same map', async (t) => {
    const fastify = await buildTestApp();
    t.after(() => fastify.close());

    fastify.register(async (instance) => {
      instance.get('/fields', async (request) => ({ isSame: request.server.uniqueFields === fastify.uniqueFields }));
    }, { prefix: '/scoped' });

    const response = await fastify.inject('/scoped/fields');

    assert.deepEqual(response.json(), { isSame: true });
  });

  test('raises no warning of an overridden handler, neither for that of the app nor for a scope that sets its own', async (t) => {
    const warnings = [];

    function collect({ code }) {
      warnings.push(code);
    }

    process.on('warning', collect);
    t.after(() => process.off('warning', collect));

    const { fastify } = await startApp(t);
    const [url] = declareScopes(fastify, { '/tea': pourTea }, new Error(ROUTE_TEXT));

    assertTeapot(await fastify.inject(url), ROUTE_TEXT);
    await nextLoop();

    assert.deepEqual(warnings.filter((code) => code === OVERRIDE_WARNING_CODE), []);
  });
});

describe('error-handler plugin: the handler of a scope that sets its own', SUITE_OPTIONS, () => {
  test('gets the errors of its routes, of their hooks and schemas and of the scopes inside, and none of the app around it', async (t) => {
    const { fastify } = await startApp(t);

    fastify.get('/boom', failWith(new Error(ROUTE_TEXT)));
    fastify.register(async (scope) => {
      scope.setErrorHandler(pourTea);
      scope.get('/boom', failWith(new Error(ROUTE_TEXT)));
      scope.get('/app-error', failWith(new AppError(ERROR_CODE.NO_CHANGES)));
      scope.get('/hook', { preHandler: failWith(new AppError(ERROR_CODE.AUTHORIZATION_ERROR)) }, () => ({}));
      scope.get('/schema', { schema: { querystring: { type: 'object', required: ['name'] } } }, () => ({}));
      scope.register(async (nested) => {
        nested.get('/nested', failWith(new Error(ROUTE_TEXT)));
      });
    }, { prefix: '/tea' });

    const responses = await injectAll(fastify, ['/tea/boom', '/tea/app-error', '/tea/hook', '/tea/schema', '/tea/nested']);
    const [outside, unknown] = await injectAll(fastify, ['/boom', '/tea/nope']);

    assert.deepEqual(responses.map((response) => [response.statusCode, response.json()]), [
      [TEAPOT_STATUS, { teapot: ROUTE_TEXT }],
      [TEAPOT_STATUS, { teapot: 'NO_CHANGES' }],
      [TEAPOT_STATUS, { teapot: 'AUTHORIZATION_ERROR' }],
      [TEAPOT_STATUS, { teapot: 'FST_ERR_VALIDATION' }],
      [TEAPOT_STATUS, { teapot: ROUTE_TEXT }],
    ]);
    assert.deepEqual(outside.json(), errorBody(outside, 'SERVER_ERROR', 'Server error'));
    assert.deepEqual(unknown.json(), errorBody(unknown, 'NOT_FOUND_ERROR', 'Not found'));
  });

  test('gets the failure of an onSend hook on a success body', async (t) => {
    const { fastify, sink } = await startApp(t);

    fastify.register(async (scope) => {
      scope.setErrorHandler(pourTea);
      scope.addHook('onSend', async (request, reply) => {
        if (reply.statusCode !== TEAPOT_STATUS) {
          throw new Error(HOOK_TEXT);
        }
      });
      scope.get('/success', async () => ({ isFine: true }));
    });

    assertTeapot(await fastify.inject('/success'), HOOK_TEXT);
    assert.deepEqual(sink.lines, []);
  });

  test('answers as it likes: in a later turn, with what it returns, with what it resolves to', async (t) => {
    const { fastify, sink } = await startApp(t);
    const urls = declareScopes(fastify, {
      '/later': (error, request, reply) => {
        setImmediate(() => pourTea(error, request, reply));
      },
      '/returned': (error, request, reply) => {
        reply.code(TEAPOT_STATUS);

        return { teapot: nameError(error) };
      },
      '/resolved': async (error, request, reply) => {
        await nextLoop();
        reply.code(TEAPOT_STATUS);

        return { teapot: nameError(error) };
      },
      '/resolved-reply': async (error, request, reply) => {
        await nextLoop();

        return reply.code(TEAPOT_STATUS).send({ teapot: nameError(error) });
      },
    }, new Error(ROUTE_TEXT));

    const responses = await injectAll(fastify, urls);

    responses.forEach((response) => assertTeapot(response, ROUTE_TEXT));
    assert.deepEqual(sink.lines, []);
  });

  test('may hand an error on to the app, which answers it by its own code and logs it once', async (t) => {
    const { fastify, sink, reported } = await startApp(t);
    const handlers = { ...DELEGATES, '/called': (error, request, reply) => handleError(error, request, reply) };
    const urls = declareScopes(fastify, handlers, new AppError(ERROR_CODE.NO_CHANGES));
    const responses = await injectAll(fastify, urls);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), errorBody(response, 'NO_CHANGES', 'No changes'));
      assert.deepEqual(readLog(sink, response), [[LOG_LEVEL.WARN, REQUEST_FAILED, 'NO_CHANGES']]);
      assert.deepEqual(readReported(reported, response), ['NO_CHANGES']);
    });
  });

  test('may put another error in the place of the one it got: the app answers that one', async (t) => {
    const { fastify, sink } = await startApp(t);
    const replace = failWith(new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR));
    const [url] = declareScopes(fastify, { '/replaced': replace }, new Error(ROUTE_TEXT));
    const response = await fastify.inject(url);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), errorBody(response, 'SERVICE_UNAVAILABLE_ERROR', 'Service unavailable'));
    assert.deepEqual(readLog(sink, response), [[LOG_LEVEL.WARN, REQUEST_FAILED, 'SERVICE_UNAVAILABLE_ERROR']]);
  });

  test('stands before that of the scope around it, which gets what it hands on', async (t) => {
    const { fastify } = await startApp(t);

    fastify.register(async (scope) => {
      scope.setErrorHandler(pourTea);
      declareScopes(scope, DELEGATES, new Error(ROUTE_TEXT));
    });

    const responses = await injectAll(fastify, Object.keys(DELEGATES));

    responses.forEach((response) => assertTeapot(response, ROUTE_TEXT));
  });

  test('runs once for an error, also for one it hands on', async (t) => {
    const { fastify } = await startApp(t);
    const runs = [];
    const handlers = Object.fromEntries(Object.entries(DELEGATES).map(([url, delegate]) => [url, (error, request, reply) => {
      runs.push(url);

      return delegate(error, request, reply);
    }]));

    await injectAll(fastify, declareScopes(fastify, handlers, new Error(ROUTE_TEXT)));

    assert.deepEqual(runs.sort(), Object.keys(DELEGATES).sort());
  });
});

describe('error-handler plugin: the errorHandler option of a route', SUITE_OPTIONS, () => {
  test('is the handler of that route and of its HEAD twin', async (t) => {
    const { fastify, sink } = await startApp(t);
    const [url] = declareRoutes(fastify, { '/own': pourTea }, new Error(ROUTE_TEXT));
    const response = await fastify.inject(url);
    const twin = await fastify.inject({ method: 'HEAD', url });

    assertTeapot(response, ROUTE_TEXT);
    assert.equal(twin.statusCode, TEAPOT_STATUS);
    assert.deepEqual(sink.lines, []);
  });

  test('may hand an error on to the app, which answers it by its own code and logs it once', async (t) => {
    const { fastify, sink, reported } = await startApp(t);
    const urls = declareRoutes(fastify, DELEGATES, new AppError(ERROR_CODE.NO_CHANGES));
    const responses = await injectAll(fastify, urls);

    responses.forEach((response) => {
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), errorBody(response, 'NO_CHANGES', 'No changes'));
      assert.deepEqual(readLog(sink, response), [[LOG_LEVEL.WARN, REQUEST_FAILED, 'NO_CHANGES']]);
      assert.deepEqual(readReported(reported, response), ['NO_CHANGES']);
    });
  });

  test('stands before the handler of its scope, which gets what it hands on', async (t) => {
    const { fastify } = await startApp(t);

    fastify.register(async (scope) => {
      scope.setErrorHandler(pourTea);
      declareRoutes(scope, DELEGATES, new Error(ROUTE_TEXT));
    });

    const responses = await injectAll(fastify, Object.keys(DELEGATES));

    responses.forEach((response) => assertTeapot(response, ROUTE_TEXT));
  });
});

describe('error-handler plugin: a handler of its own when an onSend hook fails on every body', SUITE_OPTIONS, () => {
  const HANDLERS = Object.freeze({ '/answered': pourTea, ...DELEGATES });

  async function startBrokenApp(t) {
    const app = await startApp(t);

    app.fastify.addHook('onSend', async () => {
      throw new Error(HOOK_TEXT);
    });

    return app;
  }

  function assertLastResort(urls, responses, { sink, reported }) {
    assert.deepEqual(
      responses.map((response, index) => ({
        url: urls[index],
        statusCode: response.statusCode,
        body: response.json(),
        lastLine: readLog(sink, response).at(-1),
        reported: readReported(reported, response),
      })),
      responses.map((response, index) => ({
        url: urls[index],
        statusCode: 500,
        body: errorBody(response, 'SERVER_ERROR', 'Server error'),
        lastLine: [LOG_LEVEL.ERROR, HANDLER_FAILED, HOOK_TEXT],
        reported: [ROUTE_TEXT],
      })),
    );
  }

  test('ends in the envelope of the last resort, not in the body of Fastify with the text of the hook: one a route has in its options', async (t) => {
    const app = await startBrokenApp(t);
    const urls = declareRoutes(app.fastify, HANDLERS, new Error(ROUTE_TEXT));

    assertLastResort(urls, await injectAll(app.fastify, urls), app);
  });

  test('ends in the envelope of the last resort, not in the body of Fastify with the text of the hook: one a scope has set', async (t) => {
    const app = await startBrokenApp(t);
    const urls = declareScopes(app.fastify, HANDLERS, new Error(ROUTE_TEXT));

    assertLastResort(urls, await injectAll(app.fastify, urls), app);
  });
});
