import { DELIVERY_FAILURE, notDelivered } from '#core/alert/channels/delivery.js';
import { findEnabledChannels } from '#core/alert/channels/index.js';
import { buildAlertMessage } from '#core/alert/message.js';
import {
  addSuppressed,
  claimDedupe,
  isDeduped as hasDedupeMark,
  releaseDedupe,
  takeThrottleSlot,
} from '#core/alert/state.js';
import { findContext } from '#core/context/index.js';
import { ALERT_SPACE } from '#enums/alert-space.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import { assertDurations, convertStringToMs } from '#utils/date.js';
import {
  isBoolean,
  isNonEmptyString,
  isObject,
  isPositiveInteger,
  isString,
} from '#utils/type.js';
import { setImmediate as nextTurn } from 'node:timers/promises';

const SIGNATURE = 'alert({ title, dedupeKey, error, throttleClass, isSilent, isDetached, request, client, url, space })';

const SENT_MESSAGE = 'Alert sent';
const HELD_MESSAGE = 'Alert held back';
const NOT_DELIVERED_MESSAGE = 'Alert not delivered';
const CHANNEL_FAILED_MESSAGE = 'An alert channel failed';
const FAILED_MESSAGE = 'Alert failed';

const WINDOW_SEPARATOR = ':';

const DURATION_KEYS = Object.freeze(['dedupeTtl', 'throttleWindow', 'suppressedTtl', 'sendTimeout']);

// What is still to be done for the alerts, by the Redis that keeps their state.
const PENDING_WORK = new WeakMap();

function createResult({ isDeduped = false, isThrottled = false, channels = {} } = {}) {
  return { isDeduped, isThrottled, channels };
}

function detach(result, delivery = Promise.resolve(result)) {
  return { ...result, delivery };
}

function assertChoice(value, choices, name) {
  if (value !== undefined && !Object.values(choices).includes(value)) {
    throw new TypeError(`${SIGNATURE} requires ${name} to be one of ${Object.values(choices).join(', ')}`);
  }
}

function assertOptions(options) {
  if (!isObject(options) || !isNonEmptyString(options.title) || !isNonEmptyString(options.dedupeKey)) {
    throw new TypeError(`${SIGNATURE} requires a title and a dedupeKey: the place and the cause, stable across repeats`);
  }

  assertChoice(options.throttleClass, THROTTLE_CLASS, 'throttleClass');
  assertChoice(options.space, ALERT_SPACE, 'space');

  if (![options.isSilent, options.isDetached].every((flag) => flag === undefined || isBoolean(flag))) {
    throw new TypeError(`${SIGNATURE} requires isSilent and isDetached to be booleans`);
  }

  if (options.request !== undefined && (options.request === null || typeof options.request !== 'object')) {
    throw new TypeError(`${SIGNATURE} requires request to be the request of Fastify`);
  }

  if (options.url !== undefined && options.url !== null && !isString(options.url)) {
    throw new TypeError(`${SIGNATURE} requires url to be a string, or null for an alert about no address`);
  }
}

// A silent alert has a window of its own, so the weekly canary never takes the slot of a real failure.
// The public space is anyone's: it never decides to be silent.
function readOptions(options) {
  assertOptions(options);

  const space = options.space ?? ALERT_SPACE.INTERNAL;
  const isPublic = space === ALERT_SPACE.PUBLIC;
  const defaultClass = options.isSilent && !isPublic
    ? THROTTLE_CLASS.SILENT
    : THROTTLE_CLASS.FAILURE;
  const throttleClass = options.throttleClass ?? defaultClass;
  const isSilent = !isPublic && (options.isSilent ?? (throttleClass === THROTTLE_CLASS.SILENT));

  return {
    ...options,
    space,
    throttleClass,
    isSilent,
  };
}

// Read apart from the other options and under a guard: the answer to a wrong call keeps its shape.
function isDetachedCall(options) {
  try {
    return options?.isDetached === true;
  } catch {
    return false;
  }
}

