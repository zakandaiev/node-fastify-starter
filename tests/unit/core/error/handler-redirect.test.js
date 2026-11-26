import { DbError } from '#core/db/error.js';
import { AppError } from '#core/error/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp, readRequestId } from '#root/tests/helper/app.js';
import { createLogSink, LOG_LEVEL } from '#root/tests/helper/log.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const FAILURE_PATH = '/auth/login';
const NO_STORE = 'no-store';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const REQUEST_FAILED = 'Request failed';
const HANDLER_FAILED = 'Error handler failed';

const STATE_COOKIE = 'oauthState';
const CALLBACK_PATH = '/callback';

// An error that is never answered leaves inject() pending, and node:test waits for it forever.
const SUITE_OPTIONS = Object.freeze({ timeout: 15_000 });

function toFailureLocation(code) {
  return `${FAILURE_PATH}?authError=${code}`;
}

// The app with a hook of its own beside the one of the alerts: what an onError hook sees, by the id of the request.
async function startApp(t) {
  const sink = createLogSink();
  const reported = [];
  const fastify = await buildTestApp({ logger: { level: 'info', stream: sink.stream } });

  t.after(() => fastify.close());
  fastify.addHook('onError', (request, reply, error, done) => {
    reported.push({ requestId: request.id, error });
    done();
  });

  return { fastify, sink, reported };
}

function declareFailingRoute(fastify, url, error, failureLocation = toFailureLocation) {
  fastify.get(url, { config: { failureLocation } }, async () => {
    throw error;
  });
}

function readProblems(sink, response) {
  const requestId = readRequestId(response);

  return sink.lines
    .filter((line) => line.requestId === requestId && line.level >= LOG_LEVEL.WARN)
    .map(({ level, msg, err }) => [level, msg, err.code ?? err.message]);
}

// The requests go side by side, and the calls come in the order they end.
function keyByUrl(calls) {
  return Object.fromEntries(calls.map((call) => [call.url, call]));
}

function describeRedirect(response) {
  return {
    statusCode: response.statusCode,
    location: response.headers.location,
    cacheControl: response.headers['cache-control'],
    contentType: response.headers['content-type'],
    body: response.body,
  };
}

