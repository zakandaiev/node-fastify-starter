import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { once } from 'node:events';
import http from 'node:http';

const LOOPBACK = '127.0.0.1';
const TELEGRAM_PATH_PREFIX = '/bot';
const WEBHOOK_PATH = '/hook/webhook-secret';
const SLACK_PATH = '/hook/slack-secret';
const DISCORD_PATH = '/hook/discord-secret';

// Never a real bot or chat: the channels of the tests point at the receiver below.
export const TELEGRAM_TEST_ENV = Object.freeze({
  APP_ALERT_TELEGRAM_BOT_TOKEN: '123456789:test-token_for-the-receiver',
  APP_ALERT_TELEGRAM_CHAT_ID: '-1001234567890',
});

// The alerts of a service that stopped and of one that slows down: a dedupe key of its own and a class each.
export function failureOf(service) {
  return { title: `${service} is down`, dedupeKey: `upstream:${service}:network` };
}

export function warningOf(service) {
  return { title: `${service} is slow`, dedupeKey: `upstream:${service}:slow`, throttleClass: THROTTLE_CLASS.WARNING };
}

// The suppressed alerts of a class that the messages of the webhook carried, together.
export function sumSuppressed(bodies, throttleClass) {
  return bodies
    .filter((body) => body.throttleClass === throttleClass)
    .reduce((total, body) => total + body.suppressedCount, 0);
}

function readBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A throttle window this short never holds an alert back: what is left out is left out by dedupe.
export const NO_THROTTLE = '0.001s';

// The answer of a webhook that takes the message.
export const ACCEPTED = Object.freeze({ status: 204 });

export function accept() {
  return ACCEPTED;
}

// What the receiver answers when a test does not: the Bot API takes the message, a webhook answers 204.
export function answerByDefault(request) {
  return request.path.startsWith(TELEGRAM_PATH_PREFIX)
    ? { status: 200, body: { ok: true, result: { message_id: 1 } } }
    : ACCEPTED;
}

export function readBlock(message, name) {
  return message.blocks.find((block) => block.name === name)?.value;
}

export function readTitles(receiver) {
  return receiver.requests.map((request) => request.body.title);
}

export function readUrls(receiver) {
  return receiver.requests.map((request) => readBlock(request.body, 'Url'));
}

// Answers the requests of these numbers, counted from 1, with "answer", and the rest by default.
export function answerOn(numbers, answer) {
  const received = { count: 0 };

  function respond(request) {
    received.count += 1;

    return numbers.includes(received.count)
      ? answer
      : answerByDefault(request);
  }

  return respond;
}

function writeAnswer(response, answer) {
  if (answer.isHanging) {
    return false;
  }

  const headers = { ...answer.headers };
  const body = answer.body === undefined
    ? ''
    : JSON.stringify(answer.body);

  if (answer.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  response.writeHead(answer.status, headers);
  response.end(body);

  return true;
}

function recordRequests(requests, respond) {
  function handleRequest(request, response) {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const received = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: readBody(Buffer.concat(chunks).toString('utf8')),
      };

      requests.push(received);
      writeAnswer(response, respond(received) ?? answerByDefault(received));
    });
  }

  return handleRequest;
}

function describeReceiver(url, requests) {
  return {
    url,
    requests,
    env: Object.freeze({
      telegram: TELEGRAM_TEST_ENV,
      webhook: Object.freeze({ APP_ALERT_WEBHOOK_URL: `${url}${WEBHOOK_PATH}` }),
      slack: Object.freeze({ APP_ALERT_SLACK_URL: `${url}${SLACK_PATH}` }),
      discord: Object.freeze({ APP_ALERT_DISCORD_URL: `${url}${DISCORD_PATH}` }),
    }),
    config: Object.freeze({ alert: { telegramApiUrl: url } }),
    paths: Object.freeze({
      telegram: `${TELEGRAM_PATH_PREFIX}${TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`,
      webhook: WEBHOOK_PATH,
      slack: SLACK_PATH,
      discord: DISCORD_PATH,
    }),
    findRequests: (path) => requests.filter((request) => request.path === path),
  };
}

// A local receiver for every channel of alerts, so that no test sends anything for real.
export async function createAlertReceiver(t, respond = answerByDefault) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(recordRequests(requests, respond));

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });

  server.listen(0, LOOPBACK);
  await once(server, 'listening');

  return describeReceiver(`http://${LOOPBACK}:${server.address().port}`, requests);
}
