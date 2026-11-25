import { findEnabledChannels } from '#core/alert/channels/index.js';
import { alert, assertAlertConfig } from '#core/alert/index.js';
import { readErrorCause } from '#core/alert/message.js';
import { findDbError, POOL_SATURATED_CODE } from '#core/db/error.js';
import { classifyError } from '#core/error/classify.js';
import { findUpstreamError } from '#core/http/index.js';
import { DB_ERROR_KIND } from '#enums/db-error-kind.js';
import { ERROR_CATALOG, ERROR_CODE } from '#enums/error-code.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';
import fp from 'fastify-plugin';

const SERVER_ERROR_TITLE = 'Server error (5xx)';
const UPSTREAM_ERROR_TITLE = 'Upstream service failed';
const DATABASE_CONNECTION_TITLE = 'Database connection failed';
const STATEMENT_TIMEOUT_TITLE = 'Database statement timeout';
const POOL_SATURATED_TITLE = 'Database pool saturated';
const CONNECTIONS_REFUSED_TITLE = 'Database refuses connections';

const CHANNELS_MESSAGE = 'Alerts go to their channels';
const NO_CHANNEL_MESSAGE = 'Alerts are off: no channel has its settings (APP_ALERT_*)';
const REPORT_FAILED_MESSAGE = 'The alert of a failed request could not be built';

const UPSTREAM_KEY = 'upstream';
const SERVER_ERROR_KEY = 'server-error';
const DATABASE_CONNECTION_KEY = 'db-connection';
const STATEMENT_TIMEOUT_KEY = 'db-statement-timeout';
const OVERLOAD_KEY = 'db-overload';

const KEY_SEPARATOR = ':';
const NO_ROUTE = '(no route)';

function readRoute(request) {
  return `${request.method} ${request.routeOptions?.url ?? NO_ROUTE}`;
}

// A stopped service fails every route that calls it, and the database is called by them all: one alert for the service
// and the way it failed. The status is a part of it, or a 422 of one route would mute the 503 of the whole service, and
// a lost session is not, or a statement killed on one route would mute an outage of the database.
function describeServerFault(error, request) {
  const upstreamError = findUpstreamError(error);
  const dbError = findDbError(error);

  if (upstreamError) {
    return {
      title: UPSTREAM_ERROR_TITLE,
      dedupeKey: [UPSTREAM_KEY, upstreamError.service, upstreamError.reason, upstreamError.status].join(KEY_SEPARATOR),
      error,
    };
  }

  if (dbError?.isConnectFailure) {
    return {
      title: DATABASE_CONNECTION_TITLE,
      dedupeKey: [DATABASE_CONNECTION_KEY, dbError.code].join(KEY_SEPARATOR),
      error,
    };
  }

  return {
    title: SERVER_ERROR_TITLE,
    dedupeKey: [SERVER_ERROR_KEY, readRoute(request), readErrorCause(error)].join(KEY_SEPARATOR),
    error,
  };
}

// A 503 is no 5xx alert. Of its causes a slow statement, a full pool and a server out of connections are reported, with
// the class "warning": a guest can cause them. A connection that does not open is the same outage as behind a 500, and
// comes last: a server out of connections opens none either.
function describeOverload(error, request) {
  const dbError = findDbError(error);

  if (dbError?.kind === DB_ERROR_KIND.TIMEOUT) {
    return {
      title: STATEMENT_TIMEOUT_TITLE,
      dedupeKey: [STATEMENT_TIMEOUT_KEY, readRoute(request)].join(KEY_SEPARATOR),
      error,
      throttleClass: THROTTLE_CLASS.WARNING,
    };
  }

  if (dbError?.kind === DB_ERROR_KIND.OVERLOAD) {
    return {
      title: dbError.code === POOL_SATURATED_CODE
        ? POOL_SATURATED_TITLE
        : CONNECTIONS_REFUSED_TITLE,
      dedupeKey: [OVERLOAD_KEY, dbError.code].join(KEY_SEPARATOR),
      error: { message: dbError.message, code: dbError.code, pool: request.server.db.getStats() },
      throttleClass: THROTTLE_CLASS.WARNING,
    };
  }

  return dbError?.isConnectFailure
    ? describeServerFault(error, request)
    : null;
}

function describeReport(error, request) {
  const { code } = classifyError(error);

  if (ERROR_CATALOG[code].isAlertable) {
    return describeServerFault(error, request);
  }

  return code === ERROR_CODE.SERVICE_UNAVAILABLE_ERROR
    ? describeOverload(error, request)
    : null;
}

// Not awaited: the reply must not wait for a channel. alert() never rejects, and this never throws, since
// an onError hook that throws is swallowed by Fastify and the hooks after it are skipped.
function reportFailure(request, error) {
  try {
    const report = describeReport(error, request);

    if (report) {
      alert({ ...report, request });
    }
  } catch (err) {
    request.log.error({ err }, REPORT_FAILED_MESSAGE);
  }
}

function logChannels(fastify) {
  const names = findEnabledChannels(fastify.config.alert).map((channel) => channel.name);

  fastify.log.info({ alert: { channels: names } }, names.length
    ? CHANNELS_MESSAGE
    : NO_CHANNEL_MESSAGE);
}

// The hook runs before the error handler and sees the error as it was thrown. A callback hook that gives nothing on:
// a value would replace the error for the hooks after it, and while an async one is pending, a handler that forgot to
// return its answer sends again, which Fastify refuses with a rejection nobody holds.
async function useErrorAlert(fastify) {
  assertAlertConfig(fastify.config.alert);
  logChannels(fastify);

  fastify.addHook('onError', (request, reply, error, done) => {
    reportFailure(request, error);
    done();
  });
}

export default fp(useErrorAlert, { name: 'error-alert' });
