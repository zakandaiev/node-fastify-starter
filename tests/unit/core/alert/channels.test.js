import { discordChannel } from '#core/alert/channels/discord.js';
import { ALERT_CHANNELS, findEnabledChannels } from '#core/alert/channels/index.js';
import { slackChannel } from '#core/alert/channels/slack.js';
import { telegramChannel } from '#core/alert/channels/telegram.js';
import { webhookChannel } from '#core/alert/channels/webhook.js';
import { buildAlertMessage } from '#core/alert/message.js';
import { createContext, runInContext } from '#core/context/index.js';
import { createLogger } from '#core/logger/index.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { createAlertReceiver, TELEGRAM_TEST_ENV } from '#root/tests/helper/alert.js';
import { timeIt } from '#root/tests/helper/async.js';
import { createTestConfig } from '#root/tests/helper/config.js';
import { createLogSink, findLogLines } from '#root/tests/helper/log.js';
import { getFreePort } from '#root/tests/helper/process.js';
import { omit } from '#utils/object.js';
import { isNonEmptyString, isString } from '#utils/type.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const SEND_TIMEOUT = '0.3s';
const SEND_TIMEOUT_MS = 300;
const TIMER_TOLERANCE_MS = 50;
const HANG_CEILING_MS = 5000;

const LOOPBACK = '127.0.0.1';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const UPSTREAM_REQUEST_MESSAGE = 'Upstream request';
const UPSTREAM_FAILED_MESSAGE = 'Upstream request failed';
const MASK = '***';

const TELEGRAM_MAX_LENGTH = 4096;
const SLACK_MAX_LENGTH = 4000;
const DISCORD_MAX_LENGTH = 2000;

const BACKSLASH = '\\';
const BACKTICK = '`';
const FENCE = '```';
const LINE_BREAK = '\n';

// Built from code points: the file tools write the escape of an invisible character as the raw one.
const EMOJI = String.fromCodePoint(0x1F600);
const ACCENTED_LETTER = `e${String.fromCharCode(0x0301)}`;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);
const FAILURE_ICON = String.fromCodePoint(0x1F6A8);
const SUPPRESSED_ICON = String.fromCodePoint(0x23F3);

// What MarkdownV2 reserves outside code: one of them unescaped, and the Bot API refuses the whole message.
const TELEGRAM_RESERVED = Object.freeze(['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']);
const DISCORD_MARKDOWN = Object.freeze(['\\', '*', '_', '~', '`', '|', '>', '#', '-', '[', ']', '(', ')']);

const BOT_TOKEN = TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_BOT_TOKEN;
const NEW_CHAT_ID = -1005550001234;

const TELEGRAM_ACCEPTED = Object.freeze({ status: 200, body: { ok: true, result: { message_id: 1 } } });
const WEBHOOK_ACCEPTED = Object.freeze({ status: 204 });

const WEBHOOK_CHANNELS = Object.freeze([webhookChannel, slackChannel, discordChannel]);
const WEBHOOK_ENV_NAMES = Object.freeze({
  webhook: 'APP_ALERT_WEBHOOK_URL',
  slack: 'APP_ALERT_SLACK_URL',
  discord: 'APP_ALERT_DISCORD_URL',
});

const TELEGRAM_REFUSALS = Object.freeze([
  {
    what: 'a 401: the token is revoked', status: 401, description: 'Unauthorized', reason: 'rejected-token', envName: 'APP_ALERT_TELEGRAM_BOT_TOKEN',
  },
  {
    what: 'a 404: the token is wrong', status: 404, description: 'Not Found', reason: 'rejected-token', envName: 'APP_ALERT_TELEGRAM_BOT_TOKEN',
  },
  {
    what: 'a 400 "chat not found"', status: 400, description: 'Bad Request: chat not found', reason: 'rejected-chat', envName: 'APP_ALERT_TELEGRAM_CHAT_ID',
  },
  {
    what: 'a 403: the bot is no member of the group', status: 403, description: 'Forbidden: bot was kicked from the supergroup chat', reason: 'rejected-chat', envName: 'APP_ALERT_TELEGRAM_CHAT_ID',
  },
  {
    what: 'a 400 that tells of an upgrade to a supergroup', status: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', reason: 'chat-migrated', envName: 'APP_ALERT_TELEGRAM_CHAT_ID',
  },
  {
    what: 'a 400 "can\'t parse entities"', status: 400, description: "Bad Request: can't parse entities: Character '(' is reserved and must be escaped with the preceding '\\'", reason: 'rejected-text', envName: null,
  },
  {
    what: 'a 500', status: 500, description: 'Internal Server Error', reason: 'failed', envName: null,
  },
  {
    what: 'a 200 with "ok": false', status: 200, description: 'Bad Request: an answer of a new kind', reason: 'failed', envName: null,
  },
]);

