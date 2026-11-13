import { isCi } from '#config/env.js';
import { createTestEnv } from '#root/tests/helper/config.js';
import { once } from 'node:events';
import net from 'node:net';

const CONNECT_TIMEOUT_MS = 1000;

const SERVICE_ENV_KEYS = Object.freeze({
  mariadb: { host: 'APP_DATABASE_HOST', port: 'APP_DATABASE_PORT' },
  redis: { host: 'APP_REDIS_HOST', port: 'APP_REDIS_PORT' },
});

function openSocket({ host, port }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });

    function fail() {
      socket.destroy();
      resolve(null);
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('timeout', fail);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

export async function isPortOpen(address) {
  const socket = await openSocket(address);

  socket?.destroy();

  return Boolean(socket);
}

export async function readGreeting(address, command = '') {
  const socket = await openSocket(address);

  if (!socket) {
    return '';
  }

  try {
    socket.write(command);

    const [chunk] = await once(socket, 'data', { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });

    return chunk.toString('latin1');
  } finally {
    socket.destroy();
  }
}

export function getServiceAddress(name, env = createTestEnv()) {
  const keys = SERVICE_ENV_KEYS[name];

  if (!keys) {
    throw new Error(`Unknown service "${name}": expected one of ${Object.keys(SERVICE_ENV_KEYS).join(', ')}`);
  }

  return { host: env[keys.host], port: env[keys.port] };
}

export async function findUnavailableServices(names, env = createTestEnv()) {
  const states = await Promise.all(names.map((name) => isPortOpen(getServiceAddress(name, env))));

  return names.filter((name, index) => !states[index]);
}

// The value for the "skip" option of node:test: false runs the tests, a string skips them with that message.
export async function getServiceSkip(names, { isRequired = isCi(), env } = {}) {
  const unavailable = await findUnavailableServices(names, env);

  if (!unavailable.length) {
    return false;
  }

  const reason = `${unavailable.join(', ')} not reachable: start the local services with "wdt start"`;

  if (isRequired) {
    throw new Error(`Integration tests must not be skipped here, but ${reason}`);
  }

  return reason;
}
