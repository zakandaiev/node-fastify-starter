import {
  breakBacktickRuns,
  readFooter,
  renderBlocks,
  SUPPRESSED_ICON,
  SUPPRESSED_LABEL,
} from '#core/alert/channels/markup.js';
import { sendWebhook } from '#core/alert/channels/webhook.js';
import { ALERT_CHANNEL } from '#enums/alert-channel.js';
import { isString } from '#utils/type.js';

// An incoming webhook refuses "content" longer than 2000 characters.
const MAX_LENGTH = 2000;

// The markup of a text outside a code block; a backslash makes each of them a plain character.
const MARKDOWN_REGEXP = /[\\*_~`|>#\-[\]()]/g;
const ESCAPE = '\\$&';

function escapeText(text) {
  return text.replace(MARKDOWN_REGEXP, ESCAPE);
}

function measureCode(text) {
  return breakBacktickRuns(text).length;
}

function frameBlock(block) {
  return isString(block.value)
    ? { before: `**${block.name}:**\n\`\`\`\n`, after: '\n```' }
    : { before: `**${block.name}:**\n\`\`\`json\n`, after: '\n```' };
}

// No mention in the text pings anyone: an error message may well hold "@everyone".
function render(message) {
  return {
    content: renderBlocks(message, {
      maxLength: MAX_LENGTH,
      header: `${message.icon} **${escapeText(message.title)}**`,
      footer: readFooter(message, (count) => `${SUPPRESSED_ICON} **${SUPPRESSED_LABEL}** ${count}`),
      frame: frameBlock,
      escape: breakBacktickRuns,
      measure: measureCode,
    }),
    allowed_mentions: { parse: [] },
  };
}

export const discordChannel = Object.freeze({
  name: ALERT_CHANNEL.DISCORD,
  render,
  send(rendered, options) {
    return sendWebhook(rendered, { ...options, channel: ALERT_CHANNEL.DISCORD });
  },
});