const WEBHOOK_REFUSALS = Object.freeze([
  { status: 400, reason: 'rejected-text' },
  { status: 413, reason: 'rejected-text' },
  { status: 422, reason: 'rejected-text' },
  { status: 401, reason: 'rejected-token' },
  { status: 403, reason: 'rejected-token' },
  { status: 404, reason: 'rejected-address' },
  { status: 410, reason: 'rejected-address' },
  { status: 500, reason: 'failed' },
]);

const TELEGRAM_BLOCK_REGEXP = /^\*(\w+):\*(?: `(.*)`|\n```json\n([\s\S]*?)\n```)$/gm;
const SLACK_BLOCK_REGEXP = /^\*(\w+):\*\n```\n([\s\S]*?)\n```$/gm;
const DISCORD_BLOCK_REGEXP = /^\*\*(\w+):\*\*\n```(?:json)?\n([\s\S]*?)\n```$/gm;
const CODE_ESCAPE_REGEXP = /\\([`\\])/g;
const SLACK_ENTITY_REGEXP = /&(amp|lt|gt);/g;
const SLACK_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>' });

const PRE_ENTITY = 'pre';
const CODE_ENTITY = 'code';
const BOLD_MARK = '*';
const ESCAPABLE_MAX_CODE = 126;

const APP = createTestConfig().app;

// Every channel on, pointed at the receiver, or at "address" when one is given, such as a port nothing listens on.
function createChannelConfig(receiver, address = receiver.url) {
  return createTestConfig({
    env: {
      ...receiver.env.telegram,
      APP_ALERT_WEBHOOK_URL: `${address}${receiver.paths.webhook}`,
      APP_ALERT_SLACK_URL: `${address}${receiver.paths.slack}`,
      APP_ALERT_DISCORD_URL: `${address}${receiver.paths.discord}`,
    },
    alert: { telegramApiUrl: address, sendTimeout: SEND_TIMEOUT },
  });
}

function buildMessage(input = {}) {
  return buildAlertMessage({
    title: 'Server error (5xx)',
    space: ALERT_SPACE.INTERNAL,
    throttleClass: THROTTLE_CLASS.FAILURE,
    isSilent: false,
    ...input,
  }, APP);
}

// Every block, each with what one markup or another must escape or keep apart; short enough that nothing is cut.
function buildFullMessage() {
  const cause = new Error('Inner _*[]()~>#+-=|{}.!');
  const error = new TypeError(`Unexpected token ${BACKTICK}}${BACKTICK} in C:${BACKSLASH}app${BACKSLASH}order.js: <b>&amp;</b> ${FENCE}`, { cause });

  cause.stack = 'Error: Inner\n    at connect (db.js:1:1)';
  error.stack = 'TypeError: Unexpected token\n    at handler (order.js:2:2)';

  return buildMessage({
    url: 'https://app.test/orders/7_(draft)',
    error,
    request: {
      method: 'POST',
      protocol: 'https',
      host: 'app.test',
      url: '/orders/7',
      ip: '203.0.113.7',
      id: 'request-1',
      headers: { 'user-agent': `Mozilla/5.0 ${BACKTICK}tick${BACKTICK} ${BACKSLASH}slash` },
    },
    client: { release: '1.2.3', language: 'uk', note: `<@everyone> & ${FENCE}json` },
  });
}

// Far over the ceiling of every channel, and full of what an escape doubles or a cut could split.
function buildHugeMessage() {
  const chunk = `${BACKTICK}${BACKSLASH}${EMOJI}${ACCENTED_LETTER}<&>${FENCE}_*`;

  return {
    ...buildMessage({
      title: TELEGRAM_RESERVED.join('').repeat(20),
      url: `https://app.test/${BACKTICK.repeat(1500)}${EMOJI.repeat(200)}`,
      error: { message: chunk.repeat(1500), stack: `${FENCE}${BACKSLASH}${BACKSLASH}`.repeat(2000) },
      request: {
        method: 'GET',
        ip: '203.0.113.7',
        id: 'request-1',
        headers: { 'user-agent': chunk.repeat(100) },
      },
      client: { release: chunk.repeat(500) },
    }),
    suppressedCount: 12,
  };
}

async function createSetup(t, { respond, address } = {}) {
  const receiver = await createAlertReceiver(t, respond);
  const config = createChannelConfig(receiver, address);
  const sink = createLogSink();
  const context = createContext({ config, log: createLogger({ level: 'debug', stream: sink.stream }) });

  function send(channel, message = buildFullMessage()) {
    return runInContext(context, () => channel.send(channel.render(message), {
      settings: config.alert.channels[channel.name],
      config,
    }));
  }

  return { receiver, sink, send };
}