function readStateOptions(context, input) {
  const { alert: alertConfig } = context.config;

  return {
    redis: context.redis ?? null,
    space: input.space,
    dedupeKey: input.dedupeKey,
    window: `${input.space}${WINDOW_SEPARATOR}${input.throttleClass}`,
    ttlMs: convertStringToMs(alertConfig.dedupeTtl),
    windowMs: convertStringToMs(alertConfig.throttleWindow),
    suppressedTtlMs: convertStringToMs(alertConfig.suppressedTtl),
    maxEntries: alertConfig.memoryMaxEntries,
  };
}

// A channel that throws is a bug of that channel: it must not take the others down with it.
async function sendToChannel(channel, message, context) {
  try {
    return await channel.send(channel.render(message), {
      settings: context.config.alert.channels[channel.name],
      config: context.config,
    });
  } catch (err) {
    context.log.error({ err, alert: { channel: channel.name } }, CHANNEL_FAILED_MESSAGE);

    return notDelivered(DELIVERY_FAILURE.FAILED);
  }
}

// Neither the text of the alert nor its dedupe key goes to the log: they carry what a request held, an IP among it.
// No field of the line names a key: the logger hides the value of any key whose name holds one.
function logOutcomes(context, input, { names, outcomes, isMarkReleased }) {
  outcomes
    .map((outcome, index) => ({ outcome, channel: names[index] }))
    .filter(({ outcome }) => !outcome.isDelivered)
    .forEach(({ outcome, channel }) => context.log.error({
      alert: {
        channel,
        space: input.space,
        title: input.title,
        reason: outcome.reason,
        status: outcome.status,
        description: outcome.description,
        retryAfter: outcome.retryAfter,
        hint: outcome.hint,
        isMarkReleased,
      },
    }, NOT_DELIVERED_MESSAGE));
}

function toChannelResults(names, outcomes) {
  return Object.fromEntries(names.map((name, index) => [name, outcomes[index].isDelivered
    ? { isDelivered: true }
    : { isDelivered: false, reason: outcomes[index].reason }]));
}

// Nothing reached a channel: the mark goes when another try may pass, and the count goes back to its window.
// A report of the public space keeps its mark: its repeat must not tell a page whether the channels work.
async function settleUndelivered(state, outcomes, suppressedCount) {
  const isReleasable = state.space !== ALERT_SPACE.PUBLIC && outcomes.some((outcome) => outcome.isRetryable);
  const isMarkReleased = isReleasable
    ? await releaseDedupe(state)
    : false;

  await addSuppressed({ ...state, count: suppressedCount });

  return isMarkReleased;
}

async function send(context, input, message, { state, channels, suppressedCount }) {
  const names = channels.map((channel) => channel.name);
  const outcomes = await Promise.all(channels.map((channel) => sendToChannel(channel, { ...message, suppressedCount }, context)));
  const isDelivered = outcomes.some((outcome) => outcome.isDelivered);
  const isMarkReleased = isDelivered
    ? false
    : await settleUndelivered(state, outcomes, suppressedCount);

  logOutcomes(context, input, { names, outcomes, isMarkReleased });

  if (isDelivered) {
    context.log.info({
      alert: {
        space: input.space,
        title: input.title,
        channels: names.filter((name, index) => outcomes[index].isDelivered),
        suppressedCount,
      },
    }, SENT_MESSAGE);
  }

  return createResult({ channels: toChannelResults(names, outcomes) });
}

function holdBack(context, input, result) {
  context.log.debug({ alert: { space: input.space, title: input.title, ...result } }, HELD_MESSAGE);

  return { result: createResult(result) };
}

