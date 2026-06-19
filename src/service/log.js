import { fastify } from '#core/server.js';
import { escapeTelegramMarkdown } from '#src/service/telegram.js';
import { convertStringToSeconds } from '#src/util/datetime.js';
import { hash } from '#src/util/hash.js';

export const LOG_CACHE_PREFIX = process.env.APP_LOGGER_CACHE_PREFIX || 'log:';
export const LOG_CACHE_TTL_SECONDS = convertStringToSeconds(process.env.APP_LOGGER_CACHE_TTL) || 60 * 60; // 1 hour

export async function isLogCached(payload) {
  if (!fastify.isRedisReady) {
    return false;
  }

  const cacheKey = LOG_CACHE_PREFIX + hash(payload);
  const cacheData = await fastify.redis.get(cacheKey);
  if (cacheData) {
    return true;
  }

  await fastify.redis.set(
    cacheKey,
    1,
    'EX',
    LOG_CACHE_TTL_SECONDS,
  );

  return false;
}

export function formatTelegramLogMessage({
  title = undefined,
  url = undefined,
  error = undefined,
  app = undefined,
  client = undefined,
  storage = undefined,
  request = undefined,
  footer = undefined,
} = {}) {
  const titleRow = title
    ? `${title}\n`
    : false;

  const urlRow = url
    ? `*Url:* \`${escapeTelegramMarkdown(url)}\``
    : false;

  const errorRow = error
    ? `*Error:* \`${escapeTelegramMarkdown(JSON.stringify(error, null, 2))}\``
    : false;

  const appRow = app
    ? `*App:* \`${escapeTelegramMarkdown(JSON.stringify(app, null, 2))}\``
    : false;

  const clientRow = client
    ? `*Client:* \`${escapeTelegramMarkdown(JSON.stringify(client, null, 2))}\``
    : false;

  const storageRow = client
    ? `*Storage:* \`${escapeTelegramMarkdown(JSON.stringify(storage, null, 2))}\``
    : false;

  const requestRow = request
    ? `*Request:* \`${escapeTelegramMarkdown(JSON.stringify(request, null, 2))}\``
    : false;

  const footerRow = footer
    ? `\n${footer}`
    : false;

  return [
    titleRow,
    urlRow,
    appRow,
    errorRow,
    clientRow,
    storageRow,
    requestRow,
    footerRow,
  ].filter(Boolean);
}