async function createUnreachableSetup(t) {
  return createSetup(t, { address: `http://${LOOPBACK}:${await getFreePort()}` });
}

function readLogText(sink) {
  return JSON.stringify(sink.lines);
}

function stepEscape(text, state) {
  const code = text.charCodeAt(state.index + 1);

  if (!(code >= 1 && code <= ESCAPABLE_MAX_CODE)) {
    state.problem = `the backslash at ${state.index} escapes no ASCII character`;
  }

  state.index += 2;

  return state;
}

function stepInPre(text, state) {
  if (text.startsWith(FENCE, state.index)) {
    state.entity = null;
    state.index += FENCE.length;
  } else if (text[state.index] === BACKTICK) {
    state.problem = `an unescaped backtick inside a pre block at ${state.index}`;
  } else {
    state.index += 1;
  }

  return state;
}

function stepInCode(text, state) {
  if (text[state.index] === BACKTICK) {
    state.entity = null;
  }

  state.index += 1;

  return state;
}

function stepInText(text, state) {
  const char = text[state.index];

  if (text.startsWith(FENCE, state.index)) {
    state.entity = PRE_ENTITY;
    state.index += FENCE.length;
  } else if (char === BACKTICK) {
    state.entity = CODE_ENTITY;
    state.index += 1;
  } else if (char === BOLD_MARK) {
    state.isBold = !state.isBold;
    state.index += 1;
  } else if (TELEGRAM_RESERVED.includes(char)) {
    state.problem = `the reserved "${char}" at ${state.index} is not escaped`;
  } else {
    state.index += 1;
  }

  return state;
}

function stepMarkdownV2(text, state) {
  if (text[state.index] === BACKSLASH) {
    return stepEscape(text, state);
  }

  if (state.entity === PRE_ENTITY) {
    return stepInPre(text, state);
  }

  return state.entity === CODE_ENTITY
    ? stepInCode(text, state)
    : stepInText(text, state);
}

// MarkdownV2 as the Bot API reads it: a backslash escapes one ASCII character anywhere, "```" opens and closes
// a pre block, "`" inline code and "*" bold, and any other reserved character outside code must be escaped.
function findMarkdownV2Problem(text) {
  const state = {
    index: 0,
    entity: null,
    isBold: false,
    problem: null,
  };

  while (state.index < text.length && state.problem === null) {
    stepMarkdownV2(text, state);
  }

  if (state.problem !== null) {
    return state.problem;
  }

  if (state.entity !== null) {
    return `the ${state.entity} entity is never closed`;
  }

  return state.isBold
    ? 'the bold entity is never closed'
    : null;
}

function readTelegramBlocks(text) {
  return Array.from(text.matchAll(TELEGRAM_BLOCK_REGEXP), ([, name, inline, pre]) => ({
    name,
    text: (inline ?? pre).replace(CODE_ESCAPE_REGEXP, '$1'),
  }));
}

function unbreakBacktickRuns(text) {
  return text.replaceAll(`${BACKTICK}${ZERO_WIDTH_SPACE}`, BACKTICK);
}

function readSlackBlocks(text) {
  return Array.from(text.matchAll(SLACK_BLOCK_REGEXP), ([, name, code]) => ({
    name,
    text: unbreakBacktickRuns(code).replace(SLACK_ENTITY_REGEXP, (entity, entityName) => SLACK_ENTITIES[entityName]),
  }));
}

function readDiscordBlocks(text) {
  return Array.from(text.matchAll(DISCORD_BLOCK_REGEXP), ([, name, code]) => ({ name, text: unbreakBacktickRuns(code) }));
}

// A string is written as it is, any other value as JSON: either way it reads back as the value of the webhook.
function assertSameBlocks(blocks, expected) {
  assert.deepEqual(blocks.map((block) => block.name), expected.map((block) => block.name));
  blocks.forEach((block, index) => {
    const { value } = expected[index];

    assert.deepEqual(isString(value) ? block.text : JSON.parse(block.text), value, block.name);
  });
}

function countFences(text) {
  return text.split(FENCE).length - 1;
}

function readLastLine(text) {
  return text.slice(text.lastIndexOf(LINE_BREAK) + LINE_BREAK.length);
}

