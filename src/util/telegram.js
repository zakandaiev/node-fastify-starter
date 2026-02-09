import { request } from '#src/util/request.js';

// BOT UPDATES
// https://api.telegram.org/bot${process.env.APP_TELEGRAM_BOT_TOKEN}/getUpdates

async function sendTelegramMessage(chatId, msgStringOrArray) {
  if (!chatId || !msgStringOrArray) {
    return false;
  }

  const telegramBotApi = process.env.APP_TELEGRAM_BOT_API;
  const telegramBotToken = process.env.APP_TELEGRAM_BOT_TOKEN;
  if (!telegramBotApi || !telegramBotToken) {
    return false;
  }

  const messageRows = Array.isArray(msgStringOrArray)
    ? [...msgStringOrArray]
    : [msgStringOrArray];

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

  const messageMaxLength = 4096;
  const messageTruncateTag = '\n...[truncated]';
  if (message.length >= messageMaxLength) {
    message = message.slice(0, messageMaxLength - messageTruncateTag.length) + messageTruncateTag;
  }

  const url = `${telegramBotApi}${telegramBotToken}/sendMessage`;
  const options = {
    method: 'POST',
    body: {
      chat_id: chatId,
      disable_web_page_preview: true,
      parse_mode: 'markdownv2',
      text: message,
    },
  };

  const result = await request(url, options);

  return result.code === 200;
}

export {
  // eslint-disable-next-line
  sendTelegramMessage
};