// Dedupe, then throttle, then the mark, all before any channel is asked. A throttled alert sets no mark, so its
// next repeat after the window may go; the mark is taken last, so of two equal alerts at the same moment one goes.
// With no channel on, only a public report takes these steps: its flags must not tell whether one is.
async function prepare(context, input) {
  const channels = findEnabledChannels(context.config.alert);

  if (!channels.length && input.space !== ALERT_SPACE.PUBLIC) {
    return { result: createResult() };
  }

  const message = buildAlertMessage(input, context.config.app);
  const state = readStateOptions(context, input);

  if (await hasDedupeMark(state)) {
    return holdBack(context, input, { isDeduped: true });
  }

  const slot = await takeThrottleSlot(state);

  if (!slot.isAllowed) {
    return holdBack(context, input, { isThrottled: true });
  }

  const isClaimed = await claimDedupe(state);

  if (!isClaimed) {
    await addSuppressed({ ...state, count: slot.suppressedCount });

    return holdBack(context, input, { isDeduped: true });
  }

  if (!channels.length) {
    return { result: createResult() };
  }

  return {
    result: createResult(),
    send: () => send(context, input, message, { state, channels, suppressedCount: slot.suppressedCount }),
  };
}

function logFailure(context, err) {
  try {
    context.log.error({ err }, FAILED_MESSAGE);
  } catch {
    // The logger is what failed: there is nothing left to report with.
  }

  return true;
}

async function sendQuietly(context, sendPrepared) {
  try {
    return await sendPrepared();
  } catch (err) {
    logFailure(context, err);

    return createResult();
  }
}

function readPendingWork(redis) {
  if (!PENDING_WORK.has(redis)) {
    PENDING_WORK.set(redis, new Set());
  }

  return PENDING_WORK.get(redis);
}

// Nobody awaits it, so a rejection of the work must not become one of its own: allSettled() takes it.
async function forgetSettled(pending, work) {
  await Promise.allSettled([work]);
  pending.delete(work);

  return true;
}

function track(context, work) {
  if (context.redis) {
    const pending = readPendingWork(context.redis);

    pending.add(work);
    forgetSettled(pending, work);
  }

  return work;
}

// The delivery is tracked before the steps that led to it are forgotten: at no moment does the alert look settled.
async function run(context, input) {
  const prepared = await track(context, prepare(context, input));

  if (!prepared.send) {
    return input.isDetached
      ? detach(prepared.result)
      : prepared.result;
  }

  const delivery = track(context, sendQuietly(context, prepared.send));

  return input.isDetached
    ? detach(prepared.result, delivery)
    : delivery;
}

// Never throws and never rejects: error handlers and hooks nobody awaits call it, and a wrong call is only logged.
// isDetached does not wait for the channels, for a public route, whose answer time would tell whether they hang,
// and for a process that shuts down; "delivery" resolves with what the channels did.
export async function alert(options) {
  const context = findContext();
  const isDetached = isDetachedCall(options);

  if (!context) {
    return isDetached
      ? detach(createResult())
      : createResult();
  }

  try {
    return await run(context, readOptions(options));
  } catch (err) {
    logFailure(context, err);

    return isDetached
      ? detach(createResult())
      : createResult();
  }
}

// What a caller that tries again needs, such as the watchdog of the cache: false when the alert was held back
// or reached none of the channels it tried; with no channel on, there is no one to try again for.
export function isAlertReported(result) {
  const outcomes = Object.values(result?.channels ?? {});

  if (result?.isDeduped || result?.isThrottled) {
    return false;
  }

  return !outcomes.length || outcomes.some((outcome) => outcome.isDelivered);
}

// For the plugin that closes Redis: the steps of an alert decide there whether it goes, and a failed delivery gives
// its mark back, or the same failure after a restart would be muted for dedupeTtl. An alert may start meanwhile, also
// as the next step of a caller that awaited one of these: it goes on before the set is read again.
export async function settleAlerts(redis) {
  const pending = PENDING_WORK.get(redis);

  if (!pending?.size) {
    return true;
  }

  await Promise.allSettled(pending);
  await nextTurn();

  return settleAlerts(redis);
}

// For the plugin that starts the alerts: a duration nobody can read would show itself only once an alert is due.
export function assertAlertConfig(alertConfig) {
  assertDurations(alertConfig, DURATION_KEYS, 'config.alert');

  if (!isPositiveInteger(alertConfig.memoryMaxEntries)) {
    throw new TypeError('config.alert requires memoryMaxEntries to be a positive integer');
  }

  return true;
}