describe('telegram channel: render', () => {
  test('writes MarkdownV2 with the title bold and escaped, a text block as inline code and any other as a json block', () => {
    const value = `a${BACKTICK}b${BACKSLASH}c _*[]()~>#+-=|{}.!`;
    const message = buildMessage({ error: value, client: { note: `a${BACKTICK}b${BACKSLASH}c _*()` } });

    assert.equal(telegramChannel.render(message).text, [
      `${FAILURE_ICON} *Server error \\(5xx\\)*`,
      '*App:*',
      '```json',
      JSON.stringify({ name: APP.name, version: APP.version, mode: APP.mode }, null, 2),
      FENCE,
      `*Error:* \`a${BACKSLASH}${BACKTICK}b${BACKSLASH}${BACKSLASH}c _*[]()~>#+-=|{}.!\``,
      '*Client:*',
      '```json',
      `{\n  "note": "a${BACKSLASH}${BACKTICK}b${BACKSLASH.repeat(4)}c _*()"\n}`,
      FENCE,
    ].join(LINE_BREAK));
  });

  test('escapes all 18 reserved characters of the title, and the backslash', () => {
    const message = buildMessage({ title: `Reserved ${TELEGRAM_RESERVED.join('')} and ${BACKSLASH}` });
    const escaped = TELEGRAM_RESERVED.map((char) => `${BACKSLASH}${char}`).join('');
    const [header] = telegramChannel.render(message).text.split(LINE_BREAK);

    assert.equal(header, `${FAILURE_ICON} *Reserved ${escaped} and ${BACKSLASH}${BACKSLASH}*`);
  });

  test('sends MarkdownV2 with the link preview off and the notification off only for a silent alert', () => {
    const loud = telegramChannel.render(buildMessage({ isSilent: false }));
    const silent = telegramChannel.render(buildMessage({ isSilent: true, throttleClass: THROTTLE_CLASS.SILENT }));

    assert.deepEqual(Object.keys(loud), ['text', 'parse_mode', 'disable_notification', 'link_preview_options']);
    assert.equal(loud.parse_mode, 'MarkdownV2');
    assert.equal(loud.disable_notification, false);
    assert.equal(silent.disable_notification, true);
    assert.deepEqual(loud.link_preview_options, { is_disabled: true });
  });

  test('ends with the count of the suppressed only when it is above zero', () => {
    const message = buildFullMessage();
    const { text } = telegramChannel.render({ ...message, suppressedCount: 3 });

    assert.equal(readLastLine(text), `${SUPPRESSED_ICON} *Suppressed by throttle:* 3`);
    assert.equal(telegramChannel.render(message).text.includes('Suppressed by throttle'), false);
    assert.equal(findMarkdownV2Problem(text), null);
  });

  test('reads as the Bot API does: the checker of these tests flags an entity left open and a reserved character left bare', () => {
    assert.equal(findMarkdownV2Problem(`*Bold:* \`code\`\n${FENCE}json\n{}\n${FENCE}`), null);
    assert.notEqual(findMarkdownV2Problem('*Bold'), null);
    assert.notEqual(findMarkdownV2Problem('`code'), null);
    assert.notEqual(findMarkdownV2Problem(`${FENCE}json\n{}`), null);
    assert.notEqual(findMarkdownV2Problem(`${FENCE}json\na${BACKTICK}b\n${FENCE}`), null);
    assert.notEqual(findMarkdownV2Problem('Server error (5xx)'), null);
    assert.notEqual(findMarkdownV2Problem(`ends with ${BACKSLASH}`), null);
  });

  test('cuts a huge alert to 4096 characters with every entity closed, every reserved character escaped and no lone surrogate', () => {
    const message = buildHugeMessage();
    const { text } = telegramChannel.render(message);
    const [app] = readTelegramBlocks(text);

    assert.ok(text.length <= TELEGRAM_MAX_LENGTH, `${text.length} characters`);
    assert.equal(findMarkdownV2Problem(text), null);
    assert.equal(text.isWellFormed(), true);
    assert.deepEqual(readTelegramBlocks(text).map((block) => block.name), message.blocks.map((block) => block.name));
    assert.deepEqual(JSON.parse(app.text), message.blocks[0].value, 'a short block stays whole');
    assert.equal(readLastLine(text), `${SUPPRESSED_ICON} *Suppressed by throttle:* 12`);
  });
});

