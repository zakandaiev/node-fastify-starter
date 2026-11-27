import { AppError } from '#core/error/index.js';
import { ERROR_CODE } from '#enums/error-code.js';
import { buildTestApp, errorBody, successBody } from '#root/tests/helper/app.js';
import { successEnvelope } from '#schemas/common/envelope.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import zlib from 'node:zlib';

const TEXT_URL = '/api/v1/compress-probe/text';
const PING_URL = '/api/v1/system/ping';
const INVALID_URL = '/compress-probe/invalid';
const ECHO_URL = '/compress-probe/echo';

const LARGE_LENGTH = 4096;
const FILLER = 'x';

const DECODERS = Object.freeze({
  br: zlib.brotliDecompressSync,
  gzip: zlib.gunzipSync,
  deflate: zlib.inflateSync,
});

const NEGOTIATIONS = Object.freeze([
  ['br', 'br'],
  ['gzip', 'gzip'],
  ['deflate', 'deflate'],
  ['gzip, deflate, br', 'br'],
  ['gzip;q=1, br;q=0.5', 'gzip'],
]);

const TEXT_SCHEMA = Object.freeze({
  response: { 200: successEnvelope({ type: 'object', properties: { text: { type: 'string' } } }) },
});

const INVALID_ENTRIES = Object.freeze(Array.from({ length: 8 }, (item, index) => Object.freeze({
  column: `field${index}`,
  columnValue: 'y'.repeat(200),
  operator: 'type',
  operatorValue: 'integer',
})));

const ECHO_BODY = Object.freeze({ text: 'the object the compressed bytes hold' });
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

function answerText(request, reply) {
  return reply.ok({ text: FILLER.repeat(Number(request.query.length)) });
}

async function refuseAll() {
  throw new AppError(ERROR_CODE.VALIDATION_ERROR, { validation: INVALID_ENTRIES });
}

async function buildProbeApp(t, sections = {}) {
  const fastify = await buildTestApp(sections);
  const echoed = [];

  t.after(() => fastify.close());

  function echo(request) {
    echoed.push(request.body);

    return request.body;
  }

  fastify.get(TEXT_URL, { schema: TEXT_SCHEMA, security: { auth: false } }, answerText);
  fastify.get(INVALID_URL, refuseAll);
  fastify.post(ECHO_URL, echo);

  return { fastify, echoed };
}

function injectText(fastify, length, headers = {}) {
  return fastify.inject({ url: `${TEXT_URL}?length=${length}`, headers });
}

