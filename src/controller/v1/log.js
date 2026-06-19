import { formatTelegramLogMessage, isLogCached } from '#src/service/log.js';
import { replySuccess } from '#src/service/response.js';
import { createSchema } from '#src/service/schema.js';
import { sendTelegramMessage } from '#src/service/telegram.js';

// NORMALIZATION
const INPUT_COLUMNS = [
  'url',
  'error',
  'app',
  'client',
  'storage',
];

// LOG  ROUTE
export async function postLogError(request, reply) {
  const payload = {
    title: '⁉️ *Frontend error*',
    ...request.body,
  };

  const isLogAlreadyCached = await isLogCached(payload);
  if (isLogAlreadyCached) {
    const dedupeResult = {
      data: {
        isDeduped: true,
      },
    };

    return reply
      ? replySuccess(reply, dedupeResult)
      : dedupeResult;
  }

  // INIT SERVICE LIST
  const service = {};

  // TELEGRAM
  const telegramLoggerToken = process.env.APP_LOGGER_TELEGRAM_TOKEN;
  const telegramLoggerChatId = process.env.APP_LOGGER_TELEGRAM_CHAT_ID;
  const isTelegramLoggerEnabled = process.env.APP_LOGGER_TELEGRAM_ENABLE === 'true';
  if (isTelegramLoggerEnabled) {
    service.telegram = {
      send: () => sendTelegramMessage({
        token: telegramLoggerToken,
        chatId: telegramLoggerChatId,
        messageStringOrArray: formatTelegramLogMessage(payload),
      }),
      isSuccess: (result) => result?.ok === true,
    };
  }

  // ANOTHER SERVICE
  // service.anotherService = {
  //   send: () => ({ status: 'success', data: true }),
  //   isSuccess: (result) => result?.status === 'success',
  // };

  // SEND LOGS
  const serviceNames = Object.keys(service);

  const sendResults = await Promise.all(
    serviceNames.map((name) => service[name].send()),
  );

  const result = {
    data: {
      isDeduped: false,
      error: {},
    },
  };

  serviceNames.forEach((name, index) => {
    const sendResult = sendResults[index];
    const isSuccess = service[name].isSuccess(sendResult);

    result.data[name] = isSuccess;
    result.data.error[name] = isSuccess ? undefined : sendResult;
  });

  return reply
    ? replySuccess(reply, result)
    : result;
}

export const postLogErrorSchema = createSchema('log')
  .body(INPUT_COLUMNS, ['url', 'error', 'app'])
  .defaultResponses({
    exclude: [401, 403],
  })
  .response(200, {
    dataExampleKeys: ['isDeduped', 'telegram', 'anotherService'],
  })
  .meta({
    tags: ['Log', 'v1'],
    summary: 'Log frontend error',
    description: 'Notifies about frontend error to telegram group. Requires frontend origin in headers',
  })
  .build();