describe('telegram channel: send', () => {
  test('delivers on a 200 with "ok": true, posted to /bot<token>/sendMessage with the chat id', async (t) => {
    const { receiver, send } = await createSetup(t, { respond: () => TELEGRAM_ACCEPTED });
    const message = buildFullMessage();
    const outcome = await send(telegramChannel, message);
    const [request] = receiver.requests;

    assert.deepEqual(outcome, { isDelivered: true });
    assert.equal(receiver.requests.length, 1);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, receiver.paths.telegram);
    assert.equal(request.headers['content-type'], JSON_CONTENT_TYPE);
    assert.deepEqual(request.body, { chat_id: TELEGRAM_TEST_ENV.APP_ALERT_TELEGRAM_CHAT_ID, ...telegramChannel.render(message) });
  });

  TELEGRAM_REFUSALS.forEach(({
    what,
    status,
    description,
    reason,
    envName,
  }) => {
    test(`reports ${what} as "${reason}"`, async (t) => {
      const { send } = await createSetup(t, { respond: () => ({ status, body: { ok: false, error_code: status, description } }) });
      const outcome = await send(telegramChannel);

      assert.deepEqual(omit(outcome, ['hint']), {
        isDelivered: false,
        reason,
        isRetryable: reason !== 'rejected-text',
        status,
        description,
      });
      assert.equal(isNonEmptyString(outcome.hint), true);
      assert.ok(envName === null || outcome.hint.includes(envName), outcome.hint);
    });
  });

  test('reports a group that got a new id as "chat-migrated", and passes the new id to no result and no log line', async (t) => {
    const { sink, send } = await createSetup(t, {
      respond: () => ({
        status: 400,
        body: {
          ok: false,
          error_code: 400,
          description: 'Bad Request: group chat was upgraded to a supergroup chat',
          parameters: { migrate_to_chat_id: NEW_CHAT_ID },
        },
      }),
    });
    const outcome = await send(telegramChannel);
    const digits = String(-NEW_CHAT_ID);

    assert.equal(outcome.reason, 'chat-migrated');
    assert.equal(outcome.isRetryable, true);
    assert.equal(JSON.stringify(outcome).includes(digits), false);
    assert.equal(readLogText(sink).includes(digits), false);
  });

  test('reports a 429 as "rate-limited" with the seconds the Bot API asks to wait', async (t) => {
    const { send } = await createSetup(t, {
      respond: () => ({
        status: 429,
        body: {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 7',
          parameters: { retry_after: 7 },
        },
      }),
    });
    const outcome = await send(telegramChannel);

    assert.equal(outcome.reason, 'rate-limited');
    assert.equal(outcome.status, 429);
    assert.equal(outcome.retryAfter, 7);
    assert.equal(outcome.isRetryable, true);
  });

  test('reports a 200 that is not JSON, or JSON that is no object, as "failed"', async (t) => {
    const empty = await createSetup(t, { respond: () => ({ status: 200 }) });
    const text = await createSetup(t, { respond: () => ({ status: 200, body: '<html>ok</html>' }) });

    assert.deepEqual(omit(await empty.send(telegramChannel), ['hint']), {
      isDelivered: false,
      reason: 'failed',
      isRetryable: true,
      status: 200,
    });
    assert.equal((await text.send(telegramChannel)).reason, 'failed');
  });

  test('reports a Bot API that never answers as "unreachable" once the send timeout has passed', async (t) => {
    const { receiver, send } = await createSetup(t, { respond: () => ({ isHanging: true }) });
    const { result: outcome, durationMs } = await timeIt(() => send(telegramChannel));

    assert.equal(receiver.requests.length, 1);
    assert.equal(outcome.reason, 'unreachable');
    assert.equal(outcome.description, 'timeout');
    assert.equal(outcome.isRetryable, true);
    assert.equal(isNonEmptyString(outcome.hint), true);
    assert.ok(durationMs >= SEND_TIMEOUT_MS - TIMER_TOLERANCE_MS, `${durationMs} ms`);
    assert.ok(durationMs < HANG_CEILING_MS, `${durationMs} ms`);
  });

  test('reports a Bot API on a port nothing listens on as "unreachable"', async (t) => {
    const { receiver, send } = await createUnreachableSetup(t);
    const outcome = await send(telegramChannel);

    assert.equal(outcome.reason, 'unreachable');
    assert.equal(outcome.isRetryable, true);
    assert.equal(receiver.requests.length, 0);
  });

  test('names the token in no log line and no result: the logged address says bot***', async (t) => {
    const delivered = await createSetup(t, { respond: () => TELEGRAM_ACCEPTED });
    const refused = await createSetup(t, { respond: () => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }) });
    const outcomes = [await delivered.send(telegramChannel), await refused.send(telegramChannel)];

    [delivered, refused].forEach(({ receiver, sink }) => {
      const [line] = findLogLines(sink, UPSTREAM_REQUEST_MESSAGE);

      assert.equal(line.upstream.url, `${receiver.url}/bot${MASK}/sendMessage`);
      assert.equal(line.upstream.service, 'alert-telegram');
      assert.equal(readLogText(sink).includes(BOT_TOKEN), false);
      assert.equal(readLogText(sink).includes(encodeURIComponent(BOT_TOKEN)), false);
    });
    assert.equal(JSON.stringify(outcomes).includes(BOT_TOKEN), false);
  });

  test('names the token in no log line of a send that never got an answer either', async (t) => {
    const { receiver, sink, send } = await createSetup(t, { respond: () => ({ isHanging: true }) });
    const outcome = await send(telegramChannel);
    const [line] = findLogLines(sink, UPSTREAM_FAILED_MESSAGE);

    assert.equal(line.upstream.url, `${receiver.url}/bot${MASK}/sendMessage`);
    assert.equal(line.upstream.reason, 'timeout');
    assert.equal(readLogText(sink).includes(BOT_TOKEN), false);
    assert.equal(JSON.stringify(outcome).includes(BOT_TOKEN), false);
  });
});

