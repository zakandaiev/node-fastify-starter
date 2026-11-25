import { findContext, runInContext, runOutsideContext } from '#core/context/index.js';
import { assertDurations, convertStringToMs } from '#utils/date.js';
import {
  isArray,
  isFunction,
  isNonEmptyString,
  isObject,
  isPositiveInteger,
} from '#utils/type.js';
import { takeWindowSlot } from '#utils/window.js';
import { Pipeline, Redis } from 'ioredis';

const READY_STATUS = 'ready';

const EVENT = Object.freeze({
  READY: 'ready',
  ERROR: 'error',
  CLOSE: 'close',
  MESSAGE: 'message',
});

const SUBSCRIBE = 'subscribe';
const UNSUBSCRIBE = 'unsubscribe';

// disconnect() is only called on a connection that is down or failed to quit: there is nothing to wait for,
// and the timer ioredis arms for it would hold the process for that long.
const DISCONNECT_TIMEOUT_MS = 0;

const MAINT_NOTIFICATIONS_OFF = 'disabled';

const SUBSCRIBER_SUFFIX = ' subscriber';
const ERROR_KIND_SEPARATOR = ' ';
const FAILURE_KEY_SEPARATOR = '\n';

const DURATION_KEYS = Object.freeze([
  'connectTimeout',
  'commandTimeout',
  'socketTimeout',
  'reconnectStep',
  'reconnectMaxDelay',
  'loadingRetryMaxDelay',
  'failureLogWindow',
]);

export const REDIS_FAILURE = Symbol('redis failure');

// The state of every client createRedis() made, out of reach of its callers.
const states = new WeakMap();

function assertConfig(config) {
  if (!isObject(config)) {
    throw new TypeError('createRedis(config, options) requires the redis section of createConfig()');
  }

  if (!isNonEmptyString(config.host) || !isPositiveInteger(config.port)) {
    throw new TypeError('config.redis requires a host and a port');
  }

  if (!isNonEmptyString(config.keyPrefix)) {
    throw new TypeError('config.redis requires a keyPrefix: keys without one would mix with those of every other app on the server');
  }

  assertDurations(config, DURATION_KEYS, 'config.redis');

  // A command must fail by its own deadline first: the socket torn down earlier would answer it with a reset instead.
  if (convertStringToMs(config.socketTimeout) < convertStringToMs(config.commandTimeout)) {
    throw new TypeError('config.redis requires socketTimeout to be at least commandTimeout');
  }
}

function assertOptions(options) {
  if (!isObject(options) || !isFunction(options.log?.warn) || !isNonEmptyString(options.label)) {
    throw new TypeError('createRedis(config, { log, label }) requires a logger and a label');
  }
}

// The contract: a command never waits for a connection (no offline queue) and never outlives commandTimeout, which the
// maintenance notifications of a managed Redis would stretch to 10 s; a command its caller saw fail is not sent again
// after a reconnect (it may have run already, or behind the caller's back); a silent connection ends at socketTimeout.
function toClientOptions(config) {
  const stepMs = convertStringToMs(config.reconnectStep);
  const maxDelayMs = convertStringToMs(config.reconnectMaxDelay);

  return {
    host: config.host,
    port: config.port,
    username: config.username ?? undefined,
    password: config.password ?? undefined,
    keyPrefix: config.keyPrefix,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    autoResendUnfulfilledCommands: false,
    maintNotifications: MAINT_NOTIFICATIONS_OFF,
    connectTimeout: convertStringToMs(config.connectTimeout),
    commandTimeout: convertStringToMs(config.commandTimeout),
    socketTimeout: convertStringToMs(config.socketTimeout),
    maxLoadingRetryTime: convertStringToMs(config.loadingRetryMaxDelay),
    disconnectTimeout: DISCONNECT_TIMEOUT_MS,
    retryStrategy: (attempt) => Math.min(attempt * stepMs, maxDelayMs),
  };
}

// A reply error carries the arguments of its command: the password of HELLO ... AUTH, the value of a SET. The log gets a
// copy with the name of the command only, also for the errors of a transaction it holds.
function toLoggableError(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  const copy = Object.create(Object.getPrototypeOf(error));

  Object.getOwnPropertyNames(error).forEach((name) => {
    copy[name] = error[name];
  });

  if (isObject(error.command)) {
    copy.command = { name: error.command.name };
  }

  if (isArray(error.previousErrors)) {
    copy.previousErrors = error.previousErrors.map((previous) => toLoggableError(previous));
  }

  return copy;
}

