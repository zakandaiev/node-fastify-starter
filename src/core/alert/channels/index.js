import { discordChannel } from '#core/alert/channels/discord.js';
import { slackChannel } from '#core/alert/channels/slack.js';
import { telegramChannel } from '#core/alert/channels/telegram.js';
import { webhookChannel } from '#core/alert/channels/webhook.js';

// A channel is a record of its own render(message), under the format of its receiver, and send(rendered, options).
// Another receiver is one more record here and its settings in config/alert.js.
export const ALERT_CHANNELS = Object.freeze([
  telegramChannel,
  webhookChannel,
  slackChannel,
  discordChannel,
]);

export function findEnabledChannels(alertConfig) {
  return ALERT_CHANNELS.filter((channel) => Boolean(alertConfig.channels[channel.name]));
}