describe('slack channel: render', () => {
  test('writes one text with the header bold, a code block for each block and & < > escaped', () => {
    const message = buildMessage({ title: 'A & B <c>', url: 'https://app.test/a?b', error: { message: '<!channel> & <@U1>' } });
    const rendered = slackChannel.render(message);

    assert.deepEqual(Object.keys(rendered), ['text']);
    assert.equal(rendered.text, [
      `${FAILURE_ICON} *A &amp; B &lt;c&gt;*`,
      '*App:*',
      FENCE,
      JSON.stringify({ name: APP.name, version: APP.version, mode: APP.mode }, null, 2),
      FENCE,
      '*Url:*',
      FENCE,
      'https://app.test/a',
      FENCE,
      '*Error:*',
      FENCE,
      '{\n  "message": "&lt;!channel&gt; &amp; &lt;@U1&gt;"\n}',
      FENCE,
    ].join(LINE_BREAK));
  });

  test('breaks every run of three backticks inside a block, so that a value cannot close its block', () => {
    const message = buildMessage({ url: `https://app.test/${FENCE}`, error: { message: `${FENCE}\n*bold*\n${FENCE}` } });
    const { text } = slackChannel.render(message);

    assert.equal(countFences(text), 2 * message.blocks.length);
    assert.deepEqual(readSlackBlocks(text).map((block) => block.name), ['App', 'Url', 'Error']);
  });

  test('ends with the count of the suppressed only when it is above zero', () => {
    const message = buildFullMessage();

    assert.equal(readLastLine(slackChannel.render({ ...message, suppressedCount: 3 }).text), `${SUPPRESSED_ICON} *Suppressed by throttle:* 3`);
    assert.equal(slackChannel.render(message).text.includes('Suppressed by throttle'), false);
  });

  test('cuts a huge alert to 4000 characters, every block still closed and no lone surrogate', () => {
    const message = buildHugeMessage();
    const { text } = slackChannel.render(message);
    const [app] = readSlackBlocks(text);

    assert.ok(text.length <= SLACK_MAX_LENGTH, `${text.length} characters`);
    assert.equal(text.isWellFormed(), true);
    assert.equal(countFences(text), 2 * message.blocks.length);
    assert.equal(/[<>]/.test(text), false);
    assert.equal(/&(?!amp;|lt;|gt;)/.test(text), false);
    assert.deepEqual(readSlackBlocks(text).map((block) => block.name), message.blocks.map((block) => block.name));
    assert.deepEqual(JSON.parse(app.text), message.blocks[0].value, 'a short block stays whole');
    assert.equal(readLastLine(text), `${SUPPRESSED_ICON} *Suppressed by throttle:* 12`);
  });
});

describe('discord channel: render', () => {
  test('writes the content with the title bold and its markdown escaped, and turns every mention off', () => {
    const message = buildMessage({ title: `Mark ${DISCORD_MARKDOWN.join('')} @everyone`, url: 'https://app.test/a' });
    const rendered = discordChannel.render(message);
    const escaped = DISCORD_MARKDOWN.map((char) => `${BACKSLASH}${char}`).join('');

    assert.deepEqual(Object.keys(rendered), ['content', 'allowed_mentions']);
    assert.deepEqual(rendered.allowed_mentions, { parse: [] });
    assert.equal(rendered.content, [
      `${FAILURE_ICON} **Mark ${escaped} @everyone**`,
      '**App:**',
      '```json',
      JSON.stringify({ name: APP.name, version: APP.version, mode: APP.mode }, null, 2),
      FENCE,
      '**Url:**',
      FENCE,
      'https://app.test/a',
      FENCE,
    ].join(LINE_BREAK));
  });

  test('breaks every run of three backticks inside a block, so that a value cannot close its block', () => {
    const message = buildMessage({ url: `https://app.test/${FENCE}`, error: { message: `${FENCE}\n**bold**\n${FENCE}` } });
    const { content } = discordChannel.render(message);

    assert.equal(countFences(content), 2 * message.blocks.length);
    assert.deepEqual(readDiscordBlocks(content).map((block) => block.name), ['App', 'Url', 'Error']);
  });

  test('ends with the count of the suppressed only when it is above zero', () => {
    const message = buildFullMessage();

    assert.equal(readLastLine(discordChannel.render({ ...message, suppressedCount: 3 }).content), `${SUPPRESSED_ICON} **Suppressed by throttle:** 3`);
    assert.equal(discordChannel.render(message).content.includes('Suppressed by throttle'), false);
  });

  test('cuts a huge alert to 2000 characters, every block still closed and no lone surrogate', () => {
    const message = buildHugeMessage();
    const { content } = discordChannel.render(message);
    const [app] = readDiscordBlocks(content);

    assert.ok(content.length <= DISCORD_MAX_LENGTH, `${content.length} characters`);
    assert.equal(content.isWellFormed(), true);
    assert.equal(countFences(content), 2 * message.blocks.length);
    assert.deepEqual(readDiscordBlocks(content).map((block) => block.name), message.blocks.map((block) => block.name));
    assert.deepEqual(JSON.parse(app.text), message.blocks[0].value, 'a short block stays whole');
    assert.equal(readLastLine(content), `${SUPPRESSED_ICON} **Suppressed by throttle:** 12`);
  });
});