function findLog(state) {
  return findContext()?.log ?? state.log;
}

function createTrack() {
  return { downSince: null, isReported: false, hasBeenReady: false };
}

// A command of a request arms the socket timeout of ioredis in the context of that request, and the error of the
// socket the timeout tears down is emitted there: what the wrapper does on an event of a client runs outside any context.
function outsideContext(fn) {
  return (...args) => runOutsideContext(() => fn(...args));
}

// One that throws must not reach the event emitter, nor stop the others.
function notify(state, name, value) {
  state.listeners.forEach((listener) => {
    try {
      runOutsideContext(() => listener[name](value));
    } catch (err) {
      state.log.error({ err, redis: { address: state.address } }, `A listener of the ${state.label} state failed`);
    }
  });

  return true;
}

function goDown(state, track, isMain) {
  if (track.downSince !== null) {
    return false;
  }

  track.downSince = performance.now();

  if (isMain) {
    notify(state, 'onDown', track.downSince);
  }

  return true;
}

function goUp(state, track, isMain) {
  if (track.downSince === null) {
    return null;
  }

  const downMs = Math.round(performance.now() - track.downSince);

  track.downSince = null;

  if (isMain) {
    notify(state, 'onUp', downMs);
  }

  return downMs;
}

// One warning when a connection goes down and one line when it is back: ioredis reports every failed reconnect,
// every few seconds for as long as Redis is away.
function watchConnection(state, client, track, { label, isMain }) {
  function onFailure(err) {
    if (state.isClosed) {
      return false;
    }

    goDown(state, track, isMain);

    const fields = { err: toLoggableError(err), redis: { address: state.address } };

    if (track.isReported) {
      state.log.debug(fields, `${label} is still not reachable`);

      return false;
    }

    track.isReported = true;
    state.log.warn(fields, track.hasBeenReady
      ? `${label} connection is lost`
      : `${label} is not reachable`);

    return true;
  }

  function onReady() {
    const downMs = goUp(state, track, isMain);

    state.log.info({ redis: { address: state.address, downMs } }, track.isReported
      ? `${label} is back`
      : `${label} is ready`);
    track.isReported = false;
    track.hasBeenReady = true;

    return true;
  }

  client.on(EVENT.ERROR, outsideContext(onFailure));
  client.on(EVENT.CLOSE, outsideContext(() => onFailure(undefined)));
  client.on(EVENT.READY, outsideContext(onReady));
}

// Rejections are reported by the error listener, and ioredis goes on reconnecting by its retry strategy.
async function startConnecting(client) {
  try {
    await client.connect();
  } catch {
    return false;
  }

  return true;
}

// Outside any context: the sockets of the client keep the context they are opened in for good.
function startOutsideContext(client) {
  return runOutsideContext(() => startConnecting(client));
}

// The entrypoint starts the connections, never a plugin: the app is built without Redis, and a command
// issued earlier is refused without starting anything. Until it is ready, the client counts as down.
function connect(state) {
  if (state.isClosed || state.isStarted) {
    return false;
  }

  state.isStarted = true;
  goDown(state, state.track, true);
  startOutsideContext(state.client);

  if (state.subscriber) {
    startOutsideContext(state.subscriber.client);
  }

  return true;
}

function isReady(state) {
  return !state.isClosed && state.client.status === READY_STATUS;
}

// For a process that has work to do with Redis at once, such as a job: resolves true when the client is ready
// and false at the deadline or on close(), never rejects. Failed attempts on the way do not end the wait.
function whenReady(state, { timeout } = {}) {
  const timeoutMs = timeout === undefined
    ? state.connectTimeoutMs
    : convertStringToMs(timeout);

  if (isReady(state) || state.isClosed) {
    return Promise.resolve(isReady(state));
  }

  return new Promise((resolve) => {
    function finish() {
      clearTimeout(timer);
      state.client.off(EVENT.READY, finish);
      state.waiters.delete(finish);
      resolve(isReady(state));
    }

    const timer = setTimeout(finish, timeoutMs);

    state.waiters.add(finish);
    state.client.on(EVENT.READY, finish);
  });
}

