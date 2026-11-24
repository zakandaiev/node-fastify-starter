import {
  breakBacktickRuns,
  readFooter,
  renderBlocks,
  SUPPRESSED_ICON,
  SUPPRESSED_LABEL,
} from '#core/alert/channels/markup.js';
import { sendWebhook } from '#core/alert/channels/webhook.js';
import { ALERT_CHANNEL } from '#enums/alert-channel.js';

// An incoming webhook takes up to 40000 characters in "text" and cuts the rest; past about 4000 a message
// is hard to read, so that is the ceiling.
const MAX_LENGTH = 4000;

// The only escaping mrkdwn has: these three would open a link, a mention or an entity.
const ENTITIES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;' });
const ENTITY_REGEXP = /[&<>]/g;

function escapeText(text) {
  return text.replace(ENTITY_REGEXP, (character) => ENTITIES[character]);
}

function escapeCode(text) {
  return breakBacktickRuns(escapeText(text));
}

function measureCode(text) {
  return escapeCode(text).length;
}

function frameBlock(block) {
  return { before: `*${block.name}:*\n\`\`\`\n`, after: '\n```' };
}

function render(message) {
  return {
    text: renderBlocks(message, {
      maxLength: MAX_LENGTH,
      header: `${message.icon} *${escapeText(message.title)}*`,
      footer: readFooter(message, (count) => `${SUPPRESSED_ICON} *${SUPPRESSED_LABEL}* ${count}`),
      frame: frameBlock,
      escape: escapeCode,
      measure: measureCode,
    }),
  };
}

export const slackChannel = Object.freeze({
  name: ALERT_CHANNEL.SLACK,
  render,
  send(rendered, options) {
    return sendWebhook(rendered, { ...options, channel: ALERT_CHANNEL.SLACK });
  },
});