function readVary(response) {
  return String(response.headers.vary ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
}

function decode(response) {
  return JSON.parse(DECODERS[response.headers['content-encoding']](response.rawPayload));
}

describe('compress plugin: answers', () => {
  test('sends a JSON answer above compressMinBytes in the encoding Accept-Encoding asks for, the one the server prefers among equals, with Vary: accept-encoding, and it decodes to the envelope', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const responses = await Promise.all(NEGOTIATIONS.map(([acceptEncoding]) => injectText(fastify, LARGE_LENGTH, { 'accept-encoding': acceptEncoding })));

    assert.deepEqual(
      responses.map((response) => [response.statusCode, response.headers['content-encoding'], readVary(response).includes('accept-encoding')]),
      NEGOTIATIONS.map(([, encoding]) => [200, encoding, true]),
    );
    responses.forEach((response) => {
      assert.ok(response.rawPayload.length < LARGE_LENGTH);
      assert.deepEqual(decode(response), successBody(response, { text: FILLER.repeat(LARGE_LENGTH) }));
    });
  });

  test('sends an answer one byte short of compressMinBytes as it is, and compresses one of exactly that many', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const threshold = fastify.config.app.compressMinBytes;
    const envelopeBytes = Number((await injectText(fastify, 0)).headers['content-length']);
    const [below, at] = await Promise.all([threshold - 1, threshold].map((size) => injectText(fastify, size - envelopeBytes, { 'accept-encoding': 'br' })));

    assert.deepEqual([below, at].map((response) => response.headers['content-encoding']), [undefined, 'br']);
    assert.equal(below.rawPayload.length, threshold - 1);
    assert.deepEqual(below.json(), successBody(below, { text: FILLER.repeat(threshold - 1 - envelopeBytes) }));
    assert.deepEqual(decode(at), successBody(at, { text: FILLER.repeat(threshold - envelopeBytes) }));
  });

  test('takes the threshold from compressMinBytes of the config: a small answer is compressed under a smaller one', async (t) => {
    const [standard, eager] = await Promise.all([buildProbeApp(t), buildProbeApp(t, { app: { compressMinBytes: 64 } })]);
    const [standardPing, eagerPing] = await Promise.all([standard, eager].map(({ fastify }) => fastify.inject({ url: PING_URL, headers: { 'accept-encoding': 'gzip' } })));

    assert.deepEqual([standardPing, eagerPing].map((response) => response.headers['content-encoding']), [undefined, 'gzip']);
    assert.deepEqual(decode(eagerPing), successBody(eagerPing, { isAlive: true }));
  });

  test('sends a large answer as it is with Accept-Encoding identity and without Accept-Encoding', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const responses = await Promise.all([{ 'accept-encoding': 'identity' }, {}].map((headers) => injectText(fastify, LARGE_LENGTH, headers)));

    responses.forEach((response) => {
      assert.equal(response.headers['content-encoding'], undefined);
      assert.ok(response.rawPayload.length > LARGE_LENGTH);
      assert.deepEqual(response.json(), successBody(response, { text: FILLER.repeat(LARGE_LENGTH) }));
    });
  });

  test('answers the HEAD twin of a compressed GET with the headers of that GET and no body, a small one with its Content-Length', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const headers = { 'accept-encoding': 'gzip' };
    const readHead = (response) => ({
      statusCode: response.statusCode,
      encoding: response.headers['content-encoding'],
      length: response.headers['content-length'],
      isVaried: readVary(response).includes('accept-encoding'),
    });
    const [get, head] = await Promise.all(['GET', 'HEAD'].map((method) => fastify.inject({ method, url: `${TEXT_URL}?length=${LARGE_LENGTH}`, headers })));
    const [smallGet, smallHead] = await Promise.all(['GET', 'HEAD'].map((method) => fastify.inject({ method, url: `${TEXT_URL}?length=1`, headers })));

    assert.deepEqual(readHead(head), readHead(get));
    assert.equal(head.rawPayload.length, 0);
    assert.equal(get.headers['content-encoding'], 'gzip');
    assert.deepEqual(readHead(smallHead), readHead(smallGet));
    assert.equal(smallHead.headers['content-length'], String(smallGet.rawPayload.length));
  });

  test('compresses a large error answer too, and it decodes to the error envelope', async (t) => {
    const { fastify } = await buildProbeApp(t);
    const [plain, compressed] = await Promise.all([{}, { 'accept-encoding': 'gzip' }].map((headers) => fastify.inject({ url: INVALID_URL, headers })));

    assert.deepEqual([plain, compressed].map((response) => [response.statusCode, response.headers['content-encoding']]), [[422, undefined], [422, 'gzip']]);
    assert.ok(plain.rawPayload.length > fastify.config.app.compressMinBytes);
    assert.ok(compressed.rawPayload.length < plain.rawPayload.length);
    assert.deepEqual(decode(compressed), { ...errorBody(compressed, 'VALIDATION_ERROR', 'Validation error'), validation: INVALID_ENTRIES });
  });
});

describe('compress plugin: requests', () => {
  test('does not inflate a body sent with Content-Encoding gzip or deflate: its bytes are no JSON, the answer is 400 BAD_REQUEST_ERROR and the handler never gets the object they hold', async (t) => {
    const { fastify, echoed } = await buildProbeApp(t);
    const text = JSON.stringify(ECHO_BODY);
    const encoded = await Promise.all([
      ['gzip', zlib.gzipSync(text)],
      ['deflate', zlib.deflateSync(text)],
    ].map(([encoding, payload]) => fastify.inject({
      method: 'POST',
      url: ECHO_URL,
      headers: { ...JSON_HEADERS, 'content-encoding': encoding },
      payload,
    })));
    const plain = await fastify.inject({
      method: 'POST',
      url: ECHO_URL,
      headers: JSON_HEADERS,
      payload: text,
    });

    encoded.forEach((response) => {
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), errorBody(response, 'BAD_REQUEST_ERROR', 'Bad request'));
    });
    assert.equal(plain.statusCode, 200);
    assert.deepEqual(plain.json(), ECHO_BODY);
    assert.deepEqual(echoed, [ECHO_BODY]);
  });
});