// A listener of the main connection: onDown(downSince) when it stops being ready (also when it is told to connect,
// since it is not ready yet), onUp(downMs) when it is ready again. One that is down when it starts to listen
// hears onDown at once. Returns the function that stops listening.
function watchState(state, listener) {
  if (!isFunction(listener?.onDown) || !isFunction(listener?.onUp)) {
    throw new TypeError('watchState({ onDown, onUp }) requires two functions');
  }

  const entry = { onDown: listener.onDown, onUp: listener.onUp };

  state.listeners.add(entry);

  if (state.track.downSince !== null) {
    runOutsideContext(() => entry.onDown(state.track.downSince));
  }

  return () => state.listeners.delete(entry);
}

// A client that is up says goodbye with QUIT, bounded by commandTimeout; any other is cut at once.
async function closeClient(client) {
  if (client.status === READY_STATUS) {
    try {
      await client.quit();

      return true;
    } catch {
      client.disconnect();

      return false;
    }
  }

  client.disconnect();

  return false;
}

async function close(state) {
  if (state.closing) {
    await state.closing;

    return false;
  }

  state.isClosed = true;
  state.listeners.clear();
  [...state.waiters].forEach((finish) => finish());
  state.closing = Promise.all([
    closeClient(state.client),
    state.subscriber && closeClient(state.subscriber.client),
  ]);
  await state.closing;

  return true;
}

// A handler that throws or rejects must not reach the event emitter: there it would end the process.
// It runs in the context its subscribe() was called in, when there was one.
async function deliver(state, entry, message, channel) {
  try {
    await (entry.context
      ? runInContext(entry.context, () => entry.handler(message))
      : runOutsideContext(() => entry.handler(message)));
  } catch (err) {
    state.log.error({ err, redis: { address: state.address, channel } }, `A ${state.label} message handler failed`);
  }
}

function dispatch(state, channel, message) {
  const entries = state.subscriber.channels.get(channel);

  if (!entries) {
    return false;
  }

  [...entries].forEach((entry) => deliver(state, entry, message, channel));

  return true;
}

async function sendSubscription(state, command, channels) {
  const { client } = state.subscriber;

  if (client.status !== READY_STATUS || !channels.length) {
    return false;
  }

  try {
    await client[command](...channels);
  } catch (err) {
    state.log.error({ err: toLoggableError(err), redis: { address: state.address } }, `${state.label}${SUBSCRIBER_SUFFIX} could not ${command}`);

    return false;
  }

  return true;
}

// ioredis subscribes again only to what it saw subscribed: a channel added while the connection was down
// would be lost, so every "ready" sends all of them.
function openSubscriber(state) {
  const client = new Redis({ ...state.clientOptions, autoResubscribe: false });
  const subscriber = { client, channels: new Map(), track: createTrack() };

  state.subscriber = subscriber;
  watchConnection(state, client, subscriber.track, { label: `${state.label}${SUBSCRIBER_SUFFIX}`, isMain: false });
  client.on(EVENT.READY, outsideContext(() => sendSubscription(state, SUBSCRIBE, [...subscriber.channels.keys()])));
  client.on(EVENT.MESSAGE, outsideContext((channel, message) => dispatch(state, channel, message)));

  if (state.isStarted) {
    startOutsideContext(client);
  }

  return subscriber;
}

// Channels are not keys: ioredis puts no prefix on them, so the wrapper does.
function toChannel(state, channel) {
  if (!isNonEmptyString(channel)) {
    throw new TypeError('A channel of Redis pub/sub must be a non-empty string');
  }

  return `${state.keyPrefix}${channel}`;
}

function unsubscribe(state, channel, entry) {
  const entries = state.subscriber.channels.get(channel);

  if (!entries?.delete(entry)) {
    return false;
  }

  if (!entries.size) {
    state.subscriber.channels.delete(channel);
    sendSubscription(state, UNSUBSCRIBE, [channel]);
  }

  return true;
}

// Messages come on a connection of their own, opened on the first subscription: a subscribed connection waits
// for messages, not for answers, and its reconnects must not touch the commands of the app.
function subscribe(state, channel, handler) {
  if (state.isClosed) {
    throw new Error(`${state.label} is closed: subscribe() after close()`);
  }

  if (!isFunction(handler)) {
    throw new TypeError('subscribe(channel, handler) requires a function');
  }

  const fullChannel = toChannel(state, channel);
  const { channels } = state.subscriber ?? openSubscriber(state);
  const entries = channels.get(fullChannel) ?? new Set();
  const entry = { handler, context: findContext() };
  const isNew = !channels.has(fullChannel);

  entries.add(entry);
  channels.set(fullChannel, entries);

  if (isNew) {
    sendSubscription(state, SUBSCRIBE, [fullChannel]);
  }

  return () => unsubscribe(state, fullChannel, entry);
}

