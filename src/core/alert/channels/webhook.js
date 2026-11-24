import {
  delivered,
  DELIVERY_FAILURE,
  describeUnreachable,
  notDelivered,
  readRetryAfter,
} from '#core/alert/channels/delivery.js';
import { fetchUpstream, isRedirectStatus, isSuccessStatus } from '#core/http/index.js';
import { ALERT_CHANNEL } from '#enums/alert-channel.js';
import { HTTP_METHOD } from '#enums/http-method.js';
import { HTTP_STATUS } from '#enums/http-status.js';

const SERVICE_PREFIX = 'alert-';

// The body is ours and the same every time: a receiver that refuses it would refuse it again.
const REFUSED_BODY_STATUSES = Object.freeze([HTTP_STATUS.BAD_REQUEST, HTTP_STATUS.PAYLOAD_TOO_LARGE, HTTP_STATUS.UNPROCESSABLE_ENTITY]);
const REFUSED_TOKEN_STATUSES = Object.freeze([HTTP_STATUS.UNAUTHORIZED, HTTP_STATUS.FORBIDDEN]);
const GONE_STATUSES = Object.freeze([HTTP_STATUS.NOT_FOUND, HTTP_STATUS.GONE]);

const ENV_NAMES = Object.freeze({
  [ALERT_CHANNEL.WEBHOOK]: 'APP_ALERT_WEBHOOK_URL',
  [ALERT_CHANNEL.SLACK]: 'APP_ALERT_SLACK_URL',
  [ALERT_CHANNEL.DISCORD]: 'APP_ALERT_DISCORD_URL',
});

function describeHints(envName) {
  return {
    [DELIVERY_FAILURE.UNREACHABLE]: `the address in ${envName} cannot be reached from here: network, DNS or the deadline`,
    [DELIVERY_FAILURE.REJECTED_TOKEN]: `the receiver refused the webhook: the token in ${envName} is revoked or wrong`,
    [DELIVERY_FAILURE.REJECTED_ADDRESS]: `the webhook in ${envName} is gone or moved: it was deleted, the address is wrong, or it redirects and must be the final one`,
    [DELIVERY_FAILURE.REJECTED_TEXT]: 'the receiver refused the body itself, a bug of its render: the same alert would fail again, so its dedupe key is kept',
    [DELIVERY_FAILURE.RATE_LIMITED]: 'the receiver asks to send less often',
    [DELIVERY_FAILURE.FAILED]: 'the receiver failed: it answered with an error of its own',
  };
}

function classifyStatus(status) {
  if (REFUSED_BODY_STATUSES.includes(status)) {
    return DELIVERY_FAILURE.REJECTED_TEXT;
  }

  if (REFUSED_TOKEN_STATUSES.includes(status)) {
    return DELIVERY_FAILURE.REJECTED_TOKEN;
  }

  if (GONE_STATUSES.includes(status) || isRedirectStatus(status)) {
    return DELIVERY_FAILURE.REJECTED_ADDRESS;
  }

  return status === HTTP_STATUS.TOO_MANY_REQUESTS
    ? DELIVERY_FAILURE.RATE_LIMITED
    : DELIVERY_FAILURE.FAILED;
}

// One send for the three channels of a webhook: a POST of JSON, any 2xx is a delivery, and a refusal or a failure
// of the way there is a result, not an exception. The address of a webhook is its secret, in its path (Slack, Discord)
// or its subdomain (Pipedream), and the body of a refusal stays out of the log: a receiver may echo the alert in it.
export async function sendWebhook(body, { channel, settings, config }) {
  const hints = describeHints(ENV_NAMES[channel]);

  try {
    const { status, headers } = await fetchUpstream(settings.url, {
      service: `${SERVICE_PREFIX}${channel}`,
      method: HTTP_METHOD.POST,
      json: body,
      timeout: config.alert.sendTimeout,
      isAddressSecret: true,
    });

    if (isSuccessStatus(status)) {
      return delivered();
    }

    const reason = classifyStatus(status);

    return notDelivered(reason, {
      status,
      retryAfter: readRetryAfter(headers),
      hint: hints[reason],
    });
  } catch (error) {
    return describeUnreachable(error, hints[DELIVERY_FAILURE.UNREACHABLE]);
  }
}

// The structure of the alert as it is: the receiver formats it. The same blocks, in the same order, as every channel.
export const webhookChannel = Object.freeze({
  name: ALERT_CHANNEL.WEBHOOK,
  render(message) {
    return message;
  },
  send(rendered, options) {
    return sendWebhook(rendered, { ...options, channel: ALERT_CHANNEL.WEBHOOK });
  },
});
