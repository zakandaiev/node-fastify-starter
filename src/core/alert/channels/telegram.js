import {
  delivered,
  DELIVERY_FAILURE,
  describeUnreachable,
  notDelivered,
} from '#core/alert/channels/delivery.js';
import {
  readFooter,
  renderBlocks,
  SUPPRESSED_ICON,
  SUPPRESSED_LABEL,
} from '#core/alert/channels/markup.js';
import { fetchUpstream } from '#core/http/index.js';
import { ALERT_CHANNEL } from '#enums/alert-channel.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';
import { isString, parseJsonObject } from '#utils/type.js';

// sendMessage of the Bot API takes 4096 characters after the markup is parsed: the raw text is counted, which is longer.
const MAX_LENGTH = 4096;
const PARSE_MODE = 'MarkdownV2';

const SERVICE = 'alert-telegram';

// One character of these left unescaped, and Telegram refuses the whole message with "can't parse entities".
const TEXT_SPECIAL_REGEXP = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const CODE_SPECIAL_REGEXP = /[`\\]/g;
const ESCAPE = '\\$&';

const TOKEN_REJECTED_STATUSES = Object.freeze([HTTP_STATUS.UNAUTHORIZED, HTTP_STATUS.NOT_FOUND]);

// Matched as fragments of the description in lower case: only a refusal of the text itself is final.
const MIGRATED_DESCRIPTIONS = Object.freeze(['upgraded to a supergroup']);
const INVALID_CHAT_DESCRIPTIONS = Object.freeze([
  'chat not found',
  'user not found',
  'peer_id_invalid',
  'chat_id is empty',
  'not enough rights',
  'have no rights',
]);
const REJECTED_TEXT_DESCRIPTIONS = Object.freeze([
  "can't parse entities",
  'message is too long',
  'message text is empty',
  'text must be non-empty',
  'must be encoded in utf-8',
]);

const HINTS = Object.freeze({
  [DELIVERY_FAILURE.UNREACHABLE]: 'the Bot API cannot be reached from here: network, DNS or the deadline',
  [DELIVERY_FAILURE.REJECTED_TOKEN]: 'the bot token in APP_ALERT_TELEGRAM_BOT_TOKEN is revoked or wrong',
  [DELIVERY_FAILURE.CHAT_MIGRATED]: 'the group was upgraded to a supergroup and got a new id: put it into APP_ALERT_TELEGRAM_CHAT_ID and restart',
  [DELIVERY_FAILURE.REJECTED_CHAT]: 'check APP_ALERT_TELEGRAM_CHAT_ID and that the bot is still a member of the group',
  [DELIVERY_FAILURE.REJECTED_TEXT]: 'Telegram refused the text itself, a bug of its render: the same alert would fail again, so its dedupe key is kept',
  [DELIVERY_FAILURE.RATE_LIMITED]: 'Telegram asks to wait before the next message',
  [DELIVERY_FAILURE.FAILED]: 'Telegram refused the message for a reason of its own',
});

function escapeText(text) {
  return text.replace(TEXT_SPECIAL_REGEXP, ESCAPE);
}

function escapeCode(text) {
  return text.replace(CODE_SPECIAL_REGEXP, ESCAPE);
}

function measureCode(text) {
  return text.length + (text.match(CODE_SPECIAL_REGEXP)?.length ?? 0);
}

function frameBlock(block) {
  return isString(block.value)
    ? { before: `*${block.name}:* \``, after: '`' }
    : { before: `*${block.name}:*\n\`\`\`json\n`, after: '\n```' };
}

function render(message) {
  return {
    text: renderBlocks(message, {
      maxLength: MAX_LENGTH,
      header: `${message.icon} *${escapeText(message.title)}*`,
      footer: readFooter(message, (count) => `${SUPPRESSED_ICON} *${escapeText(SUPPRESSED_LABEL)}* ${count}`),
      frame: frameBlock,
      escape: escapeCode,
      measure: measureCode,
    }),
    parse_mode: PARSE_MODE,
    disable_notification: message.isSilent,
    link_preview_options: { is_disabled: true },
  };
}

function hasDescription(description, fragments) {
  const text = String(description ?? '').toLowerCase();

  return fragments.some((fragment) => text.includes(fragment));
}

function classifyRefusal(status, answer) {
  const { description, parameters } = answer ?? {};

  if (TOKEN_REJECTED_STATUSES.includes(status)) {
    return DELIVERY_FAILURE.REJECTED_TOKEN;
  }

  if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
    return DELIVERY_FAILURE.RATE_LIMITED;
  }

  if (status === HTTP_STATUS.BAD_REQUEST && (parameters?.migrate_to_chat_id || hasDescription(description, MIGRATED_DESCRIPTIONS))) {
    return DELIVERY_FAILURE.CHAT_MIGRATED;
  }

  if (status === HTTP_STATUS.FORBIDDEN || (status === HTTP_STATUS.BAD_REQUEST && hasDescription(description, INVALID_CHAT_DESCRIPTIONS))) {
    return DELIVERY_FAILURE.REJECTED_CHAT;
  }

  return status === HTTP_STATUS.BAD_REQUEST && hasDescription(description, REJECTED_TEXT_DESCRIPTIONS)
    ? DELIVERY_FAILURE.REJECTED_TEXT
    : DELIVERY_FAILURE.FAILED;
}

// The new id of a migrated group is never passed on: the id of the group lives in the environment only.
function describeRefusal(status, answer) {
  const reason = classifyRefusal(status, answer);

  return notDelivered(reason, {
    status,
    description: isString(answer?.description)
      ? answer.description
      : undefined,
    retryAfter: reason === DELIVERY_FAILURE.RATE_LIMITED
      ? answer?.parameters?.retry_after
      : undefined,
    hint: HINTS[reason],
  });
}

// A delivery is a 200 with "ok": true. The token rides in the path, so the log names it as "***".
async function send(rendered, { settings, config }) {
  try {
    const { status, text } = await fetchUpstream(`${config.alert.telegramApiUrl}/bot${settings.botToken}/sendMessage`, {
      service: SERVICE,
      method: HTTP_METHOD.POST,
      json: { chat_id: settings.chatId, ...rendered },
      timeout: config.alert.sendTimeout,
      secrets: [settings.botToken],
    });
    const answer = parseJsonObject(text);

    return status === HTTP_STATUS.OK && answer?.ok === true
      ? delivered()
      : describeRefusal(status, answer);
  } catch (error) {
    return describeUnreachable(error, HINTS[DELIVERY_FAILURE.UNREACHABLE]);
  }
}

export const telegramChannel = Object.freeze({
  name: ALERT_CHANNEL.TELEGRAM,
  render,
  send,
});
