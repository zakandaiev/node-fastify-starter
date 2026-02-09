import { replyError, replySuccess } from '#src/util/response.js';
import { generateSchema } from '#src/util/schema.js';
import { sendTelegramMessage } from '#src/util/telegram.js';

async function logErrorToTelegram(payload = {}) {
  const telegramLoggerChatId = process.env.APP_TELEGRAM_LOGGER_CHAT_ID;
  const isLoggerEnabled = process.env.APP_TELEGRAM_LOGGER_ENABLE === 'true';
  if (!telegramLoggerChatId || !isLoggerEnabled) {
    return false;
  }

  const {
    url,
    error,
    app,
    client,
  } = payload;
  if (!url || !error) {
    return false;
  }

  const titleRow = '⁉️ *Error*\n';
  const fromRow = '*From:* `FrontEnd`';
  const urlRow = `*Url:* \`${url}\``;
  const errorRow = `*Error:*\n\`${JSON.stringify(error, null, 2)}\``;
  const appRow = app ? `*App:*\n\`${JSON.stringify(app, null, 2)}\`` : false;
  const clientRow = client ? `*Client:*\n\`${JSON.stringify(client, null, 2)}\`` : false;

  const messageRows = [titleRow, fromRow, urlRow, appRow, errorRow, clientRow];
  const result = await sendTelegramMessage(telegramLoggerChatId, messageRows);
  return result.code === 200;
}

// POST LOG ERROR
async function postLogError(request, reply) {
  const result = await logErrorToTelegram(request.body);
  if (!result) {
    return replyError(reply, {
      code: 502,
      message: 'Telegram API failed',
      data: 'TELEGRAM_API_FAILED',
    });
  }

  return replySuccess(reply, {
    data: result,
  });
}
const postLogErrorSchema = generateSchema(
  'log',
  {
    bodyKeys: ['app', 'client', 'error', 'url'],
    bodyRequiredKeys: ['error', 'url'],
    responseCodeKeys: [200, 500],
    responseCodeOverwrite: {
      200: {
        dataExample: true,
      },
    },
    overwrite: {
      tags: ['Log'],
      summary: 'Log frontend error',
      description: 'Notifies about frontend error to telegram group. Requires frontend origin in headers',
    },
  },
);

export {
  logErrorToTelegram,
  postLogError,
  postLogErrorSchema,
};