export function createRedis(config, options) {
  assertConfig(config);
  assertOptions(options);

  const clientOptions = toClientOptions(config);
  const state = {
    log: options.log,
    label: options.label,
    address: `${config.host}:${config.port}`,
    keyPrefix: config.keyPrefix,
    clientOptions,
    connectTimeoutMs: clientOptions.connectTimeout,
    failureLogWindowMs: convertStringToMs(config.failureLogWindow),
    client: new Redis(clientOptions),
    subscriber: null,
    track: createTrack(),
    listeners: new Set(),
    waiters: new Set(),
    failures: new Map(),
    isStarted: false,
    isUnstartedReported: false,
    isClosed: false,
    closing: null,
  };

  watchConnection(state, state.client, state.track, { label: state.label, isMain: true });

  const redis = Object.freeze({
    label: state.label,
    address: state.address,
    keyPrefix: state.keyPrefix,
    log: state.log,
    // A command sent straight to the client is not guarded: to a client that was never started it starts
    // the connection, to one that is down it fails. Commands of the app go through runRedisSafely().
    client: state.client,
    connect: connect.bind(null, state),
    isStarted: () => state.isStarted,
    isReady: isReady.bind(null, state),
    whenReady: whenReady.bind(null, state),
    watchState: watchState.bind(null, state),
    subscribe: subscribe.bind(null, state),
    toChannel: toChannel.bind(null, state),
    close: close.bind(null, state),
  });

  states.set(redis, state);

  return redis;
}

// pipeline.exec() resolves also when commands fail: their errors stand in the tuples of the result.
async function execPipeline(pipeline) {
  const results = await pipeline.exec();

  if (results === null) {
    return null;
  }

  const failed = results.find(([error]) => error);

  if (failed) {
    throw failed[0];
  }

  return results.map(([, value]) => value);
}

function readErrorKind(error) {
  return isNonEmptyString(error?.code)
    ? error.code
    : String(error?.message ?? error).split(ERROR_KIND_SEPARATOR)[0];
}

// A Redis that is up and refuses commands (MISCONF, OOM, READONLY) would log every one of them: one line for each
// message and kind of failure in a window, and the count of the rest goes into the next line.
function reportFailure(state, error, message) {
  const key = `${message}${FAILURE_KEY_SEPARATOR}${readErrorKind(error)}`;
  const slot = takeWindowSlot(state.failures, key, { windowMs: state.failureLogWindowMs, now: performance.now() });

  if (!slot.isAllowed) {
    return false;
  }

  findLog(state).error({
    err: toLoggableError(error),
    redis: { address: state.address, suppressedCount: slot.suppressedCount },
  }, message);

  return true;
}

function reportUnstarted(state) {
  if (state.isUnstartedReported) {
    return false;
  }

  state.isUnstartedReported = true;
  findLog(state).error({ redis: { address: state.address } }, `${state.label} was never told to connect: nothing reaches it, call connect() in the entrypoint`);

  return true;
}

// A client that is not ready is not asked: a command would start one that was never started. Ready is not enough
// either, since a failed command leaves the status as it was. An action that builds a pipeline returns it
// unexecuted: exec() resolves with the errors of its commands inside the tuples of the result.
export async function runRedisSafely(action, message, { redis = findContext()?.redis ?? null } = {}) {
  if (!isFunction(action) || !isNonEmptyString(message)) {
    throw new TypeError('runRedisSafely(action, message, options) requires an action and a message for the log');
  }

  const state = redis === null
    ? null
    : states.get(redis);

  if (redis !== null && !state) {
    throw new TypeError('runRedisSafely(action, message, { redis }) requires a client of createRedis() or null');
  }

  if (!state || !isReady(state)) {
    if (state && !state.isStarted) {
      reportUnstarted(state);
    }

    return REDIS_FAILURE;
  }

  try {
    const result = await action(state.client);

    return result instanceof Pipeline
      ? await execPipeline(result)
      : result;
  } catch (err) {
    reportFailure(state, err, message);

    return REDIS_FAILURE;
  }
}

export async function publish(channel, message, { redis = findContext()?.redis ?? null } = {}) {
  if (redis === null) {
    return REDIS_FAILURE;
  }

  const fullChannel = redis.toChannel(channel);

  return runRedisSafely((client) => client.publish(fullChannel, message), `${redis.label} publish failed`, { redis });
}
