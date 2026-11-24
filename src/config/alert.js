import { SCHEMA_LIMITS } from '#config/schema.js';

function readTelegram(env) {
  if (!env.APP_ALERT_TELEGRAM_BOT_TOKEN) {
    return null;
  }

  return Object.freeze({
    botToken: env.APP_ALERT_TELEGRAM_BOT_TOKEN,
    chatId: env.APP_ALERT_TELEGRAM_CHAT_ID,
  });
}

function readWebhook(url) {
  return url
    ? Object.freeze({ url })
    : null;
}

export function createAlertConfig(env) {
  return Object.freeze({
    // A channel is on when its settings are there; several may be on at once.
    channels: Object.freeze({
      telegram: readTelegram(env),
      webhook: readWebhook(env.APP_ALERT_WEBHOOK_URL),
      slack: readWebhook(env.APP_ALERT_SLACK_URL),
      discord: readWebhook(env.APP_ALERT_DISCORD_URL),
    }),

    telegramApiUrl: 'https://api.telegram.org',

    // The same alert again within this long is not sent: one stopped service gives one message, not hundreds.
    dedupeTtl: '1h',

    // One message for each window of a space and a class in this long; the rest are counted into the next one.
    throttleWindow: '1m',

    // How long the count of the suppressed waits for the next message of its window.
    suppressedTtl: '1d',

    // Each channel on its own: a process that fails waits for the alert that tells of it, at most this long.
    sendTimeout: '10s',

    // The state of dedupe and throttle while Redis is down, for each space.
    memoryMaxEntries: 1000,

    // The key of another app or an SSR server that sends its errors to POST /log/error, or null.
    logApiKey: env.APP_LOG_API_KEY ?? null,

    // POST /log/error: its sender is authenticated by an Origin alone, so the body is small.
    intake: Object.freeze({
      bodyLimit: SCHEMA_LIMITS.reportMaxLength,
    }),
  });
}
