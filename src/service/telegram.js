import { fastify } from '#core/server.js';
import { isArray, toString } from '#src/util/misc.js';
import { request } from '#src/util/request.js';

export const TELEGRAM_BOT_API = 'https://api.telegram.org/bot';

export function escapeTelegramMarkdown(message) {
  return toString(message).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function truncateTelegramMarkdown(message, maxLength = 4096) {
  if (message.length <= maxLength) {
    return message;
  }

  const truncateTag = `_${escapeTelegramMarkdown('...[truncated]')}_`;

  const stripDanglingEscape = (str) => {
    let n = 0;
    while (str[str.length - 1 - n] === '\\') {
      n += 1;
    }
    return n % 2 === 1
      ? str.slice(0, -1)
      : str;
  };

  let truncated = stripDanglingEscape(message.slice(0, maxLength - truncateTag.length));

  const tokenStack = [];
  const symmetricTokens = new Set(['*', '_', '~', '`']);

  let openLinkIndex = -1;
  let isInUrl = false;

  for (let i = 0; i < truncated.length; i += 1) {
    const ch = truncated[i];

    if (tokenStack[tokenStack.length - 1] === '`') {
      if (ch === '`') {
        tokenStack.pop();
      }
    } else if (ch === '\\') {
      i += 1;
    } else if (isInUrl) {
      if (ch === ')') {
        isInUrl = false;
        openLinkIndex = -1;
      }
    } else if (openLinkIndex !== -1) {
      if (ch === ']' && truncated[i + 1] === '(') {
        isInUrl = true;
        i += 1;
      }
    } else if (ch === '[') {
      openLinkIndex = i;
    } else if (symmetricTokens.has(ch)) {
      if (tokenStack[tokenStack.length - 1] === ch) {
        tokenStack.pop();
      } else {
        tokenStack.push(ch);
      }
    }
  }

  if (openLinkIndex !== -1) {
    truncated = stripDanglingEscape(truncated.slice(0, openLinkIndex));
  }

  while (tokenStack.length) {
    truncated += tokenStack.pop();
  }

  return truncated + truncateTag;
}

export async function getTelegramBotUpdates(token) {
  if (!token) {
    return false;
  }

  const resource = `${TELEGRAM_BOT_API}${token}/getUpdates`;
  const options = {
    method: 'GET',
  };

  const startTime = performance.now();
  const result = await request(resource, options);
  const endTime = performance.now();

  fastify.log.info({
    resource: resource.replace(token, '[hidden]'),
    options,
    code: result.code,
    resultTime: endTime - startTime,
  }, 'Telegram API request');

  const isSuccess = result.code === 200
    ? true
    : false;

  if (isSuccess) {
    return result;
  }

  return {
    status: 'error',
    message: 'Telegram API failed',
    data: process.env.APP_MODE === 'dev'
      ? result
      : 'TELEGRAM_API_FAILED',
  };
}

export async function sendTelegramMessage({
  token = undefined,
  chatId = undefined,
  messageStringOrArray = undefined,
  messageMaxLength = 4096,
  overwriteOptions = {},
} = {}) {
  if (!token || !chatId || !messageStringOrArray) {
    return false;
  }

  const messageRows = isArray(messageStringOrArray)
    ? [...messageStringOrArray]
    : [messageStringOrArray];

  let message = messageRows
    .filter(Boolean)
    .reduce((acc, cur) => {
      acc += `${cur}\n`;
      return acc;
    }, '')
    .trim();

  if (!message.length) {
    return false;
  }

  message = truncateTelegramMarkdown(message, messageMaxLength);

  const resource = `${TELEGRAM_BOT_API}${token}/sendMessage`;
  const options = {
    method: 'POST',
    body: {
      chat_id: chatId,
      disable_web_page_preview: true,
      parse_mode: 'MarkdownV2',
      text: message,
      ...overwriteOptions,
    },
  };

  const startTime = performance.now();
  const result = await request(resource, options);
  const endTime = performance.now();

  fastify.log.info({
    resource: resource.replace(token, '[hidden]'),
    options,
    code: result.code,
    resultTime: endTime - startTime,
  }, 'Telegram API request');

  const isSuccess = result.code === 200
    ? true
    : false;

  if (isSuccess) {
    return result;
  }

  return {
    status: 'error',
    message: 'Telegram API failed',
    data: process.env.APP_MODE === 'dev'
      ? result
      : 'TELEGRAM_API_FAILED',
  };
}