describe('handleError: a route that names its failureLocation', SUITE_OPTIONS, () => {
  test('answers a failure with a 302 to the location it gives for the code of the failure, under the id of the request, with no-store and no body', async (t) => {
    const { fastify } = await startApp(t);

    declareFailingRoute(fastify, CALLBACK_PATH, new AppError(ERROR_CODE.AUTHENTICATION_ERROR));

    const response = await fastify.inject(CALLBACK_PATH);

    assert.deepEqual(describeRedirect(response), {
      statusCode: 302,
      location: '/auth/login?authError=AUTHENTICATION_ERROR',
      cacheControl: NO_STORE,
      contentType: undefined,
      body: '',
    });
    assert.equal(response.headers['content-length'], '0');
    readRequestId(response);
  });

  test('gives the location the code the JSON answer would carry and the request it fails', async (t) => {
    const { fastify } = await startApp(t);
    const calls = [];
    const errors = {
      '/app-error': new AppError(ERROR_CODE.UPSTREAM_ERROR),
      '/foreign': new Error('inner text of a route'),
      '/duplicate': new DbError("Duplicate entry '***' for key 'uq_users_email'", { kind: DB_ERROR_KIND.UNIQUE, constraint: 'uq_users_email' }),
      '/unavailable': new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR),
    };

    function recordLocation(code, request) {
      calls.push({ code, requestId: request.id, url: request.routeOptions.url });

      return toFailureLocation(code);
    }

    Object.entries(errors).forEach(([url, error]) => declareFailingRoute(fastify, url, error, recordLocation));
    fastify.get('/invalid', {
      config: { failureLocation: recordLocation },
      schema: { querystring: { type: 'object', properties: { code: { type: 'string', maxLength: 4 } } } },
    }, async () => ({ isReached: true }));

    const urls = [...Object.keys(errors), '/invalid?code=too-long'];
    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));
    const codes = ['UPSTREAM_ERROR', 'SERVER_ERROR', 'VALIDATION_ERROR', 'SERVICE_UNAVAILABLE_ERROR', 'VALIDATION_ERROR'];

    assert.deepEqual(responses.map((response) => response.statusCode), urls.map(() => 302));
    assert.deepEqual(responses.map((response) => response.headers.location), codes.map(toFailureLocation));
    assert.deepEqual(keyByUrl(calls), keyByUrl(responses.map((response, index) => ({
      code: codes[index],
      requestId: readRequestId(response),
      url: urls[index].split('?')[0],
    }))));
  });

  test('copies no header of the error and adds none of its own: neither the challenge of a 401 nor a Retry-After of a 503', async (t) => {
    const { fastify } = await startApp(t);
    const challenge = { headers: { 'www-authenticate': 'Bearer', 'x-detail': 'of the error' } };

    declareFailingRoute(fastify, '/challenged', new AppError(ERROR_CODE.AUTHENTICATION_ERROR, challenge));
    declareFailingRoute(fastify, '/unavailable', new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR, { headers: { 'retry-after': '30' } }));
    declareFailingRoute(fastify, '/overloaded', new AppError(ERROR_CODE.SERVICE_UNAVAILABLE_ERROR));

    const responses = await Promise.all(['/challenged', '/unavailable', '/overloaded'].map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 302);
      ['www-authenticate', 'x-detail', 'retry-after'].forEach((name) => assert.equal(response.headers[name], undefined, name));
    });
  });

  test('keeps the cookies the route set or cleared before it failed, and drops the type of the body it meant to send', async (t) => {
    const { fastify } = await startApp(t);

    fastify.get(CALLBACK_PATH, { config: { failureLocation: toFailureLocation } }, async (request, reply) => {
      reply.clearCookie(STATE_COOKIE, { path: CALLBACK_PATH, httpOnly: true });
      reply.type(JSON_CONTENT_TYPE);

      throw new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
    });

    const response = await fastify.inject(CALLBACK_PATH);

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers['content-type'], undefined);
    assert.deepEqual(response.cookies.map(({ name, value, path }) => ({ name, value, path })), [
      { name: STATE_COOKIE, value: '', path: CALLBACK_PATH },
    ]);
  });

  test('logs the failure and hands it to the onError hooks once, as a JSON answer does', async (t) => {
    const { fastify, sink, reported } = await startApp(t);
    const refusal = new AppError(ERROR_CODE.AUTHENTICATION_ERROR);
    const fault = new AppError(ERROR_CODE.UPSTREAM_ERROR);

    declareFailingRoute(fastify, '/refused', refusal);
    declareFailingRoute(fastify, '/fault', fault);

    const [refused, failed] = await Promise.all(['/refused', '/fault'].map((url) => fastify.inject(url)));

    assert.deepEqual(readProblems(sink, refused), [[LOG_LEVEL.WARN, REQUEST_FAILED, 'AUTHENTICATION_ERROR']]);
    assert.deepEqual(readProblems(sink, failed), [[LOG_LEVEL.ERROR, REQUEST_FAILED, 'UPSTREAM_ERROR']]);
    assert.deepEqual(reported.filter((entry) => entry.requestId === readRequestId(refused)).map((entry) => entry.error), [refusal]);
    assert.deepEqual(reported.filter((entry) => entry.requestId === readRequestId(failed)).map((entry) => entry.error), [fault]);
  });

  test('leaves a route without failureLocation, or with one that is not a function, on the JSON envelope', async (t) => {
    const { fastify } = await startApp(t);
    const error = new AppError(ERROR_CODE.AUTHENTICATION_ERROR);

    fastify.get('/plain', async () => {
      throw error;
    });
    declareFailingRoute(fastify, '/text', error, FAILURE_PATH);

    const responses = await Promise.all(['/plain', '/text'].map((url) => fastify.inject(url)));

    responses.forEach((response) => {
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE);
      assert.equal(response.headers.location, undefined);
      assert.equal(response.json().code, 'AUTHENTICATION_ERROR');
    });
  });

  test('falls back to the raw answer of a failed handler when failureLocation throws or gives no location a header takes', async (t) => {
    const { fastify, sink } = await startApp(t);
    const locations = {
      '/thrown': () => {
        throw new Error('the location failed');
      },
      '/empty': () => '',
      '/object': () => ({ path: FAILURE_PATH }),
      '/line-break': () => `${FAILURE_PATH}\r\nset-cookie: a=b`,
    };

    Object.entries(locations).forEach(([url, failureLocation]) => {
      declareFailingRoute(fastify, url, new AppError(ERROR_CODE.AUTHENTICATION_ERROR), failureLocation);
    });

    const urls = Object.keys(locations);
    const responses = await Promise.all(urls.map((url) => fastify.inject(url)));

    responses.forEach((response, index) => {
      const problems = readProblems(sink, response);

      assert.equal(response.statusCode, 401, urls[index]);
      assert.equal(response.headers['content-type'], JSON_CONTENT_TYPE, urls[index]);
      assert.equal(response.headers.location, undefined, urls[index]);
      assert.equal(response.headers['set-cookie'], undefined, urls[index]);
      assert.equal(response.json().code, 'BAD_REQUEST_ERROR', urls[index]);
      assert.deepEqual(problems.map(([level, msg]) => [level, msg]), [[LOG_LEVEL.WARN, REQUEST_FAILED], [LOG_LEVEL.ERROR, HANDLER_FAILED]], urls[index]);
    });
  });
});