describe('webhook channel: render', () => {
  test('sends the message as it is, for the receiver to format', () => {
    const message = buildFullMessage();

    assert.deepEqual(webhookChannel.render(message), message);
    assert.deepEqual(JSON.parse(JSON.stringify(webhookChannel.render(message))), message);
  });
});

describe('the blocks of one alert in every channel', () => {
  test('are the same in the telegram text as in the webhook body, in the same order and with the same values', () => {
    const message = buildFullMessage();
    const { blocks } = webhookChannel.render(message);
    const telegramBlocks = readTelegramBlocks(telegramChannel.render(message).text);

    assert.deepEqual(blocks.map((block) => block.name), ['App', 'Url', 'Error', 'Request', 'Client']);
    assertSameBlocks(telegramBlocks, blocks);
  });

  test('are the same in the slack text and the discord content as well, a value that holds a fence included', () => {
    const message = buildFullMessage();
    const { blocks } = webhookChannel.render(message);

    assertSameBlocks(readSlackBlocks(slackChannel.render(message).text), blocks);
    assertSameBlocks(readDiscordBlocks(discordChannel.render(message).content), blocks);
  });
});

WEBHOOK_CHANNELS.forEach((channel) => {
  describe(`${channel.name} channel: send`, () => {
    [200, 204].forEach((status) => {
      test(`delivers on a ${status}, posted as JSON to its own address`, async (t) => {
        const { receiver, send } = await createSetup(t, { respond: () => (status === 204 ? { status } : { status, body: { ok: true } }) });
        const message = buildFullMessage();
        const outcome = await send(channel, message);
        const [request] = receiver.findRequests(receiver.paths[channel.name]);

        assert.deepEqual(outcome, { isDelivered: true });
        assert.equal(receiver.requests.length, 1);
        assert.equal(request.method, 'POST');
        assert.equal(request.headers['content-type'], JSON_CONTENT_TYPE);
        assert.deepEqual(request.body, JSON.parse(JSON.stringify(channel.render(message))));
      });
    });

    WEBHOOK_REFUSALS.forEach(({ status, reason }) => {
      test(`reports a ${status} as "${reason}", without the body of the refusal: a receiver may echo the alert in it`, async (t) => {
        const body = { error: `refused with ${status}` };
        const { send } = await createSetup(t, { respond: () => ({ status, body }) });
        const outcome = await send(channel);

        assert.deepEqual(omit(outcome, ['hint']), {
          isDelivered: false,
          reason,
          isRetryable: reason !== 'rejected-text',
          status,
        });
        assert.equal(isNonEmptyString(outcome.hint), true);
      });
    });

    test('reports a 429 as "rate-limited" with the seconds of its Retry-After, and leaves out one given as a date', async (t) => {
      const seconds = await createSetup(t, { respond: () => ({ status: 429, headers: { 'retry-after': '30' } }) });
      const date = await createSetup(t, { respond: () => ({ status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }) });
      const inSeconds = await seconds.send(channel);
      const atDate = await date.send(channel);

      assert.deepEqual(omit(inSeconds, ['hint']), {
        isDelivered: false,
        reason: 'rate-limited',
        isRetryable: true,
        status: 429,
        retryAfter: 30,
      });
      assert.equal(atDate.reason, 'rate-limited');
      assert.equal(Object.hasOwn(atDate, 'retryAfter'), false);
    });

    test('reports a receiver that never answers as "unreachable" once the send timeout has passed', async (t) => {
      const { send } = await createSetup(t, { respond: () => ({ isHanging: true }) });
      const { result: outcome, durationMs } = await timeIt(() => send(channel));

      assert.equal(outcome.reason, 'unreachable');
      assert.equal(outcome.description, 'timeout');
      assert.equal(outcome.isRetryable, true);
      assert.ok(durationMs >= SEND_TIMEOUT_MS - TIMER_TOLERANCE_MS, `${durationMs} ms`);
      assert.ok(durationMs < HANG_CEILING_MS, `${durationMs} ms`);
    });

    test('reports an address on a port nothing listens on as "unreachable"', async (t) => {
      const { receiver, send } = await createUnreachableSetup(t);
      const outcome = await send(channel);

      assert.equal(outcome.reason, 'unreachable');
      assert.equal(outcome.isRetryable, true);
      assert.equal(receiver.requests.length, 0);
    });

    test(`names ${WEBHOOK_ENV_NAMES[channel.name]} in the hint of a refused token, a gone address and an address out of reach`, async (t) => {
      const token = await createSetup(t, { respond: () => ({ status: 401 }) });
      const gone = await createSetup(t, { respond: () => ({ status: 410 }) });
      const unreachable = await createUnreachableSetup(t);
      const outcomes = [await token.send(channel), await gone.send(channel), await unreachable.send(channel)];

      assert.deepEqual(outcomes.map((outcome) => outcome.reason), ['rejected-token', 'rejected-address', 'unreachable']);
      outcomes.forEach((outcome) => assert.equal(outcome.hint.includes(WEBHOOK_ENV_NAMES[channel.name]), true, outcome.hint));
    });

    test('names the path of its address in no log line: the logged address is the origin and /***', async (t) => {
      const answered = await createSetup(t, { respond: () => WEBHOOK_ACCEPTED });
      const hanging = await createSetup(t, { respond: () => ({ isHanging: true }) });

      await answered.send(channel);
      await hanging.send(channel);

      const [line] = findLogLines(answered.sink, UPSTREAM_REQUEST_MESSAGE);
      const [failed] = findLogLines(hanging.sink, UPSTREAM_FAILED_MESSAGE);

      assert.equal(line.upstream.url, `${answered.receiver.url}/${MASK}`);
      assert.equal(line.upstream.service, `alert-${channel.name}`);
      assert.equal(line.upstream.status, 204);
      assert.equal(failed.upstream.url, `${hanging.receiver.url}/${MASK}`);
      [answered, hanging].forEach(({ receiver, sink }) => {
        assert.equal(readLogText(sink).includes(receiver.paths[channel.name]), false);
        assert.equal(readLogText(sink).includes(`${channel.name}-secret`), false);
      });
    });
  });
});

describe('webhook channels: a redirect', () => {
  // fetch() follows a 301, 302 or 303 of a POST with a GET that carries no body: the alert never arrives.
  [301, 302, 303, 307, 308].forEach((status) => {
    test(`counts no delivery and follows nothing when the receiver answers the POST with a ${status}`, async (t) => {
      const { receiver, send } = await createSetup(t, {
        respond: (request) => (request.method === 'POST'
          ? { status, headers: { location: '/login' } }
          : { status: 200, body: { page: 'login' } }),
      });
      const outcome = await send(webhookChannel);

      assert.deepEqual(receiver.requests.map((request) => request.method), ['POST']);
      assert.equal(outcome.isDelivered, false, `${status} reported as delivered after ${receiver.requests.map((request) => request.method).join(', ')}`);
      assert.equal(outcome.reason, 'rejected-address');
      assert.equal(outcome.isRetryable, true);
    });
  });
});

describe('findEnabledChannels', () => {
  test('finds no channel without settings', () => {
    assert.deepEqual(findEnabledChannels(createTestConfig().alert), []);
  });

  test('turns each channel on by its own settings alone', async (t) => {
    const receiver = await createAlertReceiver(t);

    ALERT_CHANNELS.forEach((channel) => {
      const found = findEnabledChannels(createTestConfig({ env: receiver.env[channel.name] }).alert);

      assert.equal(found.length, 1, channel.name);
      assert.equal(found[0], channel);
    });
  });

  test('finds all four together, in the order of ALERT_CHANNELS', async (t) => {
    const receiver = await createAlertReceiver(t);
    const found = findEnabledChannels(createChannelConfig(receiver).alert);

    assert.deepEqual(found.map((channel) => channel.name), ['telegram', 'webhook', 'slack', 'discord']);
    assert.deepEqual(found.map((channel) => channel.name), ALERT_CHANNELS.map((channel) => channel.name));
    found.forEach((channel, index) => assert.equal(channel, ALERT_CHANNELS[index]));
  });
});
